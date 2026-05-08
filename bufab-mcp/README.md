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
      "args": ["${workspaceFolder}/bufab-mcp/dist/index.js"],
      "env": {
        "BUFAB_UI_FORCE_RESEED": "0"
      }
    }
  }
}
```

Use **absolute paths** if your client does not expand variables.

### Other clients

Use `command`: `node`, `args`: `["/absolute/path/to/bufab-mcp/dist/index.js"]`, and the same `env` keys as below. See **`mcp-config.example.json`** in this directory for a template with optional LanceDB path overrides.

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
| `BUFAB_AGENT_CONFIG_SOURCE_DIR` | Optional source directory used when clients call `resources/list` for exported `.claude`, `.clinerules`, and `.cursor` files. When unset, `resources/list` starts at the parent directory of `bufab-mcp` and uses discovery from there. |

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
| `setup_environment` | Export `.claude`, `.clinerules`, and `.cursor` files from a source directory. If the requested directory has no config, it checks parent directories, the parent of `bufab-mcp`, the MCP process cwd, and `BUFAB_AGENT_CONFIG_SOURCE_DIR`. Each file includes a server-owned `resource_uri` readable through MCP `resources/read`. |

## Resources

| URI template | Purpose |
|--------------|---------|
| `bufab-agent-config://{source}/{+path}` | Reads a single exported agent config file. `source` is a server-owned project id and `path` is a relative file path under `.claude`, `.clinerules`, or `.cursor`. |

`resources/list` advertises discovered config files as resources. To avoid exposing a whole editor cache, `.cursor` discovery is limited to `.cursor/mcp.json`, `.cursor/hooks.json`, and `.cursor/rules/*`; the total exported config list is capped.

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

Add the same server entry as in .cursor/mcp.json, but with absolute paths for the LanceDB directories:

```json
{
     "mcpServers": {
       "bufab-mcp": {
         "command": "node",
         "args": ["/absolute/path/to/bufab-mcp/dist/index.js"],
         "env": {
           "BUFAB_UI_DB_PATH": "/absolute/path/to/bufab-mcp/.lancedb-ui",
           "BUFAB_RULES_DB_PATH": "/absolute/path/to/bufab-mcp/.lancedb"
         }
       }
     }
   }
```

Save the file — Cline picks it up automatically, no restart needed.
