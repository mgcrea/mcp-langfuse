// Query construction for /v2/observations and /v2/metrics. Pure — no I/O.
//
// /v2/observations takes its filters two ways: plain query params (`userId`,
// `traceId`, …) or one JSON `filter` array. When `filter` is present it wins
// and the plain params are IGNORED, silently. Mixing the two therefore drops
// filters without an error, so this module always builds the JSON array and
// the tools never set the plain params at all.

export type FilterCondition = {
  type: string;
  column: string;
  operator: string;
  value?: unknown;
  key?: string;
};

export type ObservationFilterInput = {
  traceId?: string | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  name?: string | undefined;
  traceName?: string | undefined;
  type?: string | undefined;
  level?: string | undefined;
  model?: string | undefined;
  environment?: string[] | undefined;
  tags?: string[] | undefined;
  rootOnly?: boolean | undefined;
  from?: string | undefined;
  to?: string | undefined;
  minLatencySeconds?: number | undefined;
  inputMatches?: string | undefined;
  outputMatches?: string | undefined;
  extra?: FilterCondition[] | undefined;
};

const eq = (column: string, value: string): FilterCondition => ({
  type: "string",
  column,
  operator: "=",
  value,
});

export const observationFilters = (f: ObservationFilterInput): FilterCondition[] => {
  const out: FilterCondition[] = [];
  if (f.traceId) out.push(eq("traceId", f.traceId));
  if (f.sessionId) out.push(eq("sessionId", f.sessionId));
  if (f.userId) out.push(eq("userId", f.userId));
  if (f.name) out.push(eq("name", f.name));
  if (f.traceName) out.push(eq("traceName", f.traceName));
  if (f.type) out.push(eq("type", f.type));
  if (f.level) out.push(eq("level", f.level));
  if (f.model) out.push(eq("model", f.model));
  if (f.environment?.length) {
    out.push({
      type: "stringOptions",
      column: "environment",
      operator: "any of",
      value: f.environment,
    });
  }
  if (f.tags?.length) {
    out.push({ type: "arrayOptions", column: "tags", operator: "all of", value: f.tags });
  }
  if (f.rootOnly) {
    out.push({ type: "boolean", column: "isRootObservation", operator: "=", value: true });
  }
  if (f.from) out.push({ type: "datetime", column: "startTime", operator: ">=", value: f.from });
  if (f.to) out.push({ type: "datetime", column: "startTime", operator: "<", value: f.to });
  if (f.minLatencySeconds !== undefined) {
    out.push({ type: "number", column: "latency", operator: ">=", value: f.minLatencySeconds });
  }
  // `matches` is the indexed literal search, and the only text operator v2
  // accepts on input/output without another `=`/`matches` beside it.
  if (f.inputMatches)
    out.push({ type: "string", column: "input", operator: "matches", value: f.inputMatches });
  if (f.outputMatches)
    out.push({ type: "string", column: "output", operator: "matches", value: f.outputMatches });
  if (f.extra) out.push(...f.extra);
  return out;
};

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
export const DURATION = /^(\d+)\s*([mhdw])$/;

/** "30m" | "24h" | "7d" | "2w" → milliseconds. */
export const parseDuration = (value: string): number => {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}": use a number and m/h/d/w, e.g. "24h".`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
};

/**
 * Resolve a time window. An absolute `from` beats a relative `since`; `to`
 * defaults to open-ended unless `requireTo` (the metrics API needs both ends).
 * Relative windows exist because a model rarely knows today's date, and
 * guessing one is how a "last 24 hours" query lands on last year.
 */
export const resolveWindow = (
  w: { since?: string | undefined; from?: string | undefined; to?: string | undefined },
  now: Date,
  opts: { requireTo?: boolean } = {},
): { from?: string; to?: string } => {
  const from =
    w.from ??
    (w.since ? new Date(now.getTime() - parseDuration(w.since)).toISOString() : undefined);
  const to = w.to ?? (opts.requireTo ? now.toISOString() : undefined);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
};
