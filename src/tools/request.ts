import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { ProjectRegistry } from "#/client/projects";
import type { ToolContext } from "#/tools/index";
import { scoped, wrap } from "#/tools/util";

const SAFE_PATH = /^\/api\/public\/[A-Za-z0-9/_.~%-]*$/;

export const registerRequestTool = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  const methods = ctx.allowWrites
    ? (["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    : (["GET"] as const);

  server.registerTool(
    "langfuse_request",
    {
      title: "Langfuse: Raw API Request",
      description:
        "Escape hatch: call any /api/public endpoint directly and get the raw, unshaped JSON " +
        "back — datasets, annotation queues, comments, models, score configs, anything the " +
        "other tools do not wrap. Prefer a dedicated tool when one exists: their output is " +
        "trimmed for the context window, this is not. In events-only mode GET /traces, " +
        "/sessions, /observations and /scores (v1/v2) return 404; use /v2/observations and " +
        "/v3/scores. " +
        (ctx.allowWrites
          ? "Writes are ENABLED: POST/PUT/PATCH/DELETE go straight to Langfuse with no " +
            "confirmation step, so check the path and body before calling."
          : "Writes are DISABLED: only GET is permitted. Set LANGFUSE_ALLOW_WRITES=1 to allow mutations."),
      inputSchema: z.object({
        project: ctx.projectArg,
        method: z
          .enum(methods)
          .default("GET")
          .describe(`HTTP method: ${methods.join(", ")}. Defaults to GET.`),
        path: z
          .string()
          .regex(
            SAFE_PATH,
            "Path must start with /api/public/ and contain no query string or '..'.",
          )
          .describe(
            'API path, starting with /api/public/, e.g. "/api/public/v2/datasets". Put parameters in `query`.',
          ),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe('Query parameters, e.g. {"limit": 10, "page": 1}.'),
        body: z.unknown().optional().describe("JSON body for POST/PUT/PATCH. Ignored for GET."),
      }),
      annotations: { readOnlyHint: !ctx.allowWrites, destructiveHint: ctx.allowWrites },
    },
    async ({ project, method, path, query, body }) =>
      wrap(() =>
        scoped(projects, project, async (client) => {
          // Belt and braces: the enum already excludes writes, but a client
          // could hand-roll a request that skips schema validation.
          if (!ctx.allowWrites && method !== "GET") {
            throw new WritesDisabledError(`langfuse_request with method ${method}`);
          }
          if (path.split("/").includes("..")) throw new Error("Path must not contain '..'.");
          const response = await client.request(method, path, {
            ...(query ? { query } : {}),
            ...(method !== "GET" && body !== undefined ? { body } : {}),
          });
          return { response };
        }),
      ),
  );
};
