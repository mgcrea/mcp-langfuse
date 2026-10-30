import { McpServer } from "@modelcontextprotocol/server";

import { BUILD_INFO } from "#/build-info";
import type { Logger } from "#/client/auth";
import { LangfuseClient } from "#/client/langfuse";
import { ProjectRegistry } from "#/client/projects";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-langfuse-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Clock for relative time windows (tests). */
  now?: () => Date;
};

export type CreatedServer = {
  server: McpServer;
  /** One client per configured project; empty when none is configured. */
  projects: ProjectRegistry;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const projects = new ProjectRegistry(
    config.projects.map((entry) => ({
      name: entry.name,
      client: new LangfuseClient({
        baseUrl: config.baseUrl,
        publicKey: entry.publicKey,
        secretKey: entry.secretKey,
        expect: entry.expect,
        maxRetries: config.maxRetries,
        userAgent: USER_AGENT,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.logger ? { logger: opts.logger } : {}),
      }),
    })),
  );

  registerTools(server, projects, {
    config,
    allowWrites: config.allowWrites,
    now: opts.now ?? (() => new Date()),
  });

  return { server, projects };
};
