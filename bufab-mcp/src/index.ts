import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RulesStore } from "./rulesStore.js";
import { UiGuidelinesStore } from "./uiGuidelinesStore.js";
import { ArchitectureStore } from "./architectureStore.js";
import { renderArchitectureMarkdown } from "./architectureMarkdown.js";
import { validateArchitectureFiles, validateArchitectureRequirementsOnly } from "./architectureValidator.js";

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

let archStorePromise: Promise<ArchitectureStore> | null = null;
function getArchitectureStore(): Promise<ArchitectureStore> {
  archStorePromise ??= ArchitectureStore.open(__dirname);
  return archStorePromise;
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

type SetupEnvFile = {
  /** Path relative to the target project root (e.g. ".cursor/hooks.json"). */
  path: string;
  /** MCP resource URI that can be used with resources/read. */
  resource_uri: string;
  /** File contents encoded as base64. */
  content_base64: string;
  /** Whether file is executable on the server filesystem (best-effort hint). */
  executable: boolean;
};

const SETUP_ENV_ROOTS = [".claude", ".clinerules", ".cursor", ".gitattributes", "AGENTS.md"];
const SETUP_ENV_RESOURCE_TEMPLATE = "bufab-agent-config://{source}/{+path}";
const MAX_SETUP_ENV_FILES = 200;
const setupEnvSourceDirs = new Map<string, string>();

function setupEnvResourceUri(sourceDirAbs: string, relPath: string): string {
  const source = setupEnvSourceId(sourceDirAbs);
  setupEnvSourceDirs.set(source, sourceDirAbs);
  return `bufab-agent-config://${source}/${encodeResourcePath(relPath)}`;
}

function defaultSetupEnvironmentSourceDir(): string {
  const bundledConfigDir = resolve(__dirname, "..", "agent-config");
  return existsSync(bundledConfigDir) ? bundledConfigDir : resolve(__dirname, "..", "..");
}

function setupEnvSourceId(sourceDirAbs: string): string {
  const raw = basename(sourceDirAbs) || "project";
  const id = raw.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  // Include a stable suffix derived from the absolute path to avoid basename collisions.
  const digest = createHash("sha256").update(resolve(sourceDirAbs)).digest("hex").slice(0, 12);
  return `${id}-${digest}`;
}

function encodeResourcePath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

function decodeResourcePath(pathname: string): string {
  return pathname
    .replace(/^\/+/, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
}

function isSetupEnvironmentPath(relPath: string): boolean {
  return SETUP_ENV_ROOTS.some((root) => relPath === root || relPath.startsWith(`${root}/`));
}

function isSetupEnvironmentConfigFile(relPath: string): boolean {
  if (relPath === "AGENTS.md") return true;
  if (relPath === ".gitattributes") return true;
  if (relPath === ".clinerules" || relPath.startsWith(".clinerules/")) return true;
  if (relPath === ".claude" || relPath.startsWith(".claude/")) return true;
  return relPath === ".cursor/hooks.json" || relPath.startsWith(".cursor/rules/");
}

function guessTextMimeType(relPath: string): string {
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".md") || relPath.endsWith(".mdc")) return "text/markdown";
  if (relPath.endsWith(".yml") || relPath.endsWith(".yaml")) return "application/yaml";
  if (relPath.endsWith(".toml")) return "application/toml";
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")) {
    return "text/javascript";
  }
  if (relPath.endsWith(".ts") || relPath.endsWith(".mts") || relPath.endsWith(".cts")) {
    return "text/typescript";
  }
  return "text/plain";
}

async function listFilesRecursive(rootAbs: string, relBase = "", limit = MAX_SETUP_ENV_FILES): Promise<string[]> {
  const entries = await readdir(rootAbs, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (out.length >= limit) break;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const abs = join(rootAbs, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(abs, rel, limit - out.length)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function exportSetupEnvironment(sourceDirAbs: string): Promise<{
  source_dir: string;
  files: SetupEnvFile[];
}> {
  const files: SetupEnvFile[] = [];

  for (const root of SETUP_ENV_ROOTS) {
    const rootAbs = join(sourceDirAbs, root);
    // If a folder is missing, just skip it; the caller can decide whether that's acceptable.
    let s;
    try {
      s = await stat(rootAbs);
    } catch {
      continue;
    }

    const relPaths = s.isDirectory()
      ? await listFilesRecursive(rootAbs, root, MAX_SETUP_ENV_FILES - files.length)
      : s.isFile()
        ? [root]
        : [];
    for (const rel of relPaths) {
      if (files.length >= MAX_SETUP_ENV_FILES) break;
      if (!isSetupEnvironmentConfigFile(rel)) continue;
      const abs = join(sourceDirAbs, rel);
      const buf = await readFile(abs);
      const st = await stat(abs);
      files.push({
        path: rel,
        resource_uri: setupEnvResourceUri(sourceDirAbs, rel),
        content_base64: buf.toString("base64"),
        executable: (st.mode & 0o111) !== 0,
      });
    }
    if (files.length >= MAX_SETUP_ENV_FILES) break;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { source_dir: sourceDirAbs, files };
}

function candidateSetupEnvironmentDirs(requestedSourceDirAbs: string): string[] {
  const candidates = new Set<string>();
  const addParents = (start: string) => {
    let current = start;
    const root = parse(current).root;
    while (current && !candidates.has(current)) {
      candidates.add(current);
      if (current === root) break;
      current = dirname(current);
    }
  };

  addParents(requestedSourceDirAbs);
  addParents(defaultSetupEnvironmentSourceDir());
  addParents(process.cwd());

  const configuredSourceDir = process.env.BUFAB_AGENT_CONFIG_SOURCE_DIR?.trim();
  if (configuredSourceDir) {
    addParents(resolve(process.cwd(), configuredSourceDir));
  }

  return [...candidates];
}

async function exportSetupEnvironmentWithDiscovery(requestedSourceDirAbs: string): Promise<{
  requested_source_dir: string;
  source_dir: string;
  discovery_used: boolean;
  searched_source_dirs: string[];
  files: SetupEnvFile[];
}> {
  const searched: string[] = [];

  for (const candidate of candidateSetupEnvironmentDirs(requestedSourceDirAbs)) {
    searched.push(candidate);
    const payload = await exportSetupEnvironment(candidate);
    if (payload.files.length > 0) {
      return {
        requested_source_dir: requestedSourceDirAbs,
        source_dir: payload.source_dir,
        discovery_used: candidate !== requestedSourceDirAbs,
        searched_source_dirs: searched,
        files: payload.files,
      };
    }
  }

  return {
    requested_source_dir: requestedSourceDirAbs,
    source_dir: requestedSourceDirAbs,
    discovery_used: false,
    searched_source_dirs: searched,
    files: [],
  };
}

async function resolveSetupEnvironmentSourceDir(source: string): Promise<string> {
  const cached = setupEnvSourceDirs.get(source);
  if (cached) {
    return cached;
  }

  for (const candidate of candidateSetupEnvironmentDirs(defaultSetupEnvironmentSourceDir())) {
    const sourceId = setupEnvSourceId(candidate);
    if (sourceId !== source) continue;
    const payload = await exportSetupEnvironment(candidate);
    if (payload.files.length > 0) {
      setupEnvSourceDirs.set(source, candidate);
      return candidate;
    }
  }

  throw new Error(`unknown setup environment resource source: ${source}`);
}

async function readSetupEnvironmentResource(uri: URL): Promise<{
  uri: string;
  mimeType: string;
  text: string;
}> {
  const source = uri.hostname;
  if (!source) {
    throw new Error("setup environment resource URI is missing source");
  }

  const sourceDirAbs = await resolveSetupEnvironmentSourceDir(source);
  const relPath = sanitizeRelativePath(decodeResourcePath(uri.pathname));
  if (!isSetupEnvironmentPath(relPath) || !isSetupEnvironmentConfigFile(relPath)) {
    throw new Error(`unsupported setup environment path: ${relPath}`);
  }

  const fileAbs = resolve(sourceDirAbs, relPath);
  const sourceWithSep = sourceDirAbs.endsWith("/") ? sourceDirAbs : `${sourceDirAbs}/`;
  if (fileAbs !== sourceDirAbs && !fileAbs.startsWith(sourceWithSep)) {
    throw new Error(`path escapes source_dir: ${relPath}`);
  }

  const st = await stat(fileAbs);
  if (!st.isFile()) {
    throw new Error(`setup environment resource is not a file: ${relPath}`);
  }

  return {
    uri: uri.toString(),
    mimeType: guessTextMimeType(relPath),
    text: await readFile(fileAbs, "utf8"),
  };
}

const server = new McpServer(
  {
    name: "bufab-mcp",
    version: "1.0.0",
  },
  {
    instructions:
      "Tools: (1) waf_guidelines — Azure WAF via official @azure/mcp plus static Bufab overlay. (2) rules_* — infrastructure rules in LanceDB (.lancedb). (3) ui_* (including ui_section_spec, ui_token, ui_export, ui_export_markdown) — UI guidelines fragments in LanceDB (.lancedb-ui). (4) arch_* — architecture requirements profiles in LanceDB (.lancedb-arch), plus requirements and file-change validation via arch_validate_requirements and arch_validate_files. Env: BUFAB_RULES_DB_PATH, BUFAB_UI_DB_PATH, BUFAB_UI_FORCE_RESEED=1, BUFAB_ARCH_DB_PATH. First embedding use downloads MiniLM via @huggingface/transformers.",
  },
);

server.registerResource(
  "setup-environment-file",
  new ResourceTemplate(SETUP_ENV_RESOURCE_TEMPLATE, {
    list: async () => {
      const configuredSourceDir = process.env.BUFAB_AGENT_CONFIG_SOURCE_DIR?.trim();
      const sourceDirAbs = configuredSourceDir
        ? resolve(process.cwd(), configuredSourceDir)
        : defaultSetupEnvironmentSourceDir();
      const payload = await exportSetupEnvironmentWithDiscovery(sourceDirAbs);
      return {
        resources: payload.files.map((file) => ({
          uri: file.resource_uri,
          name: file.path,
          title: file.path,
          description: "Agent configuration file",
          mimeType: guessTextMimeType(file.path),
          _meta: {
            source: setupEnvSourceId(payload.source_dir),
            path: file.path,
            executable: file.executable,
          },
        })),
      };
    },
  }),
  {
    title: "Setup environment file",
    description:
      "Reads exported agent configuration files under .claude, .clinerules, .cursor (hooks.json and rules/* only), .gitattributes, or repo-root AGENTS.md. Does not export .cursor/mcp.json — configure the MCP server once in the client (global settings), not per-repo.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [await readSetupEnvironmentResource(uri)],
  }),
);

server.registerTool(
  "setup_environment",
  {
    title: "Setup environment (export project config)",
    description:
      "Exports .claude/.clinerules/.cursor (hooks + rules only)/.gitattributes/AGENTS.md from a source directory as JSON (base64 file contents). Omits .cursor/mcp.json — use the client's global MCP config to point at bufab-mcp and shared BUFAB_* LanceDB paths. This tool does not modify any files.",
    inputSchema: {
      source_dir: z
        .string()
        .optional()
        .describe("Directory to export from. Defaults to the MCP server process cwd."),
    },
  },
  async ({ source_dir }) => {
    try {
      const src = resolve(process.cwd(), source_dir ?? ".");
      const payload = await exportSetupEnvironmentWithDiscovery(src);
      return { content: [{ type: "text", text: jsonText(payload) }] };
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
  "arch_upsert",
  {
    title: "Upsert architecture requirements profile",
    description:
      "Creates or updates an architecture profile. If requirements_json is omitted, updates title/status/slug metadata only on an existing profile. If requirements_json is set, writes a new version row and re-embeds chunks in LanceDB.",
    inputSchema: {
      slug: z.string().describe("Stable slug (unique), e.g. app-go-sqlite."),
      title: z.string().describe("Short human title."),
      requirements_json: z
        .string()
        .optional()
        .describe("Requirements JSON string. Required for new profiles; omit for metadata-only updates."),
      change_summary: z.string().optional().describe("Optional note stored on the new version."),
      status: z.string().optional().describe("Lifecycle status (default \"active\"), e.g. draft, active, retired."),
      arch_id: z.string().uuid().optional().describe("Explicit profile UUID when known."),
    },
  },
  async (args) => {
    try {
      const store = await getArchitectureStore();
      const out = await store.upsertProfile({
        slug: args.slug,
        title: args.title,
        requirements_json: args.requirements_json,
        change_summary: args.change_summary,
        status: args.status,
        arch_id: args.arch_id,
      });
      return { content: [{ type: "text", text: jsonText(out) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "arch_get",
  {
    title: "Get architecture requirements profile",
    description: "Load an architecture profile by slug or arch_id. Optionally include full version history.",
    inputSchema: {
      slug: z.string().optional(),
      arch_id: z.string().uuid().optional(),
      include_history: z.boolean().optional().describe("Include all versions (sorted newest first). Default false."),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.arch_id?.trim()) {
      return { isError: true, content: [{ type: "text", text: "Provide slug or arch_id." }] };
    }
    const store = await getArchitectureStore();
    const row = await store.getProfile({
      slug: args.slug,
      arch_id: args.arch_id,
      include_history: args.include_history ?? false,
    });
    if (!row) {
      return { content: [{ type: "text", text: "(not found)" }] };
    }
    return { content: [{ type: "text", text: jsonText(row) }] };
  },
);

server.registerTool(
  "arch_list",
  {
    title: "List architecture requirements profiles",
    description: "List architecture profiles with optional status filter.",
    inputSchema: {
      status: z.string().optional().describe("Filter by arch_profiles.status."),
    },
  },
  async (args) => {
    const store = await getArchitectureStore();
    const rows = await store.listProfiles(args.status);
    return { content: [{ type: "text", text: jsonText(rows) }] };
  },
);

server.registerTool(
  "arch_search",
  {
    title: "Semantic search architecture requirements",
    description:
      "Vector search over chunked architecture requirements JSON (MiniLM embeddings). Optionally restrict to chunks tied to the current published version.",
    inputSchema: {
      query: z.string().describe("Natural-language query."),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 8)."),
      current_only: z
        .boolean()
        .optional()
        .describe("If true (default), only search chunks for the current version of each profile."),
    },
  },
  async (args) => {
    try {
      const store = await getArchitectureStore();
      const hits = await store.searchProfiles({
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
  "arch_delete",
  {
    title: "Delete architecture requirements profile",
    description: "Deletes an architecture profile and all versions and chunks from LanceDB.",
    inputSchema: {
      slug: z.string().optional(),
      arch_id: z.string().uuid().optional(),
    },
  },
  async (args) => {
    if (!args.slug?.trim() && !args.arch_id?.trim()) {
      return { isError: true, content: [{ type: "text", text: "Provide slug or arch_id." }] };
    }
    const store = await getArchitectureStore();
    const ok = await store.deleteProfile({ slug: args.slug, arch_id: args.arch_id });
    return { content: [{ type: "text", text: ok ? jsonText({ deleted: true }) : "(not found)" }] };
  },
);

server.registerTool(
  "arch_validate_requirements",
  {
    title: "Validate architecture requirements",
    description:
      "Validates requirements JSON for consistency (e.g. language/go, sqlite driver vs cgo policy) and returns errors/warnings, normalized requirements, and suggested changes.",
    inputSchema: {
      requirements: z.unknown().describe("Requirements object (preferred) OR JSON string."),
    },
  },
  async (args) => {
    try {
      const raw = typeof args.requirements === "string" ? JSON.parse(args.requirements) : args.requirements;
      const out = validateArchitectureRequirementsOnly(raw);
      return { content: [{ type: "text", text: jsonText(out) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "arch_validate_files",
  {
    title: "Validate architecture vs changed files",
    description:
      "Runs deterministic validation after file changes. Provide either (a) arch_slug to load current requirements, or (b) inline requirements. Returns violations in the same shape as other validators: {violations, summary}.",
    inputSchema: {
      arch_slug: z.string().optional().describe("Architecture profile slug to load requirements from."),
      requirements: z.unknown().optional().describe("Inline requirements object OR JSON string."),
      files: z
        .array(
          z.object({
            path: z.string().describe("Repo-relative path (for reporting)."),
            content: z.string().describe("File contents (UTF-8)."),
          }),
        )
        .min(1)
        .describe("Files to validate (typically changed files)."),
    },
  },
  async (args) => {
    try {
      let requirements: unknown = args.requirements;
      if (typeof requirements === "string") {
        requirements = JSON.parse(requirements);
      }

      if ((!requirements || requirements === null) && args.arch_slug?.trim()) {
        const store = await getArchitectureStore();
        const row = await store.getProfile({ slug: args.arch_slug.trim(), include_history: false });
        const ver = row?.current_version as { requirements_json?: string } | undefined;
        if (!ver?.requirements_json) {
          return { isError: true, content: [{ type: "text", text: "(not found)" }] };
        }
        requirements = JSON.parse(ver.requirements_json);
      }

      if (!requirements || requirements === null) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide `requirements` (object or JSON string) or `arch_slug` to load stored requirements.",
            },
          ],
        };
      }

      const out = validateArchitectureFiles({
        requirements,
        files: args.files,
      });
      return { content: [{ type: "text", text: jsonText(out) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  },
);

server.registerTool(
  "arch_export_markdown",
  {
    title: "Export architecture requirements as markdown",
    description:
      "Renders a human-readable markdown document from requirements (inline) or from the current version of a stored architecture profile (by slug).",
    inputSchema: {
      arch_slug: z.string().optional().describe("Architecture profile slug to load requirements from."),
      requirements: z.unknown().optional().describe("Inline requirements object OR JSON string."),
      title: z.string().optional().describe("Optional title override for the markdown document."),
    },
  },
  async (args) => {
    try {
      let requirements: unknown = args.requirements;
      if (typeof requirements === "string") {
        requirements = JSON.parse(requirements);
      }

      let resolvedTitle = args.title;
      if ((!requirements || requirements === null) && args.arch_slug?.trim()) {
        const store = await getArchitectureStore();
        const row = await store.getProfile({ slug: args.arch_slug.trim(), include_history: false });
        const prof = row?.profile as { title?: string } | undefined;
        const ver = row?.current_version as { requirements_json?: string } | undefined;
        if (!ver?.requirements_json) {
          return { isError: true, content: [{ type: "text", text: "(not found)" }] };
        }
        requirements = JSON.parse(ver.requirements_json);
        resolvedTitle ??= prof?.title;
      }

      if (!requirements || requirements === null) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide `requirements` (object or JSON string) or `arch_slug` to load stored requirements.",
            },
          ],
        };
      }

      const md = renderArchitectureMarkdown({
        slug: args.arch_slug,
        title: resolvedTitle,
        requirements: requirements as any,
      });
      return { content: [{ type: "text", text: md }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
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
