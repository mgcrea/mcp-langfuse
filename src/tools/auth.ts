import type { McpServer } from "@modelcontextprotocol/server";

import { maskKey } from "#/client/auth";
import { LangfuseApiError, ProjectMismatchError } from "#/client/errors";
import { EVENTS_ONLY, type LangfuseClient } from "#/client/langfuse";
import type { ProjectRegistry } from "#/client/projects";
import { setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/**
 * Probe for v4 events-only mode: the legacy /traces endpoint answers 404 with a
 * message naming the mode. Anything else is reported as unknown rather than
 * guessed, since a 401 here says nothing about the mode.
 */
const detectEventsOnly = async (client: LangfuseClient): Promise<boolean | "unknown"> => {
  try {
    await client.get("/api/public/traces", { limit: 1 });
    return false;
  } catch (err) {
    if (err instanceof LangfuseApiError && err.status === 404 && EVENTS_ONLY.test(err.message)) {
      return true;
    }
    return "unknown";
  }
};

/** One configured project as auth_status reports it: what it is filed as, what it resolves to. */
const describeProject = async (
  name: string,
  client: LangfuseClient,
  ctx: Omit<ToolContext, "projectArg">,
): Promise<Record<string, unknown>> => {
  const entry = ctx.config.projects.find((p) => p.name === name);
  const base = {
    name,
    source: entry?.source,
    publicKey: maskKey(entry?.publicKey),
  };
  try {
    const project = await client.assertProject();
    return { ...base, ok: true, resolvesTo: project };
  } catch (err) {
    if (err instanceof ProjectMismatchError) {
      return {
        ...base,
        ok: false,
        resolvesTo: await client.project(),
        error: err.message,
        remedy: err.remedy,
      };
    }
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof LangfuseApiError && err.remedy ? { remedy: err.remedy } : {}),
    };
  }
};

/**
 * Registered first and unconditionally, so an unconfigured server is still a
 * useful one rather than a connection that closes.
 */
export const registerAuthTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: Omit<ToolContext, "projectArg">,
): void => {
  server.registerTool(
    "langfuse_auth_status",
    {
      title: "Langfuse: Auth Status",
      description:
        "List the Langfuse projects this server can read — the names the other tools' `project` " +
        "argument takes — and check each key against the project it is filed under. Keys are " +
        "project-scoped, so this is the first thing to check when data looks wrong or " +
        "missing. Also reports the Langfuse version, whether it runs in v4 events-only mode " +
        "(no /traces or /sessions), whether writes are enabled, and, when something is not " +
        "configured, exactly what to set. Makes one small API call per project, plus two.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const base = {
          configured: projects.size > 0,
          host: ctx.config.baseUrl,
          keysFile: ctx.config.keysFile,
          writes: ctx.allowWrites ? "enabled" : "disabled",
        };
        const setup = setupInstructions(ctx.config);
        const [first] = projects.handles();
        if (!first) return { ...base, setup };

        const [described, health, eventsOnly] = await Promise.all([
          Promise.all(projects.handles().map((h) => describeProject(h.name, h.client, ctx))),
          first.client.get<{ version?: string }>("/api/public/health").then(
            (h) => h.version,
            () => undefined,
          ),
          detectEventsOnly(first.client),
        ]);
        return {
          ...base,
          ...(health ? { langfuseVersion: health } : {}),
          eventsOnly,
          projects: described,
          ...(setup.length ? { setup } : {}),
        };
      }),
  );
};
