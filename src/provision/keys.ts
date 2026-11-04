// Per-project key provisioning for Langfuse OSS, by writing the rows Langfuse's
// own UI writes. Pure logic only: hashing, planning, the keys file. The
// database half lives in scripts/provision-keys.ts, and nothing in the server
// imports this module, so neither `pg` nor `bcryptjs` ships in the bundle.
//
// Why this exists: Langfuse keys are project-scoped, and the only API that
// mints them (`POST /api/public/projects/{id}/apiKeys`) is behind the EE
// `admin-api` entitlement. An org key on an OSS instance gets 403 "not available
// on your current plan" for every org endpoint. The data plane is fully OSS, so
// a key written straight into Langfuse's Postgres authenticates like any other.
//
// COUPLING — this reproduces how Langfuse itself stores keys, verified against
// Langfuse 4.63.0. Re-verify on a Langfuse upgrade:
//   api_keys.fast_hashed_secret_key = sha256hex(secretKey + SALT)   per-request lookup
//   api_keys.hashed_secret_key      = bcrypt(secretKey, cost 11)     verification
//   api_keys.display_secret_key     = first 6 + "..." + last 4
//   scope 'PROJECT', is_in_app_agent_key false, project_id = the project
// A wrong SALT (or the wrong database) yields a key that never authenticates, so
// every minted key is checked against the API before it is kept.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import bcrypt from "bcryptjs";

import { describeZod, KeysFileSchema } from "#/config";

export const KEY_NOTE = "mcp-langfuse (read)";

export type KeyPair = { publicKey: string; secretKey: string };

/** Langfuse's own format: pk-lf-/sk-lf- and a UUID. Only the stored hashes must match. */
export const generateKeyPair = (): KeyPair => ({
  publicKey: `pk-lf-${randomUUID()}`,
  secretKey: `sk-lf-${randomUUID()}`,
});

/** A cuid-shaped row id. Langfuse only needs it unique. */
export const generateRowId = (): string => `c${randomBytes(12).toString("hex")}`;

export const fastHash = (secretKey: string, salt: string): string =>
  createHash("sha256")
    .update(secretKey + salt)
    .digest("hex");

export const slowHash = (secretKey: string): Promise<string> => bcrypt.hash(secretKey, 11);

export const displaySecretKey = (secretKey: string): string =>
  `${secretKey.slice(0, 6)}...${secretKey.slice(-4)}`;

// --------------------------------------------------------------- planning --

export type DbProject = { id: string; name: string; org: string };
export type FileEntry = { id?: string; publicKey: string; secretKey: string };
export type KeysFile = { host?: string; updatedAt?: string; projects: Record<string, FileEntry> };

/** What a recorded key does when tried against the API. */
export type KeyCheck =
  | { status: "live"; projectId: string }
  | { status: "dead" }
  | { status: "error"; message: string };

export type Action =
  | { kind: "keep"; name: string; project: DbProject }
  | { kind: "create"; name: string; project: DbProject }
  | {
      kind: "rotate";
      name: string;
      project: DbProject;
      old: FileEntry;
      reason: string;
      /**
       * Delete the old key's row once the new one is saved. Only for a dead key:
       * a recorded key that reads another project is live there, and whatever
       * else uses it would break.
       */
      revokeOld: boolean;
    }
  | { kind: "drop"; name: string; old: FileEntry; reason: string }
  | { kind: "blocked"; name: string; project: DbProject; reason: string };

/**
 * The name a project is served under. Langfuse allows two projects with one
 * name (across organizations), and the server's `project` argument needs them
 * apart, so a duplicate gets its id appended.
 */
export const entryNames = (projects: DbProject[]): Map<string, string> => {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return new Map(
    projects.map((p) => [p.id, (counts.get(p.name) ?? 0) > 1 ? `${p.name}#${p.id}` : p.name]),
  );
};

const selected = (p: DbProject, only: string[], exclude: string[]): boolean =>
  (only.length === 0 || only.includes(p.name) || only.includes(p.id)) &&
  !exclude.includes(p.name) &&
  !exclude.includes(p.id);

/**
 * Decide, per project, whether its recorded key is kept, replaced or created.
 * Pure: the database rows, the file and the outcome of trying each recorded
 * key are all inputs, so the plan printed by a dry run is exactly what
 * `--apply` does.
 *
 * A recorded key is only replaced when the API says it is dead (401) or that
 * it reads another project. An unreachable host blocks that project rather
 * than minting blind.
 */
export const planActions = (input: {
  projects: DbProject[];
  file: KeysFile;
  checks: Map<string, KeyCheck>;
  only?: string[];
  exclude?: string[];
}): Action[] => {
  const only = input.only ?? [];
  const exclude = input.exclude ?? [];
  const names = entryNames(input.projects);
  const byId = new Map(input.projects.map((p) => [p.id, p]));
  const claimed = new Set<string>();
  const actions: Action[] = [];

  // The entry recorded for a project: by id when the file has one, else by name.
  const recorded = new Map<string, [string, FileEntry]>();
  for (const [name, entry] of Object.entries(input.file.projects)) {
    const project = entry.id
      ? byId.get(entry.id)
      : input.projects.find((p) => names.get(p.id) === name);
    if (project) {
      recorded.set(project.id, [name, entry]);
      claimed.add(name);
    }
  }

  for (const project of input.projects) {
    if (!selected(project, only, exclude)) continue;
    const name = names.get(project.id)!;
    const hit = recorded.get(project.id);
    if (!hit) {
      actions.push({ kind: "create", name, project });
      continue;
    }
    const [recordedName, entry] = hit;
    const check = input.checks.get(recordedName);
    if (check?.status === "live" && check.projectId === project.id) {
      actions.push({ kind: "keep", name, project });
    } else if (check?.status === "live") {
      actions.push({
        kind: "rotate",
        name,
        project,
        old: entry,
        reason: `recorded key reads another project (${check.projectId}); it is left in place`,
        revokeOld: false,
      });
    } else if (check?.status === "dead") {
      actions.push({
        kind: "rotate",
        name,
        project,
        old: entry,
        reason: "recorded key no longer authenticates",
        revokeOld: true,
      });
    } else {
      actions.push({
        kind: "blocked",
        name,
        project,
        reason: check?.status === "error" ? check.message : "recorded key was not checked",
      });
    }
  }

  // Entries for projects that no longer exist. Only when nothing was filtered:
  // a partial run must not forget keys it was told to leave alone. Dropping
  // only removes the entry from the file; no row in Langfuse is touched, since
  // an entry this run cannot place may be a key someone added by hand.
  if (only.length === 0 && exclude.length === 0) {
    for (const [name, entry] of Object.entries(input.file.projects)) {
      if (!claimed.has(name))
        actions.push({ kind: "drop", name, old: entry, reason: "project no longer exists" });
    }
  }
  return actions;
};

// -------------------------------------------------------------- keys file --

/** Parse the keys file with the schema the server reads it with. Throws on malformed input. */
export const parseKeysFile = (text: string): KeysFile => {
  const parsed = KeysFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`not a valid keys file: ${describeZod(parsed.error)}`);
  return parsed.data;
};

/**
 * Write the keys file atomically with mode 0600, in a 0700 directory. Written
 * after every key minted, not once at the end: a crash mid-run must not leave a
 * key in Langfuse whose secret exists nowhere.
 */
export const writeKeysFile = (path: string, file: KeysFile): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};
