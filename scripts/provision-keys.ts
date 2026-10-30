// Mint one Langfuse API key per project, straight into Langfuse's Postgres, and
// record them in the keys file the MCP server reads. A dry run unless --apply.
//
//   LANGFUSE_HOST=https://langfuse.example.com \
//   LANGFUSE_DB_URL=postgres://langfuse:…@localhost:15432/langfuse \
//   LANGFUSE_SALT=… \
//   pnpm provision [--apply] [--only a,b] [--exclude a,b]
//
// LANGFUSE_SALT must be the SALT the *running* Langfuse uses — read it from the
// deployment, not from a local copy of the secrets, which can be stale. A wrong
// salt or the wrong database still inserts a row; the key just never
// authenticates, which is why every key is checked against the API before it
// is kept, and deleted again if it fails. See src/provision/keys.ts for the
// storage scheme this reproduces.
//
// The only row it ever deletes besides its own failed mint is a recorded key
// that no longer authenticates, after its replacement has been verified and
// saved. Projects are never created or deleted.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import pg from "pg";

import { basicAuthHeader } from "#/client/auth";
import { resolveKeysFilePath } from "#/config";
import {
  KEY_NOTE,
  displaySecretKey,
  fastHash,
  generateKeyPair,
  generateRowId,
  planActions,
  slowHash,
  writeKeysFile,
  type Action,
  type DbProject,
  type KeyCheck,
  type KeyPair,
  type KeysFile,
} from "#/provision/keys";

const TIMEOUT_MS = 15_000;

const fail = (message: string, code = 1): never => {
  console.error(`error: ${message}`);
  process.exit(code);
};

const { values: flags } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    only: { type: "string" },
    exclude: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (flags.help) {
  console.log("usage: pnpm provision [--apply] [--only name,id,…] [--exclude name,id,…]");
  console.log(
    "env:   LANGFUSE_HOST (or LANGFUSE_BASE_URL), LANGFUSE_DB_URL, LANGFUSE_SALT, [LANGFUSE_KEYS_FILE]",
  );
  process.exit(0);
}
const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const host = (
  process.env.LANGFUSE_HOST?.trim() ||
  process.env.LANGFUSE_BASE_URL?.trim() ||
  ""
).replace(/\/+$/, "");
const dbUrl = process.env.LANGFUSE_DB_URL?.trim();
const salt = process.env.LANGFUSE_SALT?.trim();
const keysPath = resolveKeysFilePath(process.env);
if (!host) fail("LANGFUSE_HOST is required: the instance the keys are verified against.", 2);
if (!dbUrl)
  fail("LANGFUSE_DB_URL is required: Langfuse's own Postgres, e.g. through a port-forward.", 2);
if (!salt) fail("LANGFUSE_SALT is required: the SALT env of the running langfuse-web.", 2);

/** Does this pair authenticate, and which project does it read? */
const checkKey = async (pair: KeyPair): Promise<KeyCheck> => {
  try {
    const res = await fetch(`${host}/api/public/projects`, {
      headers: { Authorization: basicAuthHeader(pair.publicKey, pair.secretKey) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { status: "dead" };
    if (!res.ok)
      return { status: "error", message: `HTTP ${res.status} from ${host}/api/public/projects` };
    const body = (await res.json()) as { data?: { id: string }[] };
    const id = body.data?.[0]?.id;
    return id
      ? { status: "live", projectId: id }
      : { status: "error", message: "key resolved to no project" };
  } catch (err) {
    return { status: "error", message: `${host} unreachable: ${(err as Error).message}` };
  }
};

const readKeysFile = (): KeysFile => {
  try {
    return JSON.parse(readFileSync(keysPath, "utf8")) as KeysFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    return fail(`could not read ${keysPath}: ${(err as Error).message}`);
  }
};

const describeDb = (url: string): string => {
  const u = new URL(url);
  return `${decodeURIComponent(u.username)}@${u.host}${u.pathname}`;
};

const main = async (): Promise<void> => {
  const db = new pg.Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  });
  await db
    .connect()
    .catch((err: unknown) =>
      fail(`could not connect to ${describeDb(dbUrl!)}: ${(err as Error).message}`),
    );

  try {
    // Probe the schema rather than assume it: these are Langfuse's internal
    // tables, and a column that moved should stop the run, not corrupt a row.
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('api_keys', 'projects', 'organizations')`,
    );
    const has = (table: string, column: string): boolean =>
      cols.rows.some((r) => r.table_name === table && r.column_name === column);
    const required: [string, string][] = [
      ["api_keys", "id"],
      ["api_keys", "public_key"],
      ["api_keys", "hashed_secret_key"],
      ["api_keys", "fast_hashed_secret_key"],
      ["api_keys", "display_secret_key"],
      ["api_keys", "project_id"],
      ["api_keys", "scope"],
      ["projects", "id"],
      ["projects", "name"],
      ["projects", "org_id"],
      ["organizations", "name"],
    ];
    const missing = required.filter(([t, c]) => !has(t, c)).map(([t, c]) => `${t}.${c}`);
    if (missing.length) {
      fail(
        `Langfuse's schema has changed (missing ${missing.join(", ")}); re-verify src/provision/keys.ts.`,
      );
    }

    const live = has("projects", "deleted_at") ? "WHERE p.deleted_at IS NULL" : "";
    const projects = (
      await db.query<DbProject>(
        `SELECT p.id, p.name, o.name AS org FROM projects p JOIN organizations o ON o.id = p.org_id ${live} ORDER BY o.name, p.name`,
      )
    ).rows;

    const file = readKeysFile();
    const checks = new Map<string, KeyCheck>();
    await Promise.all(
      Object.entries(file.projects).map(async ([name, entry]) =>
        checks.set(name, await checkKey(entry)),
      ),
    );
    const actions = planActions({
      projects,
      file,
      checks,
      only: list(flags.only),
      exclude: list(flags.exclude),
    });

    console.log(`database:  ${describeDb(dbUrl!)}`);
    console.log(`host:      ${host}`);
    console.log(`keys file: ${keysPath}`);
    console.log(`projects:  ${projects.length} live\n`);
    for (const a of actions) {
      const where = "project" in a ? `${a.project.org}/${a.project.id}` : "";
      const why = "reason" in a ? `  — ${a.reason}` : "";
      console.log(`  ${a.kind.padEnd(7)} ${a.name.padEnd(40)} ${where}${why}`);
    }
    const work = actions.filter(
      (a) => a.kind === "create" || a.kind === "rotate" || a.kind === "drop",
    );
    if (!flags.apply) {
      console.log(`\nDry run: ${work.length} change(s). Re-run with --apply to make them.`);
      return;
    }
    if (actions.some((a) => a.kind === "blocked")) {
      console.log("\nSome projects are blocked (see above); they are skipped.");
    }

    const insertNote = has("api_keys", "note");
    const insertInApp = has("api_keys", "is_in_app_agent_key");
    const save = (): void =>
      writeKeysFile(keysPath, { ...file, host, updatedAt: new Date().toISOString() });

    const mint = async (a: Extract<Action, { kind: "create" | "rotate" }>): Promise<void> => {
      const pair = generateKeyPair();
      const columns = [
        "id",
        "public_key",
        "hashed_secret_key",
        "fast_hashed_secret_key",
        "display_secret_key",
        "project_id",
        "scope",
      ];
      const params: unknown[] = [
        generateRowId(),
        pair.publicKey,
        await slowHash(pair.secretKey),
        fastHash(pair.secretKey, salt!),
        displaySecretKey(pair.secretKey),
        a.project.id,
        "PROJECT",
      ];
      if (insertInApp) {
        columns.push("is_in_app_agent_key");
        params.push(false);
      }
      if (insertNote) {
        columns.push("note");
        params.push(KEY_NOTE);
      }
      await db.query(
        `INSERT INTO api_keys (${columns.join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
        params,
      );

      // Verified after the INSERT commits, against the running Langfuse: the only
      // check that catches a wrong SALT or the wrong database.
      const check = await checkKey(pair);
      if (check.status !== "live" || check.projectId !== a.project.id) {
        await db.query("DELETE FROM api_keys WHERE public_key = $1", [pair.publicKey]);
        fail(
          check.status === "dead"
            ? `the key minted for ${a.name} does not authenticate: LANGFUSE_SALT does not match the running ` +
                `Langfuse, or LANGFUSE_DB_URL is not the database it reads. The row was removed.`
            : `could not verify the key minted for ${a.name} (${check.status === "error" ? check.message : `reads ${check.projectId}`}). The row was removed.`,
        );
      }

      // Persist before revoking anything, so a crash leaves the old key working
      // and the new one recorded.
      for (const [name, entry] of Object.entries(file.projects)) {
        if (entry.id === a.project.id || name === a.name) delete file.projects[name];
      }
      file.projects[a.name] = { id: a.project.id, ...pair };
      save();

      if (a.kind === "rotate" && a.revokeOld) {
        await db.query("DELETE FROM api_keys WHERE public_key = $1 AND project_id = $2", [
          a.old.publicKey,
          a.project.id,
        ]);
      }
      console.log(`  ${a.kind === "create" ? "created" : "rotated"} ${a.name}`);
    };

    for (const a of actions) {
      if (a.kind === "create" || a.kind === "rotate") await mint(a);
      if (a.kind === "drop") {
        delete file.projects[a.name];
        save();
        console.log(`  dropped ${a.name} from the keys file`);
      }
    }
    if (work.length === 0) save();
    console.log(
      `\nDone. ${keysPath} now holds ${Object.keys(file.projects).length} project key(s).`,
    );
  } finally {
    await db.end().catch(() => {});
  }
};

main().catch((err: unknown) => fail((err as Error).message));
