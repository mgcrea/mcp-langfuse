import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const ScalarsSchema = z
  .object({
    /** The Langfuse instance, without `/api/public`. Keys are only valid on the host that minted them. */
    baseUrl: z
      .url("LANGFUSE_HOST must be a URL, e.g. https://cloud.langfuse.com")
      .default("https://cloud.langfuse.com"),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
  })
  .strict();

const KeyPairSchema = z
  .object({
    /** The Langfuse project id the key was minted for. Checked before any read. */
    id: z.string().min(1).optional(),
    publicKey: z.string().min(1),
    secretKey: z.string().min(1),
  })
  .strict();

/** `LANGFUSE_PROJECTS`: project name → key pair. */
const ProjectsMapSchema = z.record(z.string().min(1), KeyPairSchema);

/**
 * The keys file `scripts/provision-keys.ts` writes. `.strict()` on purpose: a
 * typo'd `secretkey` must be an error, not a silently-missing project. The
 * provisioning script reads the file with it too, so the two never disagree.
 */
export const KeysFileSchema = z
  .object({
    host: z.url().optional(),
    updatedAt: z.string().optional(),
    projects: ProjectsMapSchema,
  })
  .strict();

export type ProjectEntry = {
  /** What the tools' `project` argument takes. */
  name: string;
  /**
   * Names or ids the key must resolve to before anything is read. Langfuse keys
   * are project-scoped, so the key alone decides which project answers — and a
   * key filed under the wrong name answers just as happily with the wrong data.
   * Empty only for a lone LANGFUSE_PUBLIC_KEY pair without LANGFUSE_PROJECT.
   */
  expect: string[];
  publicKey: string;
  secretKey: string;
  source: "LANGFUSE_PUBLIC_KEY" | "LANGFUSE_PROJECTS" | "keys file";
};

export type Config = z.infer<typeof ScalarsSchema> & {
  projects: ProjectEntry[];
  keysFile: string;
  /**
   * What was wrong with the configuration. Reported through
   * langfuse_auth_status and the startup log — never thrown, because a server
   * that exits on startup shows up in the client as a bare "Connection closed"
   * with stderr swallowed, and the one message that would have explained the
   * problem never reaches anyone.
   */
  problems: string[];
  /**
   * Projects whose keys were found but are not served, because LANGFUSE_HOST
   * is invalid: serving them against the default host would send the keys to
   * an instance that never issued them.
   */
  withheld?: string[];
};

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

export const resolveKeysFilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.LANGFUSE_KEYS_FILE);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "langfuse-mcp", "keys.json");
};

export const describeZod = (err: z.ZodError): string =>
  err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");

type Scalars = z.infer<typeof ScalarsSchema>;

/**
 * The scalars, with any invalid one reported and left at its default rather
 * than thrown — see `Config.problems` for why nothing here may throw.
 */
const parseScalars = (
  input: z.input<typeof ScalarsSchema>,
  problems: string[],
): { scalars: Scalars; hostInvalid: boolean } => {
  const parsed = ScalarsSchema.safeParse(input);
  if (parsed.success) return { scalars: parsed.data, hostInvalid: false };
  const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0]);
    problems.push(
      field === "baseUrl"
        ? `${issue.message}. No project is served until it is fixed, so no key is sent to the default host instead.`
        : `${field === "maxRetries" ? "LANGFUSE_MAX_RETRIES" : field}: ${issue.message}; using the default.`,
    );
  }
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !bad.has(k)));
  return { scalars: ScalarsSchema.parse(rest), hostInvalid: bad.has("baseUrl") };
};

type KeysFile = z.infer<typeof KeysFileSchema>;

const readKeysFile = (path: string, problems: string[]): KeysFile | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`Could not read the keys file ${path}: ${(err as Error).message}`);
    }
    return undefined;
  }
  try {
    if (process.platform !== "win32" && statSync(path).mode & 0o077) {
      problems.push(
        `${path} holds secret keys and is readable by other users. Run: chmod 600 ${path}`,
      );
    }
  } catch {
    // Raced with a delete; the content we already read is still usable.
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    problems.push(`The keys file ${path} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
  const parsed = KeysFileSchema.safeParse(json);
  if (!parsed.success) {
    problems.push(`The keys file ${path} is malformed: ${describeZod(parsed.error)}`);
    return undefined;
  }
  return parsed.data;
};

const parseProjectsEnv = (
  value: string | undefined,
  problems: string[],
): z.infer<typeof ProjectsMapSchema> => {
  if (!value) return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch (err) {
    problems.push(`LANGFUSE_PROJECTS is not valid JSON: ${(err as Error).message}`);
    return {};
  }
  const parsed = ProjectsMapSchema.safeParse(json);
  if (!parsed.success) {
    problems.push(`LANGFUSE_PROJECTS is malformed: ${describeZod(parsed.error)}`);
    return {};
  }
  return parsed.data;
};

/**
 * Environment first, keys file second, per field and per project name: Docker
 * and CI inject the environment and must keep working untouched, while the file
 * that scripts/provision-keys.ts maintains supplies everything else.
 *
 * Three sources of keys, merged by project name, earlier wins:
 *   1. LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY, named by LANGFUSE_PROJECT
 *   2. LANGFUSE_PROJECTS, a JSON map of name → { publicKey, secretKey, id? }
 *   3. the keys file, LANGFUSE_KEYS_FILE (~/.config/langfuse-mcp/keys.json)
 *
 * The variable names are the ones the Langfuse SDKs and the Python
 * `langfuse-mcp` already read (`LANGFUSE_HOST`, with `LANGFUSE_BASE_URL` as an
 * alias), so an existing single-project `.mcp.json` keeps working unchanged.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  keysFile: string = resolveKeysFilePath(env),
): Config => {
  const problems: string[] = [];
  const file = readKeysFile(keysFile, problems);
  const fromEnvMap = parseProjectsEnv(trimmed(env.LANGFUSE_PROJECTS), problems);

  const { scalars, hostInvalid } = parseScalars(
    {
      baseUrl: (
        trimmed(env.LANGFUSE_HOST) ??
        trimmed(env.LANGFUSE_BASE_URL) ??
        file?.host
      )?.replace(/\/+$/, ""),
      allowWrites: parseBool(env.LANGFUSE_ALLOW_WRITES),
      maxRetries: parseIntOpt(env.LANGFUSE_MAX_RETRIES),
    },
    problems,
  );

  const projects = new Map<string, ProjectEntry>();
  const addMap = (map: z.infer<typeof ProjectsMapSchema>, source: ProjectEntry["source"]): void => {
    for (const [name, pair] of Object.entries(map)) {
      if (projects.has(name)) continue;
      projects.set(name, {
        name,
        expect: [name, ...(pair.id ? [pair.id] : [])],
        publicKey: pair.publicKey,
        secretKey: pair.secretKey,
        source,
      });
    }
  };

  const publicKey = trimmed(env.LANGFUSE_PUBLIC_KEY);
  const secretKey = trimmed(env.LANGFUSE_SECRET_KEY);
  const expected = trimmed(env.LANGFUSE_PROJECT);
  const others = Object.keys(fromEnvMap).length + Object.keys(file?.projects ?? {}).length;
  if (publicKey && secretKey) {
    if (expected) {
      projects.set(expected, {
        name: expected,
        expect: [expected],
        publicKey,
        secretKey,
        source: "LANGFUSE_PUBLIC_KEY",
      });
    } else if (others === 0) {
      // The single-project setup from before multi-project support: no name to
      // check against, so it is served unchecked, exactly as it always was.
      projects.set("default", {
        name: "default",
        expect: [],
        publicKey,
        secretKey,
        source: "LANGFUSE_PUBLIC_KEY",
      });
    } else {
      problems.push(
        "LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY were ignored: alongside other projects they need " +
          "LANGFUSE_PROJECT to say which project they belong to.",
      );
    }
  }
  addMap(fromEnvMap, "LANGFUSE_PROJECTS");
  addMap(file?.projects ?? {}, "keys file");

  const sorted = [...projects.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  return {
    ...scalars,
    projects: hostInvalid ? [] : sorted,
    keysFile,
    problems,
    ...(hostInvalid && sorted.length ? { withheld: sorted.map((p) => p.name) } : {}),
  };
};

export const isConfigured = (config: Config): boolean => config.projects.length > 0;

/** Returned by langfuse_auth_status and printed to stderr at startup. */
export const setupInstructions = (config: Config): string[] => {
  const lines = [...config.problems];
  if (!isConfigured(config) && !config.withheld?.length) {
    lines.push(
      "No Langfuse keys configured. Either run `pnpm provision` in the mcp-langfuse repo to " +
        `write one key per project to ${config.keysFile}, or set LANGFUSE_PUBLIC_KEY (pk-lf-…) ` +
        "and LANGFUSE_SECRET_KEY (sk-lf-…) from Project Settings → API Keys. Set LANGFUSE_HOST " +
        "to the instance that issued them, then restart the server.",
    );
  }
  // Swapped keys fail with a bare 401 that looks exactly like a revoked key.
  for (const p of config.projects) {
    if (p.publicKey.startsWith("sk-lf-") || p.secretKey.startsWith("pk-lf-")) {
      lines.push(
        `The keys for "${p.name}" (${p.source}) look swapped: the public key starts with pk-lf-, the secret key with sk-lf-.`,
      );
    }
  }
  return lines;
};
