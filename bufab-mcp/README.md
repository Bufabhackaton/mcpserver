# bufab-mcp

MCP (Model Context Protocol) server that exposes:

1. **`waf_guidelines`** — Azure Well-Architected Framework guidance via the official [`@azure/mcp`](https://www.npmjs.com/package/@azure/mcp) child process, plus a static Bufab overlay from `data/bufab-infrastructure-appendix.md` when present.
2. **Infrastructure rules** — LanceDB-backed CRUD and semantic search (`rules_*`).
3. **UI guidelines** — LanceDB-backed fragments managed via MCP tools (`ui_*`, including `ui_section_spec`, `ui_token`, `ui_export`, `ui_export_markdown`).
4. **Agent config resources** — `.claude`, `.clinerules`, and `.cursor` files exposed as MCP resources via server-owned `bufab-agent-config://...` URIs.

Transport: **stdio** (standard MCP over stdin/stdout).
--
## Prerequisites



- **Node.js 18+**
- **Network** on first embedding use: the default embedding model (`Xenova/all-MiniLM-L6-v2`) is downloaded and cached (typically under `node_modules/@huggingface/transformers/.cache/`).
- For **`waf_guidelines`**: **`npx`** must work on the host; the server runs `npx` against `@azure/mcp` (overridable; see environment variables). Configure Azure credentials the same way you would for the Azure MCP CLI.

## Install and build

```bash
cd bufab-mcp
npm install
npm run build
```

This compiles TypeScript to `dist/index.js`, which is the MCP entrypoint.

**Development** (no separate build):

```bash
npm run dev
```

## Run standalone

The MCP host normally spawns the process; for a quick manual check:

```bash
node dist/index.js
```

The server speaks JSON-RPC over stdio and waits for the client to drive the session.

## Configure an MCP client

### Cursor

Add a server entry pointing at the built `dist/index.js`. Example (from the parent repo’s `.cursor/mcp.json` pattern):

```json
{
  "mcpServers": {
    "bufab-mcp": {
      "command": "node",
      "args": ["${workspaceFolder}/bufab-mcp/dist/index.js"]
    }
  }
}
```

Use **absolute paths** if your client does not expand variables. Override the
LanceDB locations or other defaults via the env vars listed below if needed —
out-of-the-box the server resolves them as siblings of `dist/`.

### Other clients

Use `command`: `node`, `args`: `["/absolute/path/to/bufab-mcp/dist/index.js"]`, and the same `env` keys as below. See **`mcp-config.example.json`** in this directory for a template with optional LanceDB path overrides.

## Set up a new repository from scratch

Use this when a new application repository should use the Bufab MCP tools and the deterministic agent hooks.

### 1. Choose the MCP location

The supported default layout is:

```text
<new-repo>/
├── bufab-mcp/
├── .cursor/
├── .claude/
└── .clinerules/
```

The hook adapters discover the validator at `<new-repo>/bufab-mcp/scripts/validate.mjs`. If you do not want to copy `bufab-mcp` into the new repo, keep this `Guidlines` repository as a sibling of the new repo; the adapters also check `../Guidlines/bufab-mcp/scripts/validate.mjs`.

The agent hook bootstrap files are bundled with this MCP under `bufab-mcp/agent-config`. You can fetch them as MCP resources; you do not need to manually copy `.cursor`, `.claude`, or `.clinerules` from another repository.

The UI and infrastructure guideline data lives in LanceDB directories. When copying `bufab-mcp`, include `bufab-mcp/.lancedb-ui` and `bufab-mcp/.lancedb` if they are populated. If those directories are not inside the copied MCP package, set `BUFAB_UI_DB_PATH` and `BUFAB_RULES_DB_PATH` to populated absolute paths in the MCP client config.

### 2. Install and build the MCP

From the new repo, after adding or symlinking `bufab-mcp`:

```bash
cd bufab-mcp
npm install
npm run build
npm run verify
```

`npm run verify` checks that the MCP starts and exposes its tools/resources over stdio. First use may download the embedding model cache.

### 3. Add the MCP client config

For Cursor, create `.cursor/mcp.json` in the new repo:

```json
{
  "mcpServers": {
    "bufab-mcp": {
      "command": "node",
      "args": ["${workspaceFolder}/bufab-mcp/dist/index.js"]
    }
  }
}
```

For Cline or another client, add the same server definition to that client's MCP settings. If the client does not expand `${workspaceFolder}`, use absolute paths:

```json
{
  "mcpServers": {
    "bufab-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/new-repo/bufab-mcp/dist/index.js"]
    }
  }
}
```

The LanceDB locations and the agent-config source directory default to siblings
of `dist/` and the bundled `bufab-mcp/agent-config/`, respectively. Set the
env vars in the table below only if you need to override those defaults (e.g.
sharing a single MCP binary across multiple project clones).

### 4. Export and apply the agent hook config

Use the MCP agent config resources to create the hook config in the new repo. There are two supported discovery paths:

1. Call `resources/list`. This advertises the bundled `bufab-mcp/agent-config` files as `bufab-agent-config://...` resources. If `BUFAB_AGENT_CONFIG_SOURCE_DIR` is set, that directory is used instead.
2. Call the `setup_environment` tool when you need to pass an explicit source directory:

```json
{
  "source_dir": "/absolute/path/to/bufab-mcp/agent-config"
}
```

Both paths discover `.cursor`, `.claude`, `.clinerules`, and `.gitattributes` files. For each resource, call `resources/read` and write the returned content to the same relative path in the new repo.

`setup_environment` also returns a JSON payload with:

- `files[].path` — target path to create in the new repo.
- `files[].content_base64` — file content to decode and write.
- `files[].executable` — whether to preserve the executable bit.
- `files[].resource_uri` — a server-owned resource URI, for example `bufab-agent-config://...`.

If your client cannot read MCP resources, decode `files[].content_base64` from the `setup_environment` response instead. In both cases, preserve the relative paths and executable bits.

The expected exported files include:

```text
.cursor/mcp.json
.cursor/hooks.json
.claude/settings.json
.clinerules/hooks/
.gitattributes
```

The resources and `setup_environment` are intentionally export-only; they do not modify the target repo.

Add these runtime artifacts to the new repo's `.gitignore`:

```gitignore
.cursor/.bufab-violations.json
.claude/settings.local.json
bufab-mcp/node_modules/
bufab-mcp/dist/
bufab-mcp/.tmp/
bufab-mcp/vendor/bicep/
```

On macOS/Linux, make sure the Cline hook shims are executable:

```bash
chmod +x .clinerules/hooks/PostToolUse .clinerules/hooks/UserPromptSubmit
```

### 5. Verify the new repo

1. Open the new repo as the workspace root in Cursor, Cline, or Claude Code.
2. Confirm the MCP client lists `bufab-mcp` and exposes tools such as `ui_export`, `ui_search`, `rules_search`, and `waf_guidelines`.
3. Call `ui_export` once. If it reports missing UI data, fix `BUFAB_UI_DB_PATH` or populate the UI guidelines via `ui_upsert`.
4. Ask the agent to create a test CSS file with `linear-gradient(...)` or `border-radius: 16px`.
5. Confirm the hooks report a Bufab guideline violation:
   - Cursor: check the Hooks output panel and `.cursor/.bufab-violations.json`.
   - Cline/Claude Code: the next model turn should receive the violation context.
6. Remove the test file and any temporary violation ledger before committing.

## Environment variables

| Variable | Description |
|----------|-------------|
| `BUFAB_UI_DB_PATH` | UI guidelines LanceDB directory. Default: `<package>/.lancedb-ui`. |
| `BUFAB_RULES_DB_PATH` | Infrastructure rules LanceDB directory. Default: `<package>/.lancedb`. |
| `BUFAB_UI_FORCE_RESEED` | Set to `1` to clear existing UI guideline rows on startup (useful before rebuilding via `ui_upsert`). |
| `BUFAB_EMBEDDING_MODEL` | Embedding model id for rules (default `Xenova/all-MiniLM-L6-v2`). |
| `BUFAB_UI_EMBEDDING_MODEL` | Overrides the UI embedding model; falls back to `BUFAB_EMBEDDING_MODEL` then the same default. |
| `BUFAB_AZURE_MCP_COMMAND` | Command to spawn the Azure MCP child (default `npx`). |
| `BUFAB_AZURE_MCP_PACKAGE` | Package passed to npx (default `@azure/mcp@latest`). |
| `BUFAB_AZURE_MCP_SERVER_ARGS` | Extra whitespace-separated arguments appended to the Azure MCP `server start` invocation. |
| `BUFAB_AGENT_CONFIG_SOURCE_DIR` | Optional source directory used when clients call `resources/list` for exported `.claude`, `.clinerules`, `.cursor`, and `.gitattributes` files. When unset, `resources/list` uses the bundled `bufab-mcp/agent-config` template. |

## UI data bootstrap behavior

UI LanceDB starts empty by design (no implicit seed from JSON files).

- On a fresh workspace, `ui_export` and `ui_export_markdown` return an error until you add fragments.
- Populate data explicitly using `ui_upsert` (one or more fragments such as `spec-meta`, `layout`, `section-*`, `tokens-*`).
- `BUFAB_UI_FORCE_RESEED=1` only clears existing UI rows on startup; it does not auto-import data.

## Tools

| Name | Purpose |
|------|---------|
| `waf_guidelines` | Azure WAF service guidance (optional `service`), plus Bufab appendix when `data/bufab-infrastructure-appendix.md` exists. |
| `rules_upsert` | Create or update an infrastructure rule and embeddings. |
| `rules_get` | Load a rule by `slug` or `rule_id`. |
| `rules_list` | List rules, optional `status` filter. |
| `rules_search` | Semantic search over rule chunks. |
| `rules_delete` | Delete a rule and related data. |
| `ui_list` | List UI guideline entities. |
| `ui_get` | Load one UI entity by `slug` or `entity_id`. |
| `ui_upsert` | Create or update a UI fragment and embeddings. |
| `ui_delete` | Delete a UI entity and related data. |
| `ui_search` | Semantic search over UI guideline chunks. |
| `ui_section_spec` | JSON spec for a section/layout key (`section_type`). |
| `ui_token` | Design token or dotted path (`name`). |
| `ui_export` | Merged export of the current UI guideline object. |
| `ui_export_markdown` | Human-readable markdown export of current UI fragments. |
| `setup_environment` | Export `.claude`, `.clinerules`, `.cursor`, and `.gitattributes` files from a source directory. If the requested directory has no config, it checks parent directories, the bundled `bufab-mcp/agent-config` template, the MCP process cwd, and `BUFAB_AGENT_CONFIG_SOURCE_DIR`. Each file includes a server-owned `resource_uri` readable through MCP `resources/read`. |

## Resources

| URI template | Purpose |
|--------------|---------|
| `bufab-agent-config://{source}/{+path}` | Reads a single exported agent config file. `source` is a server-owned project id and `path` is a relative file path under `.claude`, `.clinerules`, `.cursor`, or `.gitattributes`. |

`resources/list` advertises discovered config files as resources. By default it exposes the bundled `bufab-mcp/agent-config` template. To avoid exposing a whole editor cache when a custom source directory is used, `.cursor` discovery is limited to `.cursor/mcp.json`, `.cursor/hooks.json`, and `.cursor/rules/*`; the total exported config list is capped.

`setup_environment` returns resource URIs for discovered files:

```json
{
  "requested_source_dir": "/path/to/project/app",
  "source_dir": "/path/to/project",
  "discovery_used": true,
  "searched_source_dirs": ["/path/to/project/app", "/path/to/project"],
  "files": [
    {
      "path": ".cursor/rules/project.mdc",
      "resource_uri": "bufab-agent-config://project/.cursor/rules/project.mdc",
      "content_base64": "...",
      "executable": false
    }
  ]
}
```

## Verify

After `npm run build`:

```bash
npm run verify
```

Runs `scripts/mcp-smoke.mjs`: **initialize** → **notifications/initialized** → **tools/list**, then exits.

Optional UI seed check:

```bash
npm run verify:ui
```

## Troubleshooting

- **Slow first request**: embedding model download or LanceDB initialization.
- **`waf_guidelines` errors**: confirm `npx -y @azure/mcp@latest server start --transport stdio …` works locally and Azure auth is valid.
- **Missing UI data**: populate UI fragments using `ui_upsert`; if needed, set `BUFAB_UI_FORCE_RESEED=1` once to clear stale rows before repopulating.

## License

Private package (`"private": true` in `package.json`). Use according to your organization’s policy.


## Setting Up MCP on Cline

Cursor and Cline are separate MCP clients and do not share config. You need to add the server to Cline's own settings file.
Steps

Find Cline's config file:

```bash
find ~/Library/Application\ Support/Cursor -name "cline_mcp_settings.json" 2>/dev/null
```

Open the file it returns:

```bash
open "/Users/<you>/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
```

Add the same server entry as in .cursor/mcp.json. Use an absolute path to
`dist/index.js`; LanceDB locations are resolved as siblings of `dist/` by
default, so no env block is required:

```json
{
  "mcpServers": {
    "bufab-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bufab-mcp/dist/index.js"]
    }
  }
}
```

Save the file — Cline picks it up automatically, no restart needed.
