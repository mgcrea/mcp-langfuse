import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LangfuseClient } from "#/client/langfuse";
import { parseDuration, resolveWindow } from "#/client/query";
import { cleanMetadata, clip, orderAsTree } from "#/client/shape";
import { loadConfig, setupInstructions } from "#/config";
import { ABSENT_KEYS_FILE } from "#test/helpers";

describe("clip", () => {
  it("parses a JSON string that fits, since an embedded JSON string escapes every quote", () => {
    expect(clip('{"a":[1,2]}', 100)).toEqual({ a: [1, 2] });
    expect(clip('"just text"', 100)).toBe("just text");
    expect(clip("true", 100)).toBe("true");
    expect(clip("not json", 100)).toBe("not json");
  });

  it("cuts an overlong value and says how long it was", () => {
    expect(clip("abcdef", 3)).toBe("abc… [truncated: 6 chars total]");
  });

  it("drops empty values", () => {
    expect(clip(null, 10)).toBeUndefined();
    expect(clip("", 10)).toBeUndefined();
  });
});

describe("cleanMetadata", () => {
  it("drops the OpenTelemetry scope/resource attributes, which carry the public key", () => {
    expect(
      cleanMetadata({
        thread_id: "t",
        "scope.attributes.public_key": "pk-lf-x",
        "resourceAttributes.service.name": "svc",
        empty: "",
      }),
    ).toEqual({ thread_id: "t" });
  });
});

describe("orderAsTree", () => {
  it("keeps observations caught in a parent cycle, without looping", () => {
    const out = orderAsTree([
      { id: "a", parentObservationId: "b", startTime: "1" },
      { id: "b", parentObservationId: "a", startTime: "2" },
    ]);
    // Neither is a root, so no walk reaches them — they must still be listed, once each.
    expect(out.map((e) => [e.observation.id, e.depth])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });
});

describe("LangfuseClient retries", () => {
  it("retries a 503 and releases its body first, so the socket is not held until GC", async () => {
    let cancelled = false;
    const responses = [
      new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), {
        status: 503,
        headers: { "Retry-After": "0" },
      }),
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    ];
    const client = new LangfuseClient({
      baseUrl: "https://lf.example.com",
      publicKey: "pk-lf-x",
      secretKey: "sk-lf-x",
      maxRetries: 1,
      userAgent: "test",
      fetch: async () => responses.shift()!,
    });
    expect(await client.get("/api/public/health")).toEqual({ ok: 1 });
    expect(cancelled).toBe(true);
  });

  it("fails fast when Retry-After asks for longer than one call should wait", async () => {
    let calls = 0;
    const client = new LangfuseClient({
      baseUrl: "https://lf.example.com",
      publicKey: "pk-lf-x",
      secretKey: "sk-lf-x",
      maxRetries: 3,
      userAgent: "test",
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 429, headers: { "Retry-After": "600" } });
      },
    });
    await expect(client.get("/api/public/health")).rejects.toMatchObject({
      status: 429,
      remedy: expect.stringContaining("600 s"),
    });
    expect(calls).toBe(1);
  });
});

describe("time windows", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");

  it("parses m/h/d/w durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(() => parseDuration("1y")).toThrow(/m\/h\/d\/w/);
  });

  it("lets an absolute from beat a relative since", () => {
    expect(resolveWindow({ since: "1h", from: "2026-01-01T00:00:00Z" }, now)).toEqual({
      from: "2026-01-01T00:00:00Z",
    });
    expect(resolveWindow({ since: "1h" }, now, { requireTo: true })).toEqual({
      from: "2026-10-30T11:00:00.000Z",
      to: "2026-10-30T12:00:00.000Z",
    });
  });
});

describe("loadConfig", () => {
  it("reads the env names the Python langfuse-mcp uses, with LANGFUSE_BASE_URL as an alias", () => {
    expect(
      loadConfig({ LANGFUSE_HOST: "https://langfuse.example.com/" }, ABSENT_KEYS_FILE).baseUrl,
    ).toBe("https://langfuse.example.com");
    expect(
      loadConfig({ LANGFUSE_BASE_URL: "https://b.example.com" }, ABSENT_KEYS_FILE).baseUrl,
    ).toBe("https://b.example.com");
    expect(loadConfig({}, ABSENT_KEYS_FILE).baseUrl).toBe("https://cloud.langfuse.com");
  });

  it("flags swapped keys instead of letting them fail as a bare 401", () => {
    const config = loadConfig(
      { LANGFUSE_PUBLIC_KEY: "sk-lf-a", LANGFUSE_SECRET_KEY: "pk-lf-b" },
      ABSENT_KEYS_FILE,
    );
    expect(setupInstructions(config).join(" ")).toContain("look swapped");
  });

  it("treats an empty variable as unset", () => {
    expect(
      loadConfig(
        { LANGFUSE_PUBLIC_KEY: "  ", LANGFUSE_SECRET_KEY: "sk-lf-x", LANGFUSE_ALLOW_WRITES: "" },
        ABSENT_KEYS_FILE,
      ),
    ).toMatchObject({ projects: [], allowWrites: false });
  });
});

const pair = (id: string) => ({ id, publicKey: `pk-lf-${id}`, secretKey: `sk-lf-${id}` });

describe("loadConfig with a keys file", () => {
  const dir = mkdtempSync(join(tmpdir(), "langfuse-mcp-"));
  const write = (name: string, body: unknown, mode = 0o600): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode });
    chmodSync(path, mode);
    return path;
  };

  it("serves every project in the file, checked against both its name and its id", () => {
    const path = write("ok.json", {
      host: "https://lf.example.com",
      projects: { sales: pair("p1"), ops: pair("p2") },
    });
    const config = loadConfig({}, path);
    expect(config.baseUrl).toBe("https://lf.example.com");
    expect(config.problems).toEqual([]);
    expect(config.projects.map((p) => [p.name, p.expect, p.source])).toEqual([
      ["ops", ["ops", "p2"], "keys file"],
      ["sales", ["sales", "p1"], "keys file"],
    ]);
  });

  it("lets the environment win, per project and for the host", () => {
    const path = write("env.json", {
      host: "https://file.example.com",
      projects: { sales: pair("p1") },
    });
    const config = loadConfig(
      {
        LANGFUSE_HOST: "https://env.example.com",
        LANGFUSE_PROJECTS: JSON.stringify({ sales: pair("p9") }),
      },
      path,
    );
    expect(config.baseUrl).toBe("https://env.example.com");
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]).toMatchObject({
      publicKey: "pk-lf-p9",
      source: "LANGFUSE_PROJECTS",
    });
  });

  it("reports a malformed file instead of throwing — a server that exits is a bare 'Connection closed'", () => {
    expect(loadConfig({}, write("bad.json", "{nope")).problems.join(" ")).toContain(
      "not valid JSON",
    );
    const typo = loadConfig(
      {},
      write("typo.json", { projects: { sales: { publicKey: "pk", secretkey: "sk" } } }),
    );
    expect(typo.projects).toEqual([]);
    expect(typo.problems.join(" ")).toContain("malformed");
  });

  it("warns when the file is readable by other users", () => {
    const config = loadConfig({}, write("open.json", { projects: { sales: pair("p1") } }, 0o644));
    expect(config.problems.join(" ")).toContain("chmod 600");
  });

  it("ignores an unnamed LANGFUSE_PUBLIC_KEY pair alongside other projects, and says why", () => {
    const config = loadConfig(
      { LANGFUSE_PUBLIC_KEY: "pk-lf-x", LANGFUSE_SECRET_KEY: "sk-lf-x" },
      write("mixed.json", { projects: { sales: pair("p1") } }),
    );
    expect(config.projects.map((p) => p.name)).toEqual(["sales"]);
    expect(config.problems.join(" ")).toContain("LANGFUSE_PROJECT");
  });
});
