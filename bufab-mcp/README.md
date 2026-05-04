# bufab-mcp

MCP (Model Context Protocol) server that exposes:

1. **`waf_guidelines`** — Azure Well-Architected Framework guidance via the official [`@azure/mcp`](https://www.npmjs.com/package/@azure/mcp) child process, plus a static Bufab overlay from `data/bufab-infrastructure-appendix.md` when present.
2. **Infrastructure rules** — LanceDB-backed CRUD and semantic search (`rules_*`).
3. **UI guidelines** — LanceDB-backed fragments seeded from `bufab_ui_guidelines.json`, with helpers for sections, tokens, and export (`ui_*`, including `ui_section_spec`, `ui_token`, `ui_export`, `ui_export_markdown`).

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
        "BUFAB_UI_GUIDELINES_JSON": "${workspaceFolder}/../allguidelines/bufab_ui_guidelines.json"
      }
    }
  }
}
```

Use **absolute paths** if your client does not expand variables. Adjust `BUFAB_UI_GUIDELINES_JSON` to the real location of `bufab_ui_guidelines.json`.

### Other clients

Use `command`: `node`, `args`: `["/absolute/path/to/bufab-mcp/dist/index.js"]`, and the same `env` keys as below. See **`mcp-config.example.json`** in this directory for a template with optional LanceDB path overrides.

## Environment variables

| Variable | Description |
|----------|-------------|
| `BUFAB_UI_GUIDELINES_JSON` | Path to `bufab_ui_guidelines.json` used to seed or re-seed the UI LanceDB. If unset, the code uses a default relative path (sibling `allguidelines` layout). |
| `BUFAB_UI_DB_PATH` | UI guidelines LanceDB directory. Default: `<package>/.lancedb-ui`. |
| `BUFAB_RULES_DB_PATH` | Infrastructure rules LanceDB directory. Default: `<package>/.lancedb`. |
| `BUFAB_UI_FORCE_RESEED` | Set to `1` to force re-import from `BUFAB_UI_GUIDELINES_JSON` into the UI database. |
| `BUFAB_EMBEDDING_MODEL` | Embedding model id for rules (default `Xenova/all-MiniLM-L6-v2`). |
| `BUFAB_UI_EMBEDDING_MODEL` | Overrides the UI embedding model; falls back to `BUFAB_EMBEDDING_MODEL` then the same default. |
| `BUFAB_AZURE_MCP_COMMAND` | Command to spawn the Azure MCP child (default `npx`). |
| `BUFAB_AZURE_MCP_PACKAGE` | Package passed to npx (default `@azure/mcp@latest`). |
| `BUFAB_AZURE_MCP_SERVER_ARGS` | Extra whitespace-separated arguments appended to the Azure MCP `server start` invocation. |

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
| `ui_export` | Merged export shaped like `bufab_ui_guidelines.json`. |
| `ui_export_markdown` | Human-readable markdown export of current UI fragments. |

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
- **Missing UI data**: ensure `BUFAB_UI_GUIDELINES_JSON` points at the correct file, or set `BUFAB_UI_FORCE_RESEED=1` once after changing the JSON path.

## License

Private package (`"private": true` in `package.json`). Use according to your organization’s policy.
