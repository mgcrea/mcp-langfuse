import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { ProjectRegistry } from "#/client/projects";
import type { Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerMetricsTools } from "#/tools/metrics";
import { registerObservationTools } from "#/tools/observations";
import { registerPromptTools } from "#/tools/prompts";
import { registerRequestTool } from "#/tools/request";
import { registerScoreTools } from "#/tools/scores";
import { registerTraceTools } from "#/tools/traces";
import { projectArgFor } from "#/tools/util";

export type ToolContext = {
  config: Config;
  /**
   * Widen langfuse_request to POST/PUT/PATCH/DELETE. Off by default — see
   * LANGFUSE_ALLOW_WRITES. There are no dedicated write tools: every named
   * tool is a read, so the flag only ever changes the escape hatch.
   */
  allowWrites: boolean;
  /** The clock relative windows (`since: "24h"`) are measured from. Injected for tests. */
  now: () => Date;
  /** The `project` argument, built once from the configured project names. */
  projectArg: z.ZodType<string | undefined>;
};

/**
 * Register the tools. With no project configured only langfuse_auth_status
 * exists, and it explains what to set.
 */
export const registerTools = (
  server: McpServer,
  projects: ProjectRegistry,
  base: Omit<ToolContext, "projectArg">,
): void => {
  // Always available: needs no credentials, so an unconfigured server can still
  // explain itself instead of closing the connection.
  registerAuthTools(server, projects, base);

  if (projects.size === 0) return;

  const ctx: ToolContext = { ...base, projectArg: projectArgFor(projects.names) };
  registerTraceTools(server, projects, ctx);
  registerObservationTools(server, projects, ctx);
  registerScoreTools(server, projects, ctx);
  registerMetricsTools(server, projects, ctx);
  registerPromptTools(server, projects, ctx);
  registerRequestTool(server, projects, ctx);
};
