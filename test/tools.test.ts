import { describe, expect, it } from "vitest";

import { CREDS, EVENTS_ONLY_404, PROJECT, connect, jsonResponse, type Route } from "#test/helpers";

const READ_TOOLS = [
  "langfuse_auth_status",
  "langfuse_get_observation",
  "langfuse_get_prompt",
  "langfuse_get_session",
  "langfuse_get_trace",
  "langfuse_list_observations",
  "langfuse_list_prompts",
  "langfuse_list_scores",
  "langfuse_list_traces",
  "langfuse_query_metrics",
  "langfuse_request",
];

const OBS = "/api/public/v2/observations";

describe("with no credentials configured", () => {
  // The regression that produces "MCP error -32000: Connection closed": a server
  // that exits on startup takes the credential-free tools with it and leaves no
  // way to discover what to configure.
  it("still connects, and serves the tools that need no credentials", async () => {
    const names = await (await connect({})).toolNames();
    expect(names).toEqual(["langfuse_auth_status"]);
  });

  it("answers langfuse_auth_status as a setup guide, without touching the network", async () => {
    const harness = await connect({});
    const res = await harness.call("langfuse_auth_status");
    expect(res.configured).toBe(false);
    expect((res.setup as string[]).join(" ")).toContain("LANGFUSE_PUBLIC_KEY");
    expect(harness.paths()).toEqual([]);
  });

  it("needs both halves of the key pair", async () => {
    const names = await (await connect({ LANGFUSE_PUBLIC_KEY: "pk-lf-x" })).toolNames();
    expect(names).toEqual(["langfuse_auth_status"]);
  });
});

describe("tool registration matrix", () => {
  it("registers exactly the read tools with credentials", async () => {
    expect(await (await connect()).toolNames()).toEqual(READ_TOOLS);
  });

  it("only widens the escape hatch when writes are on — there are no named write tools", async () => {
    const off = await connect();
    const on = await connect({ ...CREDS, LANGFUSE_ALLOW_WRITES: "1" });
    expect(await on.toolNames()).toEqual(READ_TOOLS);

    const methodsOf = async (h: typeof off) =>
      (
        ((await h.tool("langfuse_request"))?.inputSchema.properties ?? {}) as Record<
          string,
          { enum?: string[] }
        >
      ).method?.enum;
    expect(await methodsOf(off)).toEqual(["GET"]);
    expect(await methodsOf(on)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    expect((await off.tool("langfuse_request"))?.annotations).toMatchObject({ readOnlyHint: true });
    expect((await on.tool("langfuse_request"))?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });
});

describe("langfuse_auth_status", () => {
  it("names the project each key reads and detects events-only mode", async () => {
    const harness = await connect(CREDS, (url) => {
      if (url.pathname === "/api/public/health") {
        return jsonResponse({ status: "OK", version: "4.63.0" });
      }
      if (url.pathname === "/api/public/traces") return EVENTS_ONLY_404();
      return undefined;
    });
    const res = await harness.call("langfuse_auth_status");
    expect(res).toMatchObject({
      configured: true,
      host: "https://cloud.langfuse.com",
      langfuseVersion: "4.63.0",
      eventsOnly: true,
      projects: [
        {
          name: "default",
          source: "LANGFUSE_PUBLIC_KEY",
          publicKey: "pk-lf-test…",
          ok: true,
          resolvesTo: { id: "proj-ops", name: "ops-team", organization: "acme" },
        },
      ],
    });
    expect(JSON.stringify(res)).not.toContain("sk-lf-test");
  });

  it("flags a key filed under the wrong project, and says what it really reads", async () => {
    const res = await (
      await connect({ ...CREDS, LANGFUSE_PROJECT: "sales" })
    ).call("langfuse_auth_status");
    expect((res.projects as Record<string, unknown>[])[0]).toMatchObject({
      name: "sales",
      ok: false,
      resolvesTo: { name: "ops-team" },
    });
  });

  it("recognises an organization key instead of reporting a bare 403", async () => {
    const res = await (
      await connect(CREDS, (url) =>
        url.pathname === "/api/public/projects"
          ? jsonResponse(
              { message: "Invalid API key. Are you using an organization key?" },
              { status: 403 },
            )
          : undefined,
      )
    ).call("langfuse_auth_status");
    const [entry] = res.projects as Record<string, string>[];
    expect(entry?.ok).toBe(false);
    expect(entry?.remedy).toContain("organization-scoped key");
  });
});

/** Two projects, told apart by the public key in the Basic auth header. */
const MULTI = {
  LANGFUSE_PROJECTS: JSON.stringify({
    sales: { id: "proj-sales", publicKey: "pk-lf-sales", secretKey: "sk-lf-sales" },
    "ops-team": { publicKey: "pk-lf-ops", secretKey: "sk-lf-ops" },
  }),
};

/** The public key a request authenticated with. */
const userOf = (init: RequestInit): string | undefined => {
  const auth = String((init.headers as Record<string, string>).Authorization);
  return Buffer.from(auth.replace("Basic ", ""), "base64").toString().split(":")[0];
};

const byKey: Route = (url, init) => {
  if (url.pathname !== "/api/public/projects") return undefined;
  const project =
    userOf(init) === "pk-lf-sales"
      ? { id: "proj-sales", name: "Sales", organization: { id: "org", name: "acme" } }
      : PROJECT;
  return jsonResponse({ data: [project] });
};

describe("several projects in one server", () => {
  it("requires `project` on every data tool and lists the configured names", async () => {
    const harness = await connect(MULTI, byKey);
    expect(await harness.toolNames()).toEqual(READ_TOOLS);
    const schema = (await harness.tool("langfuse_list_traces"))?.inputSchema as {
      required?: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toContain("project");
    expect(schema.properties.project?.enum).toEqual(["ops-team", "sales"]);

    const res = await harness.call("langfuse_list_traces", {});
    expect(res.isToolError).toBe(true);
    expect(harness.paths()).toEqual([]);
  });

  it("reads each project with its own key and stamps the project it really read", async () => {
    const harness = await connect(MULTI, byKey);
    expect((await harness.call("langfuse_list_traces", { project: "sales" })).project).toBe(
      "Sales",
    );
    expect((await harness.call("langfuse_list_traces", { project: "ops-team" })).project).toBe(
      "ops-team",
    );
    const users = harness
      .authorizations()
      .map((a) => Buffer.from(a.replace("Basic ", ""), "base64").toString().split(":")[0]);
    expect(new Set(users)).toEqual(new Set(["pk-lf-sales", "pk-lf-ops"]));
  });

  it("refuses a key filed under a name it does not belong to — the guard is always on here", async () => {
    const harness = await connect(
      {
        LANGFUSE_PROJECTS: JSON.stringify({
          sales: { publicKey: "pk-lf-ops", secretKey: "sk-lf-ops" },
          "ops-team": { publicKey: "pk-lf-ops", secretKey: "sk-lf-ops" },
        }),
      },
      byKey,
    );
    const res = await harness.call("langfuse_list_traces", { project: "sales" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain('configured for "sales" belongs to Langfuse project "ops-team"');
    expect(harness.paths()).toEqual(["/api/public/projects"]);
  });

  it("reports every project in langfuse_auth_status, a failing one without hiding the rest", async () => {
    // The sales key is revoked; the ops key still works.
    const res = await (
      await connect(MULTI, (url, init) =>
        url.pathname === "/api/public/projects" && userOf(init) === "pk-lf-sales"
          ? jsonResponse({ message: "Invalid credentials" }, { status: 401 })
          : undefined,
      )
    ).call("langfuse_auth_status");
    const projects = res.projects as Record<string, unknown>[];
    expect(projects.map((p) => [p.name, p.ok])).toEqual([
      ["ops-team", true],
      ["sales", false],
    ]);
  });
});

describe("project guard", () => {
  // The incident this server exists to prevent: an MCP wired to the wrong
  // project's key answered every question, with the wrong project's data.
  it("refuses to read anything when the key resolves to another project", async () => {
    const harness = await connect({ ...CREDS, LANGFUSE_PROJECT: "Sales" });
    const res = await harness.call("langfuse_list_traces");
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain('belongs to Langfuse project "ops-team"');
    expect(res.remedy).toContain("project-scoped");
    expect(harness.paths()).toEqual(["/api/public/projects"]);
  });

  it("matches the expected project by name ignoring case, or by id", async () => {
    for (const expected of ["OPS-Team", "proj-ops"]) {
      const res = await (
        await connect({ ...CREDS, LANGFUSE_PROJECT: expected })
      ).call("langfuse_list_traces");
      expect(res.isToolError, expected).toBe(false);
    }
  });

  it("stamps the project on every data response and resolves it only once", async () => {
    const harness = await connect();
    expect((await harness.call("langfuse_list_traces")).project).toBe("ops-team");
    expect((await harness.call("langfuse_list_observations")).project).toBe("ops-team");
    expect(harness.paths().filter((p) => p === "/api/public/projects")).toHaveLength(1);
  });
});

describe("langfuse_list_traces", () => {
  it("lists root observations through the JSON filter only, with a window relative to now", async () => {
    const harness = await connect();
    await harness.call("langfuse_list_traces", {
      since: "24h",
      name: "checkout-agent",
      tags: ["sales"],
      limit: 10,
    });
    expect(harness.filterOf(OBS)).toEqual([
      { type: "string", column: "traceName", operator: "=", value: "checkout-agent" },
      { type: "arrayOptions", column: "tags", operator: "all of", value: ["sales"] },
      { type: "boolean", column: "isRootObservation", operator: "=", value: true },
      { type: "datetime", column: "startTime", operator: ">=", value: "2026-10-29T12:00:00.000Z" },
    ]);
    const params = harness.paramsOf(OBS)!;
    // Plain filter params are silently ignored once `filter` is present, so none are sent.
    expect([...params.keys()].toSorted()).toEqual(["fields", "filter", "limit"]);
    expect(params.get("fields")).toBe("core,basic,metrics,trace_context");
  });

  it("returns compact rows and the next cursor", async () => {
    const harness = await connect(CREDS, (url) =>
      url.pathname === OBS
        ? jsonResponse({
            data: [
              {
                id: "root1",
                traceId: "t1",
                type: "AGENT",
                name: "agent",
                traceName: "checkout-agent",
                startTime: "2026-10-30T10:00:00Z",
                latency: 4.5,
                level: "DEFAULT",
                statusMessage: "",
                userId: "",
                sessionId: "s1",
                environment: "production",
                tags: ["sales"],
                modelId: null,
                inputPrice: null,
                projectId: "proj-ops",
              },
            ],
            meta: { cursor: "abc" },
          })
        : undefined,
    );
    const res = await harness.call("langfuse_list_traces");
    expect(res.traces).toEqual([
      {
        traceId: "t1",
        name: "checkout-agent",
        startTime: "2026-10-30T10:00:00Z",
        latency: 4.5,
        sessionId: "s1",
        environment: "production",
        tags: ["sales"],
      },
    ]);
    expect(res.nextCursor).toBe("abc");
  });

  it("sends Basic auth built from the key pair", async () => {
    const harness = await connect();
    await harness.call("langfuse_list_traces");
    expect(harness.headerAt(0, "Authorization")).toBe(
      `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
    );
  });
});

describe("langfuse_get_trace", () => {
  const observations = [
    // Newest first, as the API returns them. The root is an SDK "app root"
    // whose parent lives outside the trace.
    {
      id: "gen",
      traceId: "t1",
      parentObservationId: "chain",
      type: "GENERATION",
      name: "ChatOpenAI",
      startTime: "2026-10-30T10:00:02Z",
      endTime: "2026-10-30T10:00:05Z",
      model: "gpt",
      usageDetails: { input: 100, output: 20, total: 120 },
      totalCost: 0.01,
      input: '[{"role":"user","content":"hi"}]',
      output: '{"role":"assistant","content":"hello"}',
      level: "DEFAULT",
    },
    {
      id: "tool",
      traceId: "t1",
      parentObservationId: "root",
      type: "TOOL",
      name: "lookup",
      startTime: "2026-10-30T10:00:06Z",
      endTime: "2026-10-30T10:00:07Z",
      level: "ERROR",
      statusMessage: "timeout",
      input: null,
      output: null,
    },
    {
      id: "chain",
      traceId: "t1",
      parentObservationId: "root",
      type: "CHAIN",
      name: "model",
      startTime: "2026-10-30T10:00:01Z",
      endTime: "2026-10-30T10:00:05Z",
      input: '{"q":"hi"}',
      output: null,
      level: "DEFAULT",
    },
    {
      id: "root",
      traceId: "t1",
      parentObservationId: "external",
      type: "AGENT",
      name: "agent",
      traceName: "checkout-agent",
      sessionId: "s1",
      tags: ["sales"],
      startTime: "2026-10-30T10:00:00Z",
      endTime: "2026-10-30T10:00:08Z",
      input: null,
      output: null,
      level: "DEFAULT",
    },
  ];

  it("rebuilds the tree depth-first, with totals and the first input/output found", async () => {
    const harness = await connect(CREDS, (url) =>
      url.pathname === OBS ? jsonResponse({ data: observations, meta: {} }) : undefined,
    );
    const res = await harness.call("langfuse_get_trace", { traceId: "t1" });
    expect(res.isToolError).toBe(false);
    expect(
      (res.observations as { id: string; depth: number }[]).map((o) => [o.id, o.depth]),
    ).toEqual([
      ["root", 0],
      ["chain", 1],
      ["gen", 2],
      ["tool", 1],
    ]);
    expect(res).toMatchObject({
      project: "ops-team",
      traceId: "t1",
      name: "checkout-agent",
      sessionId: "s1",
      startTime: "2026-10-30T10:00:00Z",
      endTime: "2026-10-30T10:00:08Z",
      observationCount: 4,
      usage: { input: 100, output: 20, total: 120 },
      cost: 0.01,
      errors: [{ id: "tool", name: "lookup", statusMessage: "timeout" }],
      input: { q: "hi" },
      output: { role: "assistant", content: "hello" },
    });
    // Trace-level fields are reported once, not on every row; io is off per row by default.
    const gen = (res.observations as Record<string, unknown>[])[2]!;
    expect(gen).toEqual({
      depth: 2,
      id: "gen",
      type: "GENERATION",
      name: "ChatOpenAI",
      startTime: "2026-10-30T10:00:02Z",
      model: "gpt",
      usage: { input: 100, output: 20, total: 120 },
      cost: 0.01,
    });
    expect(harness.filterOf(OBS)).toEqual([
      { type: "string", column: "traceId", operator: "=", value: "t1" },
    ]);
    expect(harness.paramsOf(OBS)?.get("limit")).toBe("500");
  });

  it("says which project it looked in when the trace is not there", async () => {
    const res = await (await connect()).call("langfuse_get_trace", { traceId: "missing" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain('in Langfuse project "ops-team"');
    expect(res.remedy).toContain("project-scoped");
  });

  it("follows the cursor and reports when maxObservations cut it short", async () => {
    let page = 0;
    const harness = await connect(CREDS, (url) => {
      if (url.pathname !== OBS) return undefined;
      page += 1;
      return jsonResponse({ data: [observations[page - 1]], meta: { cursor: `c${page}` } });
    });
    const res = await harness.call("langfuse_get_trace", { traceId: "t1", maxObservations: 2 });
    expect(res.observationCount).toBe(2);
    expect(res.truncated).toBe(true);
    expect(harness.paths().filter((p) => p === OBS)).toHaveLength(2);
  });
});

describe("langfuse_get_session", () => {
  it("returns one turn per trace, oldest first", async () => {
    const harness = await connect(CREDS, (url) =>
      url.pathname === OBS
        ? jsonResponse({
            data: [
              {
                id: "b",
                traceId: "t2",
                type: "AGENT",
                traceName: "chat",
                sessionId: "s1",
                startTime: "2026-10-30T11:00:00Z",
                input: '"second"',
                output: '"answer 2"',
              },
              {
                id: "a",
                traceId: "t1",
                type: "AGENT",
                traceName: "chat",
                sessionId: "s1",
                startTime: "2026-10-30T10:00:00Z",
                input: '"first"',
                output: '"answer 1"',
              },
            ],
            meta: {},
          })
        : undefined,
    );
    const res = await harness.call("langfuse_get_session", { sessionId: "s1" });
    expect(res.turnCount).toBe(2);
    expect(
      (res.turns as { traceId: string; input: unknown }[]).map((t) => [t.traceId, t.input]),
    ).toEqual([
      ["t1", "first"],
      ["t2", "second"],
    ]);
    expect(harness.filterOf(OBS)).toEqual([
      { type: "string", column: "sessionId", operator: "=", value: "s1" },
    ]);
  });
});

describe("langfuse_get_observation", () => {
  it("looks the id up within its trace and returns the full object, io clipped", async () => {
    const harness = await connect(CREDS, (url) =>
      url.pathname === OBS
        ? jsonResponse({
            data: [
              {
                id: "gen",
                traceId: "t1",
                projectId: "proj-ops",
                modelId: null,
                input: "x".repeat(50),
                output: '{"ok":true}',
                metadata: { a: 1 },
              },
            ],
            meta: {},
          })
        : undefined,
    );
    const res = await harness.call("langfuse_get_observation", {
      observationId: "gen",
      traceId: "t1",
      maxChars: 20,
    });
    expect(harness.filterOf(OBS)).toEqual([
      { type: "string", column: "traceId", operator: "=", value: "t1" },
      { type: "string", column: "id", operator: "=", value: "gen" },
    ]);
    expect(res.observation).toEqual({
      id: "gen",
      traceId: "t1",
      metadata: { a: 1 },
      input: "xxxxxxxxxxxxxxxxxxxx… [truncated: 50 chars total]",
      output: { ok: true },
    });
  });

  it("rejects a relative savePath", async () => {
    const res = await (
      await connect()
    ).call("langfuse_get_observation", { observationId: "x", savePath: "out.json" });
    expect(res.error).toContain("savePath must be absolute");
  });
});

describe("langfuse_list_scores", () => {
  it("uses /v3/scores with comma-joined lists", async () => {
    const harness = await connect();
    await harness.call("langfuse_list_scores", {
      traceId: "t1",
      name: ["a", "b"],
      source: ["EVAL"],
    });
    const params = harness.paramsOf("/api/public/v3/scores")!;
    expect(Object.fromEntries(params)).toEqual({
      fields: "details,subject,annotation",
      traceId: "t1",
      name: "a,b",
      source: "EVAL",
      limit: "25",
    });
  });
});

describe("langfuse_query_metrics", () => {
  it("defaults to the last 24h and sends one JSON query", async () => {
    const harness = await connect(CREDS, (url) =>
      url.pathname === "/api/public/v2/metrics"
        ? jsonResponse({ data: [{ traceName: "x", count_count: 3 }] })
        : undefined,
    );
    const res = await harness.call("langfuse_query_metrics", {
      metrics: [{ measure: "count", aggregation: "count" }],
      dimensions: ["traceName"],
    });
    expect(res.rows).toEqual([{ traceName: "x", count_count: 3 }]);
    expect(JSON.parse(harness.paramsOf("/api/public/v2/metrics")!.get("query")!)).toEqual({
      view: "observations",
      dimensions: [{ field: "traceName" }],
      metrics: [{ measure: "count", aggregation: "count" }],
      filters: [],
      fromTimestamp: "2026-10-29T12:00:00.000Z",
      toTimestamp: "2026-10-30T12:00:00.000Z",
      config: { row_limit: 100 },
    });
  });
});

describe("errors", () => {
  it("turns an events-only 404 into a pointer at the tools that still work", async () => {
    const res = await (
      await connect(CREDS, (url) =>
        url.pathname === "/api/public/traces" ? EVENTS_ONLY_404() : undefined,
      )
    ).call("langfuse_request", { path: "/api/public/traces" });
    expect(res.isToolError).toBe(true);
    expect(res.status).toBe(404);
    expect(res.remedy).toContain("langfuse_list_traces");
  });

  it("explains a 401 as a key/host mismatch", async () => {
    const res = await (
      await connect(CREDS, () => jsonResponse({ message: "Invalid credentials" }, { status: 401 }))
    ).call("langfuse_list_traces");
    expect(res.status).toBe(401);
    expect(res.remedy).toContain("LANGFUSE_HOST");
  });
});

describe("langfuse_request", () => {
  it("refuses writes at the schema when the flag is off", async () => {
    const res = await (
      await connect()
    ).call("langfuse_request", { method: "POST", path: "/api/public/scores", body: {} });
    expect(res.isToolError).toBe(true);
  });

  it("refuses paths outside /api/public and traversal", async () => {
    const harness = await connect();
    for (const path of [
      "/api/admin/x",
      "/api/public/../admin",
      "https://evil.example/api/public/x",
    ]) {
      expect((await harness.call("langfuse_request", { path })).isToolError, path).toBe(true);
    }
    expect(harness.paths()).not.toContain("/api/admin/x");
  });

  it("passes writes through when the flag is on", async () => {
    const harness = await connect({ ...CREDS, LANGFUSE_ALLOW_WRITES: "1" });
    const res = await harness.call("langfuse_request", {
      method: "POST",
      path: "/api/public/comments",
      body: { a: 1 },
    });
    expect(res.isToolError).toBe(false);
    expect(harness.paths()).toContain("/api/public/comments");
  });
});

/**
 * The contract every tool owes the model, enforced mechanically.
 *
 * These are cheap and they fail the moment a new tool forgets one, which is the
 * only time anyone would notice: a missing `.describe()` is invisible in review
 * and invisible at runtime, and simply makes the model guess.
 */
describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    // `title` is what a host renders in its permission dialog, so a bare
    // "Cancel Order" re-creates the cross-server collision the name prefix
    // exists to prevent.
    const harness = await connect({ ...CREDS, LANGFUSE_ALLOW_WRITES: "1" });
    const tools = (await harness.client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.title, tool.name).toMatch(/^Langfuse: /);
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    const harness = await connect({ ...CREDS, LANGFUSE_ALLOW_WRITES: "1" });
    for (const tool of (await harness.client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool", async () => {
    const harness = await connect({ ...CREDS, LANGFUSE_ALLOW_WRITES: "1" });
    for (const tool of (await harness.client.listTools()).tools) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });
});
