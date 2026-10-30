// The context-window layer. A v2 observation row carries ~50 fields, most of
// them empty strings, nulls, `{}` or per-row pricing echoes (`modelId`,
// `inputPrice`, …), and its metadata is padded with a dozen OpenTelemetry
// resource/scope attributes — one of which is the project's public key.
// Input and output arrive as JSON-encoded *strings*, routinely 20 KB for a
// single LLM call. Passing that through would spend most of the window on
// nothing, so every tool goes through here:
//
//   - empty values are dropped, never sent as null/""/{}
//   - `level` is only reported when it is not DEFAULT
//   - input/output are cut to a caller-chosen budget, with an honest marker
//   - OTel `scope.*` / `resourceAttributes.*` metadata keys are dropped
//
// get_observation is the exception: it returns the full object, because that
// is the point of a get.

type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

/** Drop undefined/null/""/[]/{} so no response spends tokens on emptiness. */
export const prune = (obj: Rec): Rec =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v)));

const OTEL_NOISE = /^(scope\.|resourceAttributes\.)/;

/** Metadata without the OpenTelemetry resource/scope attributes every span repeats. */
export const cleanMetadata = (metadata: unknown): unknown => {
  if (!isRecord(metadata)) return metadata;
  return prune(Object.fromEntries(Object.entries(metadata).filter(([k]) => !OTEL_NOISE.test(k))));
};

/**
 * Cut an input/output value to `max` characters. v2 returns these as JSON
 * strings; when one fits it is parsed back, because a JSON string embedded in
 * JSON escapes every quote and costs more than the value itself. When it does
 * not fit, the prefix is returned as text with the total length, so a reader
 * knows it is partial and how much is missing.
 */
export const clip = (value: unknown, max: number): unknown => {
  if (value === null || value === undefined || value === "") return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) {
    if (typeof value !== "string") return value;
    try {
      const parsed: unknown = JSON.parse(text);
      // Objects, arrays and JSON-encoded strings unwrap; a bare number or
      // boolean stays text, since "true" as input is more likely prose.
      return typeof parsed === "object" || typeof parsed === "string" ? parsed : text;
    } catch {
      return text;
    }
  }
  return `${text.slice(0, max)}… [truncated: ${text.length} chars total]`;
};

const usageOf = (o: Rec): Rec | undefined => {
  const u = o.usageDetails;
  if (!isRecord(u)) return undefined;
  const nonZero = Object.fromEntries(
    Object.entries(u).filter(([, v]) => typeof v === "number" && v > 0),
  );
  return Object.keys(nonZero).length ? nonZero : undefined;
};

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

const promptRef = (o: Rec): string | undefined =>
  typeof o.promptName === "string" && o.promptName
    ? `${o.promptName}${o.promptVersion != null ? `@${String(o.promptVersion)}` : ""}`
    : undefined;

export type ObservationShape = {
  /** Characters of input/output to keep; 0 drops them. */
  ioChars: number;
  includeMetadata?: boolean;
  /** Fields the caller already reports once at a higher level (e.g. per-trace). */
  omit?: readonly string[];
};

/** One observation as a compact row. Latency is in seconds, as Langfuse reports it here. */
export const summarizeObservation = (o: Rec, shape: ObservationShape): Rec => {
  const row = prune({
    id: o.id,
    traceId: o.traceId,
    parentId: o.parentObservationId,
    type: o.type,
    name: o.name,
    startTime: o.startTime,
    latency: o.latency,
    level: o.level === "DEFAULT" ? undefined : o.level,
    statusMessage: o.statusMessage,
    model: o.model,
    usage: usageOf(o),
    cost: positive(o.totalCost),
    timeToFirstToken: o.timeToFirstToken,
    prompt: promptRef(o),
    userId: o.userId,
    sessionId: o.sessionId,
    environment: o.environment,
    traceName: o.traceName,
    tags: o.tags,
    metadata: shape.includeMetadata ? cleanMetadata(o.metadata) : undefined,
    input: shape.ioChars > 0 ? clip(o.input, shape.ioChars) : undefined,
    output: shape.ioChars > 0 ? clip(o.output, shape.ioChars) : undefined,
  });
  for (const key of shape.omit ?? []) delete row[key];
  return row;
};

/**
 * A trace's root observation as a trace row. Its `name` is the trace name and
 * its `traceId` is the id every trace-level tool takes.
 */
export const summarizeTraceRow = (o: Rec, ioChars: number): Rec =>
  prune({
    traceId: o.traceId,
    name: o.traceName ?? o.name,
    startTime: o.startTime,
    latency: o.latency,
    level: o.level === "DEFAULT" ? undefined : o.level,
    statusMessage: o.statusMessage,
    userId: o.userId,
    sessionId: o.sessionId,
    environment: o.environment,
    tags: o.tags,
    input: ioChars > 0 ? clip(o.input, ioChars) : undefined,
    output: ioChars > 0 ? clip(o.output, ioChars) : undefined,
  });

/**
 * Order a trace's observations depth-first, children by start time, and give
 * each a `depth`. Returned flat: a list with depth is smaller than nesting and
 * reads just as well. An observation whose parent is not in the trace — an SDK
 * "app root" under an external span — is treated as a root, not dropped.
 */
export const orderAsTree = (observations: Rec[]): { observation: Rec; depth: number }[] => {
  const ids = new Set(observations.map((o) => o.id));
  const children = new Map<unknown, Rec[]>();
  const roots: Rec[] = [];
  for (const o of observations) {
    const parent = o.parentObservationId;
    if (parent && ids.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(o);
      children.set(parent, siblings);
    } else {
      roots.push(o);
    }
  }
  const byStart = (a: Rec, b: Rec): number =>
    String(a.startTime).localeCompare(String(b.startTime));
  const out: { observation: Rec; depth: number }[] = [];
  // Iterative, so a pathologically deep trace cannot overflow the stack.
  const stack = roots
    .toSorted(byStart)
    .toReversed()
    .map((o) => ({ o, depth: 0 }));
  const seen = new Set<unknown>();
  while (stack.length) {
    const { o, depth } = stack.pop()!;
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ observation: o, depth });
    const kids = (children.get(o.id) ?? []).toSorted(byStart).toReversed();
    for (const kid of kids) stack.push({ o: kid, depth: depth + 1 });
  }
  // A parent cycle leaves observations no root reaches. Report them at depth 0
  // rather than dropping them, so observationCount and the tree always agree.
  for (const o of observations.toSorted(byStart)) {
    if (!seen.has(o.id)) out.push({ observation: o, depth: 0 });
  }
  return out;
};

const sum = (values: unknown[]): number | undefined => {
  const nums = values.filter((v): v is number => typeof v === "number");
  return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined;
};

/**
 * A whole trace from its observations: trace-level fields once, then the
 * observation tree. `input`/`output` are the first ones found in tree order,
 * because the root is often an AGENT span that carries none itself.
 */
export const summarizeTrace = (
  traceId: string,
  observations: Rec[],
  opts: { traceIoChars: number; observationIoChars: number; includeMetadata: boolean },
): Rec => {
  const tree = orderAsTree(observations);
  const root = tree[0]?.observation ?? {};
  const firstWith = (key: "input" | "output"): unknown =>
    tree.find(({ observation }) => !isEmpty(observation[key]))?.observation[key];
  const starts = observations.map((o) => String(o.startTime)).toSorted();
  const ends = observations
    .map((o) => o.endTime)
    .filter((e): e is string => typeof e === "string")
    .toSorted();
  const usageTotals: Rec = {};
  for (const o of observations) {
    for (const [k, v] of Object.entries(usageOf(o) ?? {})) {
      usageTotals[k] = ((usageTotals[k] as number | undefined) ?? 0) + (v as number);
    }
  }
  const errors = observations.filter((o) => o.level === "ERROR");
  const traceLevel = [
    "traceId",
    "userId",
    "sessionId",
    "environment",
    "traceName",
    "tags",
  ] as const;
  return prune({
    traceId,
    name: root.traceName ?? root.name,
    startTime: starts[0],
    endTime: ends.at(-1),
    userId: root.userId,
    sessionId: root.sessionId,
    environment: root.environment,
    tags: root.tags,
    release: root.release,
    observationCount: observations.length,
    usage: Object.keys(usageTotals).length ? usageTotals : undefined,
    cost: positive(sum(observations.map((o) => o.totalCost))),
    errors: errors.length
      ? errors.map((o) => prune({ id: o.id, name: o.name, statusMessage: o.statusMessage }))
      : undefined,
    input: opts.traceIoChars > 0 ? clip(firstWith("input"), opts.traceIoChars) : undefined,
    output: opts.traceIoChars > 0 ? clip(firstWith("output"), opts.traceIoChars) : undefined,
    observations: tree.map(({ observation, depth }) => ({
      depth,
      ...summarizeObservation(observation, {
        ioChars: opts.observationIoChars,
        includeMetadata: opts.includeMetadata,
        omit: [...traceLevel, "parentId"],
      }),
    })),
  });
};

/** A v3 score without the bookkeeping fields every row repeats. */
export const summarizeScore = (s: Rec): Rec =>
  prune({
    id: s.id,
    name: s.name,
    value: s.value,
    dataType: s.dataType,
    source: s.source,
    timestamp: s.timestamp,
    environment: s.environment === "default" ? undefined : s.environment,
    comment: s.comment,
    subject: s.subject,
    configId: s.configId,
    metadata: s.metadata,
    authorUserId: s.authorUserId,
    queueId: s.queueId,
  });

/** A prompt list entry: which versions exist, which labels point where. */
export const summarizePromptListItem = (p: Rec): Rec =>
  prune({
    name: p.name,
    type: p.type,
    versions: p.versions,
    labels: p.labels,
    tags: p.tags,
    lastUpdatedAt: p.lastUpdatedAt,
    lastConfig: p.lastConfig,
  });
