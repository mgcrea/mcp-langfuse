import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { LangfuseApiError } from "#/client/errors";
import type { ProjectRegistry } from "#/client/projects";
import { observationFilters, resolveWindow } from "#/client/query";
import { cleanMetadata, clip, prune, summarizeObservation } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  cursorArg,
  environmentArg,
  extraFiltersArg,
  fromArg,
  includeMetadataArg,
  ioCharsArg,
  levelArg,
  limitArg,
  observationTypeArg,
  scoped,
  sessionIdArg,
  sinceArg,
  tagsArg,
  toArg,
  traceIdArg,
  userIdArg,
  wrap,
} from "#/tools/util";

const ROW_FIELDS = "core,basic,usage,model,prompt,metrics,trace_context";
const ALL_FIELDS = "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context";

/** Per-row pricing echoes and ids the response already carries elsewhere. */
const FULL_DROP = ["projectId", "modelId", "inputPrice", "outputPrice", "totalPrice"];

export const registerObservationTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "langfuse_list_observations",
    {
      title: "Langfuse: List Observations",
      description:
        "Search observations (LLM generations, spans, tool calls, …) across traces, newest " +
        "first. The way to answer 'which calls failed', 'which generations used model X', " +
        "'which steps were slow' or 'where does this text appear': each row carries its " +
        "traceId for langfuse_get_trace. Input/output are omitted unless ioChars is set. " +
        "inputMatches/outputMatches use Langfuse's indexed literal search (case-insensitive).",
      inputSchema: z.object({
        project: ctx.projectArg,
        since: sinceArg,
        from: fromArg,
        to: toArg,
        traceId: traceIdArg.optional(),
        sessionId: sessionIdArg.optional(),
        userId: userIdArg,
        type: observationTypeArg,
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Only observations with this exact name, e.g. "ChatOpenAI".'),
        level: levelArg,
        model: z
          .string()
          .min(1)
          .optional()
          .describe('Only generations that used this model name, as reported, e.g. "gpt-4o".'),
        environment: environmentArg,
        tags: tagsArg,
        minLatencySeconds: z
          .number()
          .min(0)
          .optional()
          .describe("Only observations that took at least this many seconds, e.g. 10."),
        inputMatches: z
          .string()
          .min(1)
          .optional()
          .describe('Only observations whose input contains this literal text, e.g. "order-1234".'),
        outputMatches: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only observations whose output contains this literal text, e.g. "rate limit".',
          ),
        filters: extraFiltersArg,
        ioChars: ioCharsArg(0, "observation"),
        includeMetadata: includeMetadataArg,
        limit: limitArg,
        cursor: cursorArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const fields = [
            ROW_FIELDS,
            ...(args.ioChars > 0 ? ["io"] : []),
            ...(args.includeMetadata ? ["metadata"] : []),
          ].join(",");
          const page = await client.observations({
            filters: observationFilters({
              ...resolveWindow(args, ctx.now()),
              traceId: args.traceId,
              sessionId: args.sessionId,
              userId: args.userId,
              type: args.type,
              name: args.name,
              level: args.level,
              model: args.model,
              environment: args.environment,
              tags: args.tags,
              minLatencySeconds: args.minLatencySeconds,
              inputMatches: args.inputMatches,
              outputMatches: args.outputMatches,
              extra: args.filters,
            }),
            fields,
            limit: args.limit,
            cursor: args.cursor,
          });
          return {
            observations: page.data.map((o) =>
              summarizeObservation(o, {
                ioChars: args.ioChars,
                includeMetadata: args.includeMetadata,
              }),
            ),
            ...(page.cursor ? { nextCursor: page.cursor } : {}),
          };
        }),
      ),
  );

  server.registerTool(
    "langfuse_get_observation",
    {
      title: "Langfuse: Get Observation",
      description:
        "Get one observation in full: input, output, metadata, model parameters, usage, cost " +
        "and timings (metadata without the OpenTelemetry scope/resource attributes every span repeats; savePath keeps them). Pass its traceId too when you have it — observation ids are scoped to a " +
        "trace and the lookup is much faster. Input/output are cut at maxChars; to keep a long " +
        "prompt intact, set savePath and read the file rather than transcribing it.",
      inputSchema: z.object({
        project: ctx.projectArg,
        observationId: z
          .string()
          .min(1)
          .describe('Observation id, e.g. "00f067aa0ba902b7" — the `id` on an observation row.'),
        traceId: traceIdArg.optional(),
        maxChars: z
          .number()
          .int()
          .min(0)
          .max(500_000)
          .default(20_000)
          .describe(
            "Characters of input and of output to return (0 omits them). Defaults to 20000.",
          ),
        savePath: z
          .string()
          .optional()
          .describe(
            "Absolute path to also write the observation to, as pretty JSON with input/output " +
              "UNcut, whatever maxChars says. Parent directories are created.",
          ),
      }),
      // readOnly although savePath writes a local file: it changes nothing in
      // Langfuse, which is what the hint is about — as with mcp-apple-ads.
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          if (args.savePath !== undefined && !isAbsolute(args.savePath)) {
            throw new Error(`savePath must be absolute, got "${args.savePath}".`);
          }
          const page = await client.observations({
            filters: observationFilters({
              traceId: args.traceId,
              extra: [{ type: "string", column: "id", operator: "=", value: args.observationId }],
            }),
            fields: ALL_FIELDS,
            limit: 1,
          });
          const raw = page.data[0];
          if (!raw) {
            throw new LangfuseApiError(`Observation ${args.observationId} not found.`, {
              status: 404,
              remedy:
                "Check the id (and traceId, if given). Keys are project-scoped: an observation " +
                "recorded under another Langfuse project cannot be found with this server's key.",
            });
          }
          const full = Object.fromEntries(
            Object.entries(raw).filter(([k]) => !FULL_DROP.includes(k)),
          );
          if (args.savePath) {
            await mkdir(dirname(args.savePath), { recursive: true });
            await writeFile(args.savePath, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
          }
          return {
            observation: prune({
              ...full,
              metadata: cleanMetadata(raw.metadata),
              input: args.maxChars > 0 ? clip(raw.input, args.maxChars) : undefined,
              output: args.maxChars > 0 ? clip(raw.output, args.maxChars) : undefined,
            }),
            ...(args.savePath ? { savedTo: args.savePath } : {}),
          };
        }),
      ),
  );
};
