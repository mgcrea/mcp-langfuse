import { z } from "zod";

import { LangfuseApiError, ProjectMismatchError } from "#/client/errors";
import type { LangfuseClient } from "#/client/langfuse";
import type { ProjectRegistry } from "#/client/projects";
import { DURATION } from "#/client/query";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Compact, not pretty-printed: indentation adds 19-41% to every row and no model needs it. */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * `extra` is spread at the top level, so a `remedy` lands beside the error
 * rather than inside the upstream envelope, where it would get skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof LangfuseApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      status: err.status,
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof ProjectMismatchError) return fail(err.message, { remedy: err.remedy });
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/**
 * Check the key's project before reading anything, and stamp its name on the
 * result. The stamp is the cheap half of the guard: a key copied from the
 * wrong project answers every query with plausible data, and the only thing
 * that gives it away is the project name sitting next to that data.
 */
export const scoped = async <T extends Record<string, unknown>>(
  projects: ProjectRegistry,
  name: string | undefined,
  fn: (client: LangfuseClient) => Promise<T>,
): Promise<{ project: string } & T> => {
  const { client } = projects.resolve(name);
  const project = await client.assertProject();
  return { project: project.name, ...(await fn(client)) };
};

/**
 * The `project` argument every data tool takes. Required as soon as there is
 * more than one project — no default, because a silently chosen project is the
 * failure this server exists to prevent.
 */
export const projectArgFor = (names: string[]): z.ZodType<string | undefined> => {
  const values = names as [string, ...string[]];
  return names.length > 1
    ? z
        .enum(values)
        .describe(
          "Which Langfuse project to read. Each project has its own key, so data from one is " +
            "never visible through another; langfuse_auth_status lists them.",
        )
    : z
        .enum(values)
        .optional()
        .describe(
          `Which Langfuse project to read. Only "${names[0]}" is configured, so it may be omitted.`,
        );
};

/** Drop undefined values so we never send `{"cursor": undefined}` upstream. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

// ---------------------------------------------------------------- arg atoms --

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe("Maximum number of rows to return (1-100). Defaults to 25.");

export const cursorArg = z
  .string()
  .optional()
  .describe(
    "Opaque cursor from the previous response's `nextCursor`, to fetch the next page. Re-send " +
      "the same filters with it — the cursor only carries the position.",
  );

export const traceIdArg = z
  .string()
  .min(1)
  .describe(
    'Trace id: the 32-hex-char OpenTelemetry trace id, e.g. "4bf92f3577b34da6a3ce929d0e0e4736" ' +
      "— the `traceId` from langfuse_list_traces or any observation row.",
  );

export const sessionIdArg = z
  .string()
  .min(1)
  .describe(
    'Session id as the app set it, e.g. "9b2d7c1e-3f4a-4e8b-9c0d-1a2b3c4d5e6f" — the ' +
      "`sessionId` on a trace row.",
  );

export const sinceArg = z
  .string()
  .regex(DURATION, 'A number and a unit m/h/d/w, e.g. "30m", "24h", "7d".')
  .optional()
  .describe(
    'Relative window ending now, e.g. "24h" or "7d". Prefer this over `from` unless you know ' +
      "today's date for certain. Ignored when `from` is given.",
  );

export const fromArg = z.iso
  .datetime({ offset: true })
  .optional()
  .describe('Inclusive lower bound on start time, ISO 8601, e.g. "2026-10-30T00:00:00Z".');

export const toArg = z.iso
  .datetime({ offset: true })
  .optional()
  .describe('Exclusive upper bound on start time, ISO 8601, e.g. "2026-10-31T00:00:00Z".');

export const environmentArg = z
  .array(z.string().min(1))
  .optional()
  .describe(
    'Only these environments (any of), e.g. ["production"]. Langfuse\'s default is "default".',
  );

export const tagsArg = z
  .array(z.string().min(1))
  .optional()
  .describe('Only traces carrying ALL of these tags, e.g. ["checkout-agent"].');

export const userIdArg = z
  .string()
  .min(1)
  .optional()
  .describe('Only this end-user id, as the app set it on the trace, e.g. "user-1234".');

export const observationTypeArg = z
  .enum([
    "GENERATION",
    "SPAN",
    "EVENT",
    "AGENT",
    "TOOL",
    "CHAIN",
    "RETRIEVER",
    "EVALUATOR",
    "EMBEDDING",
    "GUARDRAIL",
  ])
  .optional()
  .describe('Only this observation type. LLM calls are "GENERATION"; tool invocations "TOOL".');

export const levelArg = z
  .enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"])
  .optional()
  .describe(
    'Only this level. "ERROR" is how a failed step is marked; its reason is in `statusMessage`.',
  );

export const ioCharsArg = (fallback: number, what: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(100_000)
    .default(fallback)
    .describe(
      `Characters of input/output to keep per ${what} (0 omits them). Defaults to ${fallback}. ` +
        "LLM inputs are often 20 KB each; a longer value is cut with a marker giving its full " +
        "length. For one full value use langfuse_get_observation.",
    );

export const includeMetadataArg = z
  .boolean()
  .default(false)
  .describe(
    "Include each observation's metadata (OpenTelemetry resource/scope attributes stripped). " +
      "Defaults to false. Values over 200 chars arrive truncated by Langfuse itself.",
  );

const filterConditionSchema = z
  .object({
    type: z
      .enum([
        "datetime",
        "string",
        "number",
        "stringOptions",
        "categoryOptions",
        "arrayOptions",
        "stringObject",
        "numberObject",
        "boolean",
        "null",
      ])
      .describe('Value type of the column, e.g. "string", "number", "stringObject" for metadata.'),
    column: z
      .string()
      .min(1)
      .describe('Column, e.g. "metadata", "totalCost", "promptName", "statusMessage".'),
    operator: z
      .string()
      .min(1)
      .describe(
        'Operator for the type, e.g. "=", ">=", "contains", "any of", "is null", "matches".',
      ),
    value: z.unknown().optional().describe("Value to compare against; omitted for the null type."),
    key: z
      .string()
      .optional()
      .describe('Metadata key, required for stringObject/numberObject, e.g. "thread_id".'),
  })
  .strict();

export const extraFiltersArg = z
  .array(filterConditionSchema)
  .optional()
  .describe(
    "Additional raw Langfuse filter conditions, ANDed with the other arguments. For anything " +
      'the named args do not cover, e.g. a metadata key: {"type":"stringObject","column":' +
      '"metadata","key":"customer_id","operator":"=","value":"C-42"}, or cost: ' +
      '{"type":"number","column":"totalCost","operator":">","value":0.1}.',
  );
