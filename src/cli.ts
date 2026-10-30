#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ZodError } from "zod";

import { BUILD_INFO } from "#/build-info";
import { loadConfig, setupInstructions } from "#/config";
import { createServer } from "#/server";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.LANGFUSE_DEBUG) console.error("[langfuse-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[langfuse-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[langfuse-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server, projects } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.warn(
    `langfuse-mcp connected (host=${config.baseUrl}, projects=${projects.size}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"})`,
  );
  for (const line of setupInstructions(config)) stderrLogger.warn(line);

  // Which project each key reads is the one fact that is easy to get wrong and
  // invisible in the data, so check every key now and say what it resolved to.
  // Never awaited: startup must not depend on the network.
  for (const { name, client } of projects.handles()) {
    client
      .assertProject()
      .then((project) => stderrLogger.warn(`project ${name} → ${project.name} (${project.id})`))
      .catch((err: unknown) => stderrLogger.warn(`project ${name}: ${describeFatal(err)}`));
  }

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[langfuse-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
