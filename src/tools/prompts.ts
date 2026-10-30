import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { ProjectRegistry } from "#/client/projects";
import { prune, summarizePromptListItem } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, scoped, wrap } from "#/tools/util";

export const registerPromptTools = (
  server: McpServer,
  projects: ProjectRegistry,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "langfuse_list_prompts",
    {
      title: "Langfuse: List Prompts",
      description:
        "List the prompts managed in this project: name, type, version numbers, which labels " +
        '(e.g. "production") point at which version, and tags. Page-numbered, not cursor-based. ' +
        "Read one with langfuse_get_prompt.",
      inputSchema: z.object({
        project: ctx.projectArg,
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Only the prompt with this exact name, e.g. "checkout-agent/system".'),
        label: z
          .string()
          .min(1)
          .optional()
          .describe('Only prompts with a version carrying this label, e.g. "production".'),
        tag: z.string().min(1).optional().describe('Only prompts with this tag, e.g. "sales".'),
        page: z.number().int().min(1).default(1).describe("Page number, from 1. Defaults to 1."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Prompts per page (1-100). Defaults to 50."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const res = await client.get<{
            data?: Record<string, unknown>[];
            meta?: { totalPages?: number; totalItems?: number };
          }>(
            "/api/public/v2/prompts",
            compact({
              name: args.name,
              label: args.label,
              tag: args.tag,
              page: args.page,
              limit: args.limit,
            }),
          );
          return {
            prompts: (res.data ?? []).map(summarizePromptListItem),
            page: args.page,
            totalPages: res.meta?.totalPages,
            totalItems: res.meta?.totalItems,
          };
        }),
      ),
  );

  server.registerTool(
    "langfuse_get_prompt",
    {
      title: "Langfuse: Get Prompt",
      description:
        "Get one prompt version in full: its text (or chat messages), config, labels and tags. " +
        'With neither version nor label this returns the version labelled "production" — not ' +
        'necessarily the newest. Pass label "latest" for the most recent version. A generation\'s ' +
        '`prompt` field ("name@version") says which version produced it.',
      inputSchema: z.object({
        project: ctx.projectArg,
        name: z
          .string()
          .min(1)
          .describe('Prompt name, slashes included, e.g. "checkout-agent/system".'),
        version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Exact version number, e.g. 3. Mutually exclusive with label."),
        label: z
          .string()
          .min(1)
          .optional()
          .describe('Version by label, e.g. "production", "staging" or "latest".'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      wrap(() =>
        scoped(projects, args.project, async (client) => {
          const prompt = await client.get<Record<string, unknown>>(
            `/api/public/v2/prompts/${encodeURIComponent(args.name)}`,
            compact({ version: args.version, label: args.label }),
          );
          return { prompt: prune(prompt) };
        }),
      ),
  );
};
