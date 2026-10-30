import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * The keys file every test reads unless it passes its own. A path that cannot
 * exist: without it the developer's real ~/.config/langfuse-mcp/keys.json
 * leaks into the suite, which then passes on the machine that has keys and
 * fails in CI — or, worse, the reverse.
 */
export const ABSENT_KEYS_FILE = "/nonexistent/langfuse-mcp/keys.json";

export const NOW = new Date("2026-10-30T12:00:00.000Z");

export const CREDS = { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" };

export const PROJECT = {
  id: "proj-ops",
  name: "ops-team",
  organization: { id: "org", name: "acme" },
  metadata: {},
};

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

export const EVENTS_ONLY_404 = (): Response =>
  jsonResponse(
    {
      message:
        "This endpoint is not available on deployments running in Langfuse v4 events_only mode. Learn more about Langfuse v4 at: https://langfuse.com/docs/v4",
    },
    { status: 404 },
  );

/** Route a request to a canned response; return undefined to fall through to the defaults. */
export type Route = (url: URL, init: RequestInit) => Response | undefined;

/** /projects answers with PROJECT, everything else with an empty page. */
const defaults: Route = (url) =>
  url.pathname === "/api/public/projects"
    ? jsonResponse({ data: [PROJECT] })
    : jsonResponse({ data: [], meta: {} });

export const connect = async (
  env: Record<string, string> = CREDS,
  route?: Route,
  keysFile: string = ABSENT_KEYS_FILE,
) => {
  const config: Config = loadConfig(env, keysFile);
  const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
    const url = new URL(String(input));
    const req = (init ?? {}) as RequestInit;
    return route?.(url, req) ?? defaults(url, req)!;
  });
  const { server } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const urls = (): URL[] => fetchMock.mock.calls.map((c) => new URL(String(c[0])));

  return {
    client,
    /**
     * Primitives rather than the mock itself: a vitest mock's type drags
     * @vitest/spy internals into this function's inferred return type, and
     * `tsc --noEmit` then fails with TS2883.
     */
    paths: (): string[] => urls().map((u) => u.pathname),
    /** Query params of the first request to `pathname`. */
    paramsOf: (pathname: string): URLSearchParams | undefined =>
      urls().find((u) => u.pathname === pathname)?.searchParams,
    /** The parsed JSON `filter` of the first request to `pathname`. */
    filterOf: (pathname: string): unknown => {
      const raw = urls()
        .find((u) => u.pathname === pathname)
        ?.searchParams.get("filter");
      return raw ? JSON.parse(raw) : undefined;
    },
    /** The Authorization header of every request, in order. */
    authorizations: (): string[] =>
      fetchMock.mock.calls.map((c) =>
        String(((c[1] ?? {}) as { headers?: Record<string, string> }).headers?.Authorization),
      ),
    headerAt: (index: number, name: string): string | undefined => {
      const headers = ((fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit).headers as
        | Record<string, string>
        | undefined;
      return headers?.[name];
    },
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};
