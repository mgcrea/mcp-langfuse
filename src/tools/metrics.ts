import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProjectRegistry } from "#/client/projects";
import { resolveWindow } from "#/client/query";
import type { ToolContext } from "#/tools/index";
import { extraFiltersArg, fromArg, scoped, sinceArg, toArg, wrap } from "#/tools/util";

const AGGREGATIONS = [
  "sum",
  "avg",
  "count",
  "max",
  "min",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
] as const;

export const registerMetricsTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "langfuse_query_metrics",
    {
      title: "Langfuse: Query Metrics",
      description:
        "Aggregate observations or scores server-side: counts, token and cost sums, latency " +
        "percentiles, score averages — grouped by dimensions and optionally bucketed over " +
        "time. Always prefer this over paging through langfuse_list_traces to count or total " +
        "anything. Count traces by filtering isRootObservation = true. Rows come back flat, " +
        'keyed `<aggregation>_<measure>`, e.g. "count_count", "sum_totalCost", "p95_latency". ' +
        "Units differ from the list tools: latency and timeToFirstToken are MILLISECONDS here, " +
        "seconds on observation rows. High-cardinality fields (traceId, userId, sessionId, id) " +
        "cannot be dimensions — filter on them instead.",
      inputSchema: z.object({
        project: ctx.projectArg,
        view: z
          .enum(["observations", "scores-numeric", "scores-boolean", "scores-categorical"])
          .default("observations")
          .describe(
            'What to aggregate. There is no traces view in v2; use "observations". Defaults to "observations".',
          ),
        metrics: z
          .array(
            z
              .object({
                measure: z
                  .string()
                  .min(1)
                  .describe(
                    "observations: count, latency, streamingLatency, inputTokens, outputTokens, " +
                      "totalTokens, inputCost, outputCost, totalCost, timeToFirstToken, " +
                      "tokensPerSecond, outputTokensPerSecond, countScores. scores-*: count, value.",
                  ),
                aggregation: z
                  .enum(AGGREGATIONS)
                  .describe(
                    'How to aggregate, e.g. "sum", "p95"; use "count" with measure "count".',
                  ),
              })
              .strict(),
          )
          .min(1)
          .describe(
            'At least one, e.g. [{"measure":"count","aggregation":"count"},{"measure":"totalCost","aggregation":"sum"}].',
          ),
        dimensions: z
          .array(z.string().min(1))
          .default([])
          .describe(
            'Fields to group by, e.g. ["traceName"] or ["providedModelName"]. observations: ' +
              "environment, type, name, level, version, tags, release, traceName, " +
              "providedModelName, promptName, promptVersion, isRootObservation, startTimeMonth. " +
              "scores-*: name, source, dataType, configId, traceName, observationName, " +
              "timestampDay, timestampMonth (+ booleanValue / stringValue).",
          ),
        filters: extraFiltersArg,
        granularity: z
          .enum(["auto", "minute", "hour", "day", "week", "month"])
          .optional()
          .describe(
            'Bucket results over time at this granularity, e.g. "day". "auto" makes ~50 buckets. Omit for one row per group.',
          ),
        since: sinceArg.describe(
          'Relative window ending now, e.g. "7d". When neither since nor from is given, defaults to the 24h before `to`, or before now.',
        ),
        from: fromArg,
        to: toArg,
        orderBy: z
          .array(
            z
              .object({
                field: z
                  .string()
                  .min(1)
                  .describe('A dimension or a metric key, e.g. "sum_totalCost".'),
                direction: z.enum(["asc", "desc"]).describe('"asc" or "desc".'),
              })
              .strict(),
          )
          .optional()
          .describe('Sort order, e.g. [{"field":"sum_totalCost","direction":"desc"}].'),
        rowLimit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum rows (1-1000). Defaults to 100."),
        histogramBins: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Bins for the histogram aggregation (1-100). Langfuse defaults to 10."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          // The default 24h ends where the caller's window ends: at `to` when
          // given, so a bare `to` in the past cannot yield from > to.
          const defaulted = !args.from && !args.since;
          const window = resolveWindow(
            { ...args, since: args.from ? undefined : (args.since ?? "24h") },
            defaulted && args.to ? new Date(args.to) : ctx.now(),
            { requireTo: true },
          );
          const query = {
            view: args.view,
            dimensions: args.dimensions.map((field) => ({ field })),
            metrics: args.metrics,
            filters: args.filters ?? [],
            ...(args.granularity ? { timeDimension: { granularity: args.granularity } } : {}),
            fromTimestamp: window.from,
            toTimestamp: window.to,
            ...(args.orderBy ? { orderBy: args.orderBy } : {}),
            config: {
              row_limit: args.rowLimit,
              ...(args.histogramBins ? { bins: args.histogramBins } : {}),
            },
          };
          const res = await client.get<{ data?: unknown[] }>("/api/public/v2/metrics", {
            query: JSON.stringify(query),
          });
          const rows = res.data ?? [];
          return {
            from: window.from,
            to: window.to,
            rows,
            ...(rows.length >= args.rowLimit
              ? { note: `Hit rowLimit (${args.rowLimit}); raise it or narrow the query.` }
              : {}),
          };
        }),
      ),
  );
};
