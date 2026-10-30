import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { LangfuseApiError } from "#/client/errors";
import type { ProjectRegistry } from "#/client/projects";
import { observationFilters, resolveWindow } from "#/client/query";
import { summarizeTrace, summarizeTraceRow } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  cursorArg,
  environmentArg,
  extraFiltersArg,
  fromArg,
  includeMetadataArg,
  ioCharsArg,
  limitArg,
  scoped,
  sessionIdArg,
  sinceArg,
  tagsArg,
  toArg,
  traceIdArg,
  userIdArg,
  wrap,
} from "#/tools/util";

// Events-only Langfuse has no /traces or /sessions. A trace here is its
// observations: the list is the root observations (`isRootObservation`), one
// per trace, and a trace's detail is every observation sharing its traceId.

const ROW_FIELDS = "core,basic,metrics,trace_context";
const TREE_FIELDS = "core,basic,usage,model,prompt,metrics,trace_context";

const notFound = (what: string, project: string): LangfuseApiError =>
  new LangfuseApiError(`No observations found for ${what} in Langfuse project "${project}".`, {
    status: 404,
    remedy:
      `Check the id. Langfuse keys are project-scoped, so data from any other project is simply ` +
      `not found here: if it was recorded under another project, this server needs that ` +
      `project's key pair.`,
  });

export const registerTraceTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "langfuse_list_traces",
    {
      title: "Langfuse: List Traces",
      description:
        "List traces, newest first: one row per trace with its id, name, start time, latency " +
        "(seconds), user, session and tags. Built on the root observation of each trace, since " +
        "this Langfuse runs in v4 events-only mode where /traces no longer exists. To find " +
        "traces that FAILED somewhere inside, use langfuse_list_observations with " +
        'level "ERROR" — the root of a failed trace is usually still DEFAULT. For counts, cost ' +
        "or latency percentiles across many traces use langfuse_query_metrics, not paging.",
      inputSchema: z.object({
        project: ctx.projectArg,
        since: sinceArg,
        from: fromArg,
        to: toArg,
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Only traces with this exact name, e.g. "support-agent".'),
        userId: userIdArg,
        sessionId: sessionIdArg.optional(),
        environment: environmentArg,
        tags: tagsArg,
        minLatencySeconds: z
          .number()
          .min(0)
          .optional()
          .describe("Only traces whose root took at least this many seconds, e.g. 30."),
        filters: extraFiltersArg,
        ioChars: ioCharsArg(0, "trace"),
        limit: limitArg,
        cursor: cursorArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const window = resolveWindow(args, ctx.now());
          const page = await client.observations({
            filters: observationFilters({
              ...window,
              rootOnly: true,
              traceName: args.name,
              userId: args.userId,
              sessionId: args.sessionId,
              environment: args.environment,
              tags: args.tags,
              minLatencySeconds: args.minLatencySeconds,
              extra: args.filters,
            }),
            fields: args.ioChars > 0 ? `${ROW_FIELDS},io` : ROW_FIELDS,
            limit: args.limit,
            cursor: args.cursor,
          });
          return {
            traces: page.data.map((o) => summarizeTraceRow(o, args.ioChars)),
            ...(page.cursor ? { nextCursor: page.cursor } : {}),
          };
        }),
      ),
  );

  server.registerTool(
    "langfuse_get_trace",
    {
      title: "Langfuse: Get Trace",
      description:
        "Get one trace as a tree: trace-level name, user, session, tags, total token usage and " +
        "cost, any ERROR steps, the trace's input and output, then every observation in " +
        "depth-first order with a `depth` field. Per-observation input/output is off by " +
        "default because LLM prompts run to tens of KB each; raise observationIoChars to ~300 " +
        "to preview every step, or call langfuse_get_observation for one step in full.",
      inputSchema: z.object({
        project: ctx.projectArg,
        traceId: traceIdArg,
        traceIoChars: ioCharsArg(2000, "trace (its input and output)"),
        observationIoChars: ioCharsArg(0, "observation"),
        includeMetadata: includeMetadataArg,
        maxObservations: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe(
            "Stop after this many observations (1-5000). Defaults to 500; `truncated` says when it was hit.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const wantIo = args.traceIoChars > 0 || args.observationIoChars > 0;
          const fields = [
            TREE_FIELDS,
            ...(wantIo ? ["io"] : []),
            ...(args.includeMetadata ? ["metadata"] : []),
          ].join(",");
          const { data, truncated } = await client.allObservations({
            filters: observationFilters({ traceId: args.traceId }),
            fields,
            max: args.maxObservations,
          });
          if (data.length === 0)
            throw notFound(`trace ${args.traceId}`, (await client.project()).name);
          return {
            ...summarizeTrace(args.traceId, data, {
              traceIoChars: args.traceIoChars,
              observationIoChars: args.observationIoChars,
              includeMetadata: args.includeMetadata,
            }),
            ...(truncated
              ? {
                  truncated: true,
                  note: `Stopped at ${data.length} observations; raise maxObservations for the rest.`,
                }
              : {}),
          };
        }),
      ),
  );

  server.registerTool(
    "langfuse_get_session",
    {
      title: "Langfuse: Get Session",
      description:
        "Get a session (a conversation or a multi-trace job) as its traces in chronological " +
        "order: each turn's trace id, name, start, observation count, token usage, cost, ERROR " +
        "steps, and its input and output. Reconstructed from observations because /sessions " +
        "does not exist in events-only mode. A session id comes from the `sessionId` on a " +
        "trace row. Drill into one turn with langfuse_get_trace.",
      inputSchema: z.object({
        project: ctx.projectArg,
        sessionId: sessionIdArg,
        ioChars: ioCharsArg(1000, "turn"),
        maxObservations: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .default(2000)
          .describe(
            "Read at most this many observations across the session (1-10000), newest first, so " +
              "a long session loses its OLDEST turns first. Defaults to 2000.",
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const { data, truncated } = await client.allObservations({
            filters: observationFilters({ sessionId: args.sessionId }),
            fields: args.ioChars > 0 ? `${TREE_FIELDS},io` : TREE_FIELDS,
            max: args.maxObservations,
          });
          if (data.length === 0)
            throw notFound(`session ${args.sessionId}`, (await client.project()).name);
          const byTrace = new Map<string, Record<string, unknown>[]>();
          for (const o of data) {
            const group = byTrace.get(String(o.traceId));
            if (group) group.push(o);
            else byTrace.set(String(o.traceId), [o]);
          }
          const turns = [...byTrace]
            .map(([traceId, observations]) => {
              const {
                observations: _tree,
                sessionId: _session,
                ...turn
              } = summarizeTrace(traceId, observations, {
                traceIoChars: args.ioChars,
                observationIoChars: 0,
                includeMetadata: false,
              });
              return turn;
            })
            .toSorted((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
          const first = data[0] ?? {};
          return {
            sessionId: args.sessionId,
            ...(first.userId ? { userId: first.userId } : {}),
            turnCount: turns.length,
            turns,
            ...(truncated
              ? {
                  truncated: true,
                  note: `Read the newest ${data.length} observations only; the oldest turns may be missing or partial. Raise maxObservations.`,
                }
              : {}),
          };
        }),
      ),
  );
};
