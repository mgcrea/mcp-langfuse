import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProjectRegistry } from "#/client/projects";
import { resolveWindow } from "#/client/query";
import { summarizeScore } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import {
  compact,
  cursorArg,
  fromArg,
  limitArg,
  scoped,
  sessionIdArg,
  sinceArg,
  toArg,
  traceIdArg,
  wrap,
} from "#/tools/util";

/** Comma-joined, since v3 takes lists as one comma-separated value. */
const list = (values: string[] | undefined): string | undefined =>
  values?.length ? values.join(",") : undefined;

export const registerScoreTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "langfuse_list_scores",
    {
      title: "Langfuse: List Scores",
      description:
        "List scores (evaluations, annotations, user feedback), newest first, with what each " +
        "is attached to (`subject`: trace, observation, session or experiment) and its " +
        "comment. Uses /v3/scores — /scores and /v2/scores are gone in events-only mode. " +
        "traceId, sessionId and experimentId are mutually exclusive. For averages or " +
        "distributions over many scores use langfuse_query_metrics with a scores view.",
      inputSchema: z.object({
        project: ctx.projectArg,
        traceId: traceIdArg.optional(),
        observationId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only scores on this observation, e.g. "00f067aa0ba902b7". Requires traceId — Langfuse returns 400 without it.',
          ),
        sessionId: sessionIdArg.optional(),
        name: z
          .array(z.string().min(1))
          .optional()
          .describe('Only these score names (any of), e.g. ["accuracy", "user-feedback"].'),
        source: z
          .array(z.enum(["API", "ANNOTATION", "EVAL"]))
          .optional()
          .describe('Only these sources (any of), e.g. ["ANNOTATION"].'),
        dataType: z
          .enum(["NUMERIC", "BOOLEAN", "CATEGORICAL", "TEXT", "CORRECTION"])
          .optional()
          .describe(
            'Only this data type, e.g. "NUMERIC". Required for valueMin/valueMax, and must be NUMERIC there.',
          ),
        valueMin: z
          .number()
          .optional()
          .describe("Inclusive lower bound on a NUMERIC value, e.g. 0.5."),
        valueMax: z
          .number()
          .optional()
          .describe("Inclusive upper bound on a NUMERIC value, e.g. 0.5."),
        since: sinceArg,
        from: fromArg,
        to: toArg,
        limit: limitArg,
        cursor: cursorArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const window = resolveWindow(args, ctx.now());
          const res = await client.get<{
            data?: Record<string, unknown>[];
            meta?: { cursor?: string };
          }>(
            "/api/public/v3/scores",
            compact({
              fields: "details,subject,annotation",
              traceId: args.traceId,
              observationId: args.observationId,
              sessionId: args.sessionId,
              name: list(args.name),
              source: list(args.source),
              dataType: args.dataType,
              valueMin: args.valueMin,
              valueMax: args.valueMax,
              fromTimestamp: window.from,
              toTimestamp: window.to,
              limit: args.limit,
              cursor: args.cursor,
            }),
          );
          return {
            scores: (res.data ?? []).map(summarizeScore),
            ...(res.meta?.cursor ? { nextCursor: res.meta.cursor } : {}),
          };
        }),
      ),
  );
};
