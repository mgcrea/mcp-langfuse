// Langfuse public API client, written against a v4 deployment in "events only"
// mode. That mode matters more than anything else here: it removes the read
// endpoints every older Langfuse client is built on — GET /traces,
// /traces/{id}, /sessions, /observations (v1) and /scores (v1 and v2) all
// answer 404 with "not available on deployments running in Langfuse v4
// events_only mode". What survives, and what this client uses:
//
//   GET /api/public/v2/observations   cursor-paginated, field groups, JSON `filter`
//   GET /api/public/v2/metrics        aggregate queries (no traces view)
//   GET /api/public/v3/scores         cursor-paginated
//   GET /api/public/v2/prompts        page-numbered
//   GET /api/public/projects          the one project the key belongs to
//
// A trace is reconstructed from its observations; a session from its root
// observations. Auth is Basic with the project-scoped key pair, so the key
// alone decides which project every query reads.

import { basicAuthHeader, type Logger } from "#/client/auth";
import { LangfuseApiError, ProjectMismatchError } from "#/client/errors";
import type { FilterCondition } from "#/client/query";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export type Project = { id: string; name: string; organization?: string };

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

const EVENTS_ONLY = /events_only/i;

const upstreamMessage = (body: unknown): string | undefined =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { message?: unknown }).message === "string"
    ? (body as { message: string }).message
    : undefined;

/** The remedy for a failed request: what the caller should change, by status. */
const remedyFor = (status: number, body: unknown): string | undefined => {
  const message = upstreamMessage(body) ?? "";
  if (status === 404 && EVENTS_ONLY.test(message)) {
    return (
      "This Langfuse runs v4 in events-only mode, where /traces, /sessions, /observations " +
      "(v1) and /scores (v1, v2) no longer exist. Use langfuse_list_traces, " +
      "langfuse_get_trace and langfuse_get_session (built on /v2/observations), " +
      "langfuse_list_scores (/v3/scores) or langfuse_query_metrics (/v2/metrics) instead."
    );
  }
  if (status === 401) {
    return (
      "Langfuse rejected the key pair. Check that LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY " +
      "are a matching pair from Project Settings → API Keys, and that LANGFUSE_HOST is the " +
      "instance that issued them — a key from one host is meaningless on another."
    );
  }
  if (status === 403 && /organization key/i.test(message)) {
    return (
      "This is an organization-scoped key. On every Langfuse plan those reach only the " +
      "organization management API, never traces, observations, scores or metrics. Use " +
      "project keys: `pnpm provision` in the mcp-langfuse repo writes one per project."
    );
  }
  if (status === 403) {
    return (
      "Authenticated, but this key cannot reach that resource. Organization-level endpoints " +
      "(/organizations/*, /scim/*) need an organization key, not a project key."
    );
  }
  if (status === 400) {
    return "Langfuse rejected the request parameters; `details` carries its validation errors.";
  }
  return undefined;
};

export type LangfuseClientOptions = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  /** Names or ids the key must resolve to; see ProjectEntry.expect. Empty skips the check. */
  expect?: string[];
  maxRetries: number;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger;
};

export class LangfuseClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly expect: string[];
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private projectPromise: Promise<Project> | undefined;

  constructor(opts: LangfuseClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authorization = basicAuthHeader(opts.publicKey, opts.secretKey);
    this.expect = opts.expect ?? [];
    this.maxRetries = opts.maxRetries;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      // Array params (`environment`) are repeated keys, not a joined string.
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    for (;;) {
      this.logger?.debug?.(`${method} ${url.pathname} (attempt ${attempt + 1})`);
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authorization,
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status} — retrying in ${delay}ms`);
        // Undici holds the connection until an unread body is consumed or
        // cancelled; a dropped one is only freed by garbage collection.
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const upstream = upstreamMessage(parsed);
        const remedy = remedyFor(res.status, parsed);
        throw new LangfuseApiError(
          `${method} ${url.pathname} failed: HTTP ${res.status}${upstream ? ` — ${upstream}` : ""}`,
          {
            status: res.status,
            ...(remedy ? { remedy } : {}),
            // The message already carries `message`; keep only what adds to it.
            ...(typeof parsed === "object" && parsed !== null && "error" in parsed
              ? { errors: (parsed as { error: unknown }).error }
              : typeof parsed === "string"
                ? { errors: parsed.slice(0, 500) }
                : {}),
          },
        );
      }
      return parsed as T;
    }
  }

  /**
   * The project this key belongs to. A project key sees exactly one, so
   * `/projects` is effectively whoami. Cached for the process; a failure is
   * not cached, so a transient error does not stick.
   */
  async project(): Promise<Project> {
    this.projectPromise ??= this.fetchProject().catch((err: unknown) => {
      this.projectPromise = undefined;
      throw err;
    });
    return this.projectPromise;
  }

  private async fetchProject(): Promise<Project> {
    const res = await this.get<{
      data?: { id: string; name: string; organization?: { name?: string } }[];
    }>("/api/public/projects");
    const first = res.data?.[0];
    if (!first) {
      throw new LangfuseApiError("GET /api/public/projects returned no project for this key", {
        status: 200,
        remedy: "Use a project-scoped API key (Project Settings → API Keys).",
      });
    }
    return {
      id: first.id,
      name: first.name,
      ...(first.organization?.name ? { organization: first.organization.name } : {}),
    };
  }

  /** One page of /v2/observations, newest first. `filters` always travel as the JSON `filter`. */
  async observations(opts: {
    filters: FilterCondition[];
    fields: string;
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ data: Record<string, unknown>[]; cursor: string | undefined }> {
    const res = await this.get<{ data?: Record<string, unknown>[]; meta?: { cursor?: string } }>(
      "/api/public/v2/observations",
      {
        fields: opts.fields,
        limit: opts.limit,
        cursor: opts.cursor,
        ...(opts.filters.length ? { filter: JSON.stringify(opts.filters) } : {}),
      },
    );
    return { data: res.data ?? [], cursor: res.meta?.cursor || undefined };
  }

  /**
   * Every matching observation, up to `max`. Bounded by items rather than
   * pages, and it reports when the bound cut it short instead of returning a
   * partial trace that looks whole.
   */
  async allObservations(opts: {
    filters: FilterCondition[];
    fields: string;
    max: number;
  }): Promise<{ data: Record<string, unknown>[]; truncated: boolean }> {
    const data: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.observations({
        filters: opts.filters,
        fields: opts.fields,
        limit: Math.min(1000, opts.max - data.length),
        cursor,
      });
      data.push(...page.data);
      cursor = page.cursor;
    } while (cursor && data.length < opts.max);
    return { data, truncated: cursor !== undefined };
  }

  /** The project, after checking it is the one this key is filed under. */
  async assertProject(): Promise<Project> {
    const project = await this.project();
    const [first] = this.expect;
    if (first !== undefined && !this.expect.some((e) => projectMatches(project, e))) {
      throw new ProjectMismatchError(first, project);
    }
    return project;
  }
}

/** Match by id exactly, or by name ignoring case — "Sales" and "sales" are the same project to a person. */
export const projectMatches = (project: Project, expected: string): boolean =>
  project.id === expected || project.name.toLowerCase() === expected.toLowerCase();
