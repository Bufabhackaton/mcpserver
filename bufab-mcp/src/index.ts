import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RulesStore } from "./rulesStore.js";
import { UiGuidelinesStore } from "./uiGuidelinesStore.js";

const AZURE_WAF_TOOL = "wellarchitectedframework_serviceguide_get";
const WAF_GUIDELINES_TOOL = "waf_guidelines";

const __dirname = dirname(fileURLToPath(import.meta.url));

let rulesStorePromise: Promise<RulesStore> | null = null;
function getRulesStore(): Promise<RulesStore> {
  rulesStorePromise ??= RulesStore.open(__dirname);
  return rulesStorePromise;
}

let uiStorePromise: Promise<UiGuidelinesStore> | null = null;
function getUiGuidelinesStore(): Promise<UiGuidelinesStore> {
  uiStorePromise ??= UiGuidelinesStore.open(__dirname);
  return uiStorePromise;
}

function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function emptyUiDbMessage(): string {
  return (
    "UI guidelines database is empty. Populate LanceDB explicitly via `ui_upsert` before calling export tools.\n\n" +
    "Example:\n" +
    "- call `ui_upsert` with a fragment slug (e.g. `tokens-colors`)\n" +
    "- repeat for required fragments (`spec-meta`, `layout`, sections, tokens, etc.)"
  );
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

type CommandRun = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}): Promise<CommandRun> {
  const startedAt = Date.now();
  return await new Promise<CommandRun>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));

    let killedByTimeout = false;
    const timeout = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, input.timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const suffix = killedByTimeout ? `\n[bufab-mcp] timed out after ${input.timeoutMs}ms` : "";
      resolve({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + suffix,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}\n${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function sanitizeRelativePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("file path is empty");
  }
  const normalized = trimmed.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error(`absolute paths are not allowed: ${raw}`);
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`windows drive paths are not allowed: ${raw}`);
  }
  const parts = normalized.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "." || p === "..") {
      throw new Error(`path traversal is not allowed: ${raw}`);
    }
  }
  return parts.join("/");
}

function resolveLocalBicepPath(): string | null {
  const envPath = process.env.BUFAB_BICEP_PATH?.trim();
  if (envPath) {
    return envPath;
  }
  const exe = process.platform === "win32" ? "bicep.exe" : "bicep";
  const vendor = join(__dirname, "..", "vendor", "bicep", exe);
  return vendor;
}

async function createTempWorkspaceDir(): Promise<string> {
  // Prefer a package-local tmp dir (works in sandboxes that restrict writes).
  const base = join(__dirname, "..", ".tmp");
  await mkdir(base, { recursive: true });
  return await mkdtemp(join(base, "bicep-"));
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
    { name: "bufab-mcp-child", version: "1.0.0" },
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
    name: "bufab-mcp",
    version: "1.0.0",
  },
  {
    instructions:
      "Tools: (1) waf_guidelines — Azure WAF via official @azure/mcp plus static Bufab overlay. (2) rules_* — infrastructure rules in LanceDB (.lancedb). (3) ui_* (including ui_section_spec, ui_token, ui_export, ui_export_markdown) — UI guidelines fragments in LanceDB (.lancedb-ui). Env: BUFAB_RULES_DB_PATH, BUFAB_UI_DB_PATH, BUFAB_UI_FORCE_RESEED=1 to clear and rebuild UI data via ui_upsert. First embedding use downloads MiniLM via @huggingface/transformers.",
  },
);

server.registerTool(
  WAF_GUIDELINES_TOOL,
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
  "rules_upsert",
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
  "rules_get",
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
  "rules_list",
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
  "rules_search",
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
  "rules_delete",
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

server.registerTool(
  "ui_list",
  {
    title: "List UI guideline entities",
    description:
      "Lists Bufab UI guideline fragments stored in LanceDB (slug, kind, domain, status). Each row includes `notes`: the top-level `notes` field from the current version body JSON when present (otherwise null). Optional filters: status, domain, kind.",
    inputSchema: {
      status: z.string().optional().describe("Filter by ui_entities.status."),
      domain: z.string().optional().describe("Filter by ui_entities.domain (meta, layout, component, section, tokens, policy, content)."),
      kind: z.string().optional().describe("Filter by ui_entities.kind (e.g. json_fragment)."),
    },
  },
  async (args) => {
    try {
      const store = await getUiGuidelinesStore();
      const rows = await store.listEntities({
        status: args.status,
        domain: args.domain,
        kind: args.kind,
      });
      return { content: [{ type: "text", text: jsonText(rows) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_get",
  {
    title: "Get UI guideline fragment",
    description: "Load one UI entity by slug or entity_id. Returns current version body (JSON string) unless include_history is true.",
    inputSchema: {
      slug: z.string().optional(),
      entity_id: z.string().uuid().optional(),
      include_history: z.boolean().optional().describe("Include all versions (newest first). Default false."),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.entity_id?.trim()) {
      return { isError: true, content: [{ type: "text", text: "Provide slug or entity_id." }] };
    }
    try {
      const store = await getUiGuidelinesStore();
      const row = await store.getEntity({
        slug: args.slug,
        entity_id: args.entity_id,
        include_history: args.include_history ?? false,
      });
      if (!row) {
        return { content: [{ type: "text", text: "(not found)" }] };
      }
      return { content: [{ type: "text", text: jsonText(row) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_upsert",
  {
    title: "Upsert UI guideline fragment",
    description:
      "Creates or updates a UI guideline entity. If body is omitted, updates title/status/kind/domain only. If body is set, appends a new version and re-embeds search chunks.",
    inputSchema: {
      slug: z.string().describe("Stable slug, e.g. section-hero, tokens-colors."),
      title: z.string().describe("Human title."),
      body: z.string().optional().describe("Fragment JSON or markdown. Required for new entities."),
      kind: z.string().optional().describe("Default json_fragment."),
      domain: z.string().optional().describe("Default general."),
      change_summary: z.string().optional(),
      status: z.string().optional().describe("Default active."),
      entity_id: z.string().uuid().optional(),
    },
  },
  async (args) => {
    try {
      const store = await getUiGuidelinesStore();
      const out = await store.upsertEntity({
        slug: args.slug,
        title: args.title,
        body: args.body,
        kind: args.kind,
        domain: args.domain,
        change_summary: args.change_summary,
        status: args.status,
        entity_id: args.entity_id,
      });
      return { content: [{ type: "text", text: jsonText(out) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_delete",
  {
    title: "Delete UI guideline entity",
    description: "Deletes a UI entity and all versions and chunks.",
    inputSchema: {
      slug: z.string().optional(),
      entity_id: z.string().uuid().optional(),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.entity_id?.trim()) {
      return { isError: true, content: [{ type: "text", text: "Provide slug or entity_id." }] };
    }
    try {
      const store = await getUiGuidelinesStore();
      const ok = await store.deleteEntity({ slug: args.slug, entity_id: args.entity_id });
      return { content: [{ type: "text", text: ok ? jsonText({ deleted: true }) : "(not found)" }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_search",
  {
    title: "Semantic search UI guidelines",
    description: "Vector search over chunked UI guideline bodies (MiniLM). Optional current_only (default true).",
    inputSchema: {
      query: z.string().optional().describe("Natural-language query."),
      limit: z.number().int().min(1).max(50).optional(),
      current_only: z.boolean().optional(),
    },
  },
  async (args) => {
    if (!args.query || !args.query.trim()) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "Missing required argument `query` (string) for `ui_search`.\n" +
              "Example:\n" +
              "{\n" +
              '  "query": "hero section CTA rules",\n' +
              '  "limit": 8,\n' +
              '  "current_only": true\n' +
              "}",
          },
        ],
      };
    }
    try {
      const store = await getUiGuidelinesStore();
      const hits = await store.searchUi({
        query: args.query,
        limit: args.limit,
        current_only: args.current_only,
      });
      return { content: [{ type: "text", text: jsonText(hits) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_section_spec",
  {
    title: "Get UI section spec",
    description:
      "Returns the JSON spec for a section or layout key (e.g. hero, header, text-image-split, layout). Maps to Lance slug section-* or component-*.",
    inputSchema: {
      section_type: z
        .string()
        .describe("Section or component key: layout, header, footer, hero, text-image-split, value-columns, …"),
    },
  },
  async ({ section_type }) => {
    try {
      const store = await getUiGuidelinesStore();
      const spec = await store.getSectionSpec(section_type);
      if (spec === null) {
        return { content: [{ type: "text", text: "(not found)" }] };
      }
      return { content: [{ type: "text", text: jsonText(spec) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_token",
  {
    title: "Get UI design token",
    description:
      "Returns a token or subtree from tokens-* fragments. Examples: primary, colors.primary, typography.scale.h1, spacing.section_vertical_padding.",
    inputSchema: {
      name: z.string().describe("Token name or dotted path."),
    },
  },
  async ({ name }) => {
    try {
      const store = await getUiGuidelinesStore();
      const tok = await store.getToken(name);
      if (tok === null) {
        return { content: [{ type: "text", text: "(not found)" }] };
      }
      return { content: [{ type: "text", text: jsonText(tok) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_export",
  {
    title: "Export merged UI guidelines JSON",
    description:
      "Rebuilds the canonical UI guidelines object from all current UI fragments in LanceDB (meta + ui_rules).",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const store = await getUiGuidelinesStore();
      const count = await store.countEntities();
      if (count === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: emptyUiDbMessage() }],
        };
      }
      const doc = await store.exportMergedGuidelines();
      return { content: [{ type: "text", text: jsonText(doc) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "ui_export_markdown",
  {
    title: "Export UI guidelines as markdown",
    description:
      "Renders a human-readable markdown document from current UI fragments in LanceDB.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const store = await getUiGuidelinesStore();
      const count = await store.countEntities();
      if (count === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: emptyUiDbMessage() }],
        };
      }
      const md = await store.exportMarkdownGuidelines();
      return { content: [{ type: "text", text: md }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "bicep_validate",
  {
    title: "Validate Bicep via CLI",
    description:
      "Writes provided Bicep-related files into a temporary workspace, then runs `bicep build` and `bicep lint` against one or more entrypoints. Returns CLI outputs and exit codes.",
    inputSchema: {
      files: z
        .array(
          z.object({
            path: z
              .string()
              .describe(
                "Relative path to write (e.g. infra/main.bicep, modules/vnet.bicep, bicepconfig.json). Must not be absolute and must not contain '..'.",
              ),
            content: z.string().describe("File contents (UTF-8)."),
          }),
        )
        .min(1)
        .describe("All files needed for validation (modules, params, config, etc.)."),
      entrypoints: z
        .array(z.string())
        .optional()
        .describe(
          "Relative paths to the Bicep files to validate (e.g. [\"infra/main.bicep\"]). If omitted, validates all provided *.bicep files.",
        ),
      keep_temp_dir: z
        .boolean()
        .optional()
        .describe("If true, does not delete the temp dir (useful for debugging). Default false."),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(10 * 60 * 1000)
        .optional()
        .describe("Per-command timeout in ms. Default 60000."),
    },
  },
  async (args) => {
    const timeoutMs = args.timeout_ms ?? 60000;
    const keep = args.keep_temp_dir === true;

    let tempDir: string | null = null;
    try {
      // os.tmpdir() isn't always writable under sandboxing; use package-local tmp.
      tempDir = await createTempWorkspaceDir();

      const bicepCommand = resolveLocalBicepPath() ?? "bicep";
      const bicepEnv = {
        // Bicep is a single-file .NET bundle and needs a writable extraction dir.
        DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(tempDir, ".dotnet-bundle"),
        // Some environments don't provide a writable HOME; keep it inside temp.
        HOME: tempDir,
      } as const;

      // Write all files
      for (const f of args.files) {
        const rel = sanitizeRelativePath(f.path);
        const abs = join(tempDir, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content, "utf8");
      }

      const allBicepFiles = args.files
        .map((f) => sanitizeRelativePath(f.path))
        .filter((p) => p.toLowerCase().endsWith(".bicep"));

      const entrypoints = (args.entrypoints?.length ? args.entrypoints : allBicepFiles).map((p) =>
        sanitizeRelativePath(p),
      );

      if (entrypoints.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "No entrypoints to validate. Provide `entrypoints` or include at least one `*.bicep` file in `files`.",
            },
          ],
        };
      }

      // Verify CLI exists early (clear error message).
      const versionRun = await runCommand({
        command: bicepCommand,
        args: ["--version"],
        cwd: tempDir,
        timeoutMs,
        env: bicepEnv,
      });
      if (versionRun.exitCode !== 0) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "Bicep CLI not available (or failed to run). Either install Bicep (Azure CLI: `az bicep install`) or rely on the package-local install via `npm install` (postinstall). You can also set BUFAB_BICEP_PATH.",
                  attempted_command: bicepCommand,
                  probe: versionRun,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const outDir = join(tempDir, "_bicep_out");
      await mkdir(outDir, { recursive: true });

      const perFile: Array<{
        entrypoint: string;
        build: CommandRun;
        lint: CommandRun;
      }> = [];

      for (const ep of entrypoints) {
        const build = await runCommand({
          command: bicepCommand,
          args: ["build", ep, "--outdir", "_bicep_out"],
          cwd: tempDir,
          timeoutMs,
          env: bicepEnv,
        });
        const lint = await runCommand({
          command: bicepCommand,
          args: ["lint", ep],
          cwd: tempDir,
          timeoutMs,
          env: bicepEnv,
        });
        perFile.push({ entrypoint: ep, build, lint });
      }

      const ok = perFile.every((r) => (r.build.exitCode ?? 1) === 0 && (r.lint.exitCode ?? 1) === 0);

      const result = {
        ok,
        temp_dir: keep ? tempDir : undefined,
        bicep_version: versionRun.stdout.trim() || versionRun.stderr.trim(),
        entrypoints,
        results: perFile,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    } finally {
      if (tempDir && !keep) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
