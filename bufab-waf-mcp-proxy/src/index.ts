import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RulesStore } from "./rulesStore.js";

const AZURE_WAF_TOOL = "wellarchitectedframework_serviceguide_get";
const BUFAB_TOOL = "bufab_waf_guidelines";

const __dirname = dirname(fileURLToPath(import.meta.url));

let rulesStorePromise: Promise<RulesStore> | null = null;
function getRulesStore(): Promise<RulesStore> {
  rulesStorePromise ??= RulesStore.open(__dirname);
  return rulesStorePromise;
}

function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function loadBufabAppendix(): string {
  const path = join(__dirname, "..", "data", "bufab-infrastructure-appendix.md");
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function callToolResultToText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && "text" in block) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function azureMcpSpawnArgs(): string[] {
  const pkg = process.env.BUFAB_AZURE_MCP_PACKAGE ?? "@azure/mcp@latest";
  const extra = process.env.BUFAB_AZURE_MCP_SERVER_ARGS;
  const base = [
    "-y",
    pkg,
    "server",
    "start",
    "--transport",
    "stdio",
    "--tool",
    AZURE_WAF_TOOL,
    "--read-only",
  ];
  if (extra?.trim()) {
    return [...base, ...extra.trim().split(/\s+/).filter(Boolean)];
  }
  return base;
}

async function fetchAzureWafGuidance(service: string | undefined): Promise<CallToolResult> {
  const command = process.env.BUFAB_AZURE_MCP_COMMAND ?? "npx";
  const args = azureMcpSpawnArgs();

  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "inherit",
    env: process.env as Record<string, string>,
  });

  const client = new Client(
    { name: "bufab-waf-mcp-proxy-child", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const argsPayload: Record<string, string> = {};
    if (service !== undefined && service !== "") {
      argsPayload.service = service;
    }
    const raw = await client.callTool({
      name: AZURE_WAF_TOOL,
      arguments: argsPayload,
    });
    return raw as CallToolResult;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const bufabAppendix = loadBufabAppendix();

const server = new McpServer(
  {
    name: "bufab-waf-mcp-proxy",
    version: "1.0.0",
  },
  {
    instructions:
      "Tools: (1) bufab_waf_guidelines — Azure WAF via official @azure/mcp plus static Bufab overlay. (2) bufab_rules_* — Bufab rules in a local LanceDB (Option C: rules + rule_versions + vector chunks). Set BUFAB_RULES_DB_PATH to override the database directory. First embedding use downloads the Xenova MiniLM model via @huggingface/transformers.",
  },
);

server.registerTool(
  BUFAB_TOOL,
  {
    title: "Bufab WAF guidelines",
    description:
      "Fetches official Azure Well-Architected Framework guidance for an Azure service (or lists supported services when service is omitted), then appends Bufab naming, tagging, and baseline patterns.",
    inputSchema: {
      service: z
        .string()
        .optional()
        .describe(
          "Azure service name (optional). Omit to list services with WAF guidance. Examples: App Service, cosmos-db, \"Key Vault\".",
        ),
    },
  },
  async ({ service }) => {
    let azureResult: CallToolResult;
    try {
      azureResult = await fetchAzureWafGuidance(service);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to reach Azure MCP / WAF tool: ${message}\n\nEnsure Azure CLI or environment credentials are configured and that \`npx -y @azure/mcp@latest server start\` works on this machine.`,
          },
        ],
      };
    }

    if (azureResult.isError) {
      return azureResult;
    }

    const wafText = callToolResultToText(azureResult);
    const sections = [
      "## Azure Well-Architected Framework (official)",
      wafText.trim() || "(empty response from Azure MCP)",
    ];

    if (bufabAppendix.trim()) {
      sections.push("", "## Bufab overlay", bufabAppendix.trim());
    }

    const combined = sections.join("\n");

    return {
      content: [{ type: "text", text: combined }],
    };
  },
);

server.registerTool(
  "bufab_rules_upsert",
  {
    title: "Upsert Bufab rule",
    description:
      "Creates or updates a rule. If body is omitted, updates title/status/slug metadata only on an existing rule. If body is set, writes a new rule_versions row and re-embeds chunks in LanceDB.",
    inputSchema: {
      slug: z.string().describe("Stable slug (unique), e.g. key-vault-baseline."),
      title: z.string().describe("Short human title."),
      body: z
        .string()
        .optional()
        .describe("Full rule body (markdown). Required for new rules; omit for metadata-only updates."),
      change_summary: z.string().optional().describe("Optional note stored on the new version."),
      status: z
        .string()
        .optional()
        .describe("Lifecycle status (default \"active\"), e.g. draft, active, retired."),
      rule_id: z.string().uuid().optional().describe("Explicit rule UUID when known."),
    },
  },
  async (args) => {
    try {
      const store = await getRulesStore();
      const out = await store.upsertRule({
        slug: args.slug,
        title: args.title,
        body: args.body,
        change_summary: args.change_summary,
        status: args.status,
        rule_id: args.rule_id,
      });
      return { content: [{ type: "text", text: jsonText(out) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  },
);

server.registerTool(
  "bufab_rules_get",
  {
    title: "Get Bufab rule",
    description: "Load a rule by slug or rule_id. Optionally include full version history.",
    inputSchema: {
      slug: z.string().optional(),
      rule_id: z.string().uuid().optional(),
      include_history: z
        .boolean()
        .optional()
        .describe("Include all versions (sorted newest first). Default false."),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.rule_id?.trim()) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide slug or rule_id." }],
      };
    }
    const store = await getRulesStore();
    const row = await store.getRule({
      slug: args.slug,
      rule_id: args.rule_id,
      include_history: args.include_history ?? false,
    });
    if (!row) {
      return {
        content: [{ type: "text", text: "(not found)" }],
      };
    }
    return { content: [{ type: "text", text: jsonText(row) }] };
  },
);

server.registerTool(
  "bufab_rules_list",
  {
    title: "List Bufab rules",
    description: "List rules with optional status filter.",
    inputSchema: {
      status: z.string().optional().describe("Filter by rules.status."),
    },
  },
  async (args) => {
    const store = await getRulesStore();
    const rows = await store.listRules(args.status);
    return { content: [{ type: "text", text: jsonText(rows) }] };
  },
);

server.registerTool(
  "bufab_rules_search",
  {
    title: "Semantic search Bufab rules",
    description:
      "Vector search over chunked rule bodies (MiniLM embeddings). Optionally restrict to chunks tied to the current published version.",
    inputSchema: {
      query: z.string().describe("Natural-language query."),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 8)."),
      current_only: z
        .boolean()
        .optional()
        .describe("If true (default), only search chunks for the current version of each rule."),
    },
  },
  async (args) => {
    try {
      const store = await getRulesStore();
      const hits = await store.searchRules({
        query: args.query,
        limit: args.limit,
        current_only: args.current_only,
      });
      return { content: [{ type: "text", text: jsonText(hits) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  },
);

server.registerTool(
  "bufab_rules_delete",
  {
    title: "Delete Bufab rule",
    description: "Deletes a rule and all versions and chunks from LanceDB.",
    inputSchema: {
      slug: z.string().optional(),
      rule_id: z.string().uuid().optional(),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.rule_id?.trim()) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide slug or rule_id." }],
      };
    }
    const store = await getRulesStore();
    const ok = await store.deleteRule({ slug: args.slug, rule_id: args.rule_id });
    return { content: [{ type: "text", text: ok ? jsonText({ deleted: true }) : "(not found)" }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
