# bufab-mcp

MCP (Model Context Protocol) server that exposes:

1. **`waf_guidelines`** — Azure Well-Architected Framework guidance via the official [`@azure/mcp`](https://www.npmjs.com/package/@azure/mcp) child process, plus a static Bufab overlay from `data/bufab-infrastructure-appendix.md` when present.
2. **Infrastructure rules** — LanceDB-backed CRUD and semantic search (`rules_*`).
3. **UI guidelines** — LanceDB-backed fragments managed via MCP tools (`ui_*`, including `ui_section_spec`, `ui_token`, `ui_export`, `ui_export_markdown`).
4. **Architecture requirements** — versioned architecture profiles and deterministic file-change validation (`arch_*`, including `arch_validate_files` and `arch_export_markdown`).
5. **Agent config resources** — `.claude`, `.clinerules`, `.cursor` hooks/rules, and `.gitattributes` exposed as MCP resources via server-owned `bufab-agent-config://...` URIs. **Per-repo export does not include `.cursor/mcp.json`**; register `bufab-mcp` once in the client’s **global** MCP settings.

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

## Configure an MCP client (global)

Configure **`bufab-mcp` once** in your MCP client (Cursor user/global MCP settings, Cline MCP settings, etc.). Application repos should **not** rely on copying `bufab-mcp` or a per-project `.cursor/mcp.json` from `setup_environment`.

- Use **absolute paths** to a single install of `bufab-mcp/dist/index.js`.
- Point **`BUFAB_RULES_DB_PATH`**, **`BUFAB_UI_DB_PATH`**, and **`BUFAB_ARCH_DB_PATH`** at **shared** LanceDB directories (or one central checkout) so every workspace sees the same rules and architecture profiles.

See **`mcp-config.example.json`** in this directory for a full template.

Example shape (replace paths):

```json
{
  "mcpServers": {
    "bufab-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bufab-mcp/dist/index.js"],
      "env": {
        "BUFAB_RULES_DB_PATH": "/absolute/path/to/shared/.lancedb",
        "BUFAB_UI_DB_PATH": "/absolute/path/to/shared/.lancedb-ui",
        "BUFAB_ARCH_DB_PATH": "/absolute/path/to/shared/.lancedb-arch",
        "BUFAB_UI_FORCE_RESEED": "0"
      }
    }
  }
}
```

## Set up a new repository from scratch

Use this when a new application repository should use **Bufab hooks and validators**, while **`bufab-mcp` stays a single global install** and **rules/UI/arch data** live in **shared LanceDB paths** referenced by that MCP config.

### 1. One-time: install and build `bufab-mcp`

On the machine (or CI image) that runs Cursor/Cline:

```bash
cd /path/to/bufab-mcp
npm install
npm run build
npm run verify
```

Register the server in the client’s **global** MCP settings with absolute paths, as in **`mcp-config.example.json`**. Optionally run `npm run seed:arch` (and your own `rules_*` / `ui_*` population) so shared databases are not empty.

### 2. Layout for an application repo (hooks only)

Typical layout **without** vendoring `bufab-mcp`:

```text
<app-repo>/
├── .cursor/           ← hooks.json (and optional rules/*.mdc)
├── .claude/           ← optional
└── .clinerules/       ← hook shims + lib/
```

The hook adapters discover the validator at `<app-repo>/bufab-mcp/scripts/validate.mjs` **if** you symlink or copy that subtree; otherwise they fall back to paths such as `../Guidlines/bufab-mcp/scripts/validate.mjs` (see hook `lib` for discovery). You do **not** need a per-repo MCP definition.

### 3. Shared guideline data

UI, infrastructure rules, and architecture profiles live under **`BUFAB_UI_DB_PATH`**, **`BUFAB_RULES_DB_PATH`**, and **`BUFAB_ARCH_DB_PATH`**. Point those env vars at the same directories from your **global** MCP server entry so every project uses one source of truth.

### 4. Export and apply the agent hook config (no `mcp.json`)

Use the MCP agent config resources to create the hook config in the new repo. There are two supported discovery paths:

1. Call `resources/list`. This advertises the bundled `bufab-mcp/agent-config` files as `bufab-agent-config://...` resources. If `BUFAB_AGENT_CONFIG_SOURCE_DIR` is set, that directory is used instead.
2. Call the `setup_environment` tool when you need to pass an explicit source directory:

```json
{
  "source_dir": "/absolute/path/to/bufab-mcp/agent-config"
}
```

Both paths discover `.claude`, `.clinerules`, `.cursor` (**`hooks.json` and `rules/*` only**), and `.gitattributes`. **`.cursor/mcp.json` is not exported** — MCP is configured globally. For each resource, call `resources/read` and write the returned content to the same relative path in the new repo.

`setup_environment` also returns a JSON payload with:

- `files[].path` — target path to create in the new repo.
- `files[].content_base64` — file content to decode and write.
- `files[].executable` — whether to preserve the executable bit.
- `files[].resource_uri` — a server-owned resource URI, for example `bufab-agent-config://...`.

If your client cannot read MCP resources, decode `files[].content_base64` from the `setup_environment` response instead. In both cases, preserve the relative paths and executable bits.

The expected exported files include:

```text
.cursor/hooks.json
.cursor/rules/          (if present in the template)
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
2. Confirm **global** MCP lists `bufab-mcp` and exposes tools such as `ui_export`, `ui_search`, `rules_search`, and `waf_guidelines`.
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
| `BUFAB_ARCH_DB_PATH` | Architecture requirements LanceDB directory. Default: `<package>/.lancedb-arch`. |
| `BUFAB_UI_FORCE_RESEED` | Set to `1` to clear existing UI guideline rows on startup (useful before rebuilding via `ui_upsert`). |
| `BUFAB_EMBEDDING_MODEL` | Embedding model id for rules (default `Xenova/all-MiniLM-L6-v2`). |
| `BUFAB_UI_EMBEDDING_MODEL` | Overrides the UI embedding model; falls back to `BUFAB_EMBEDDING_MODEL` then the same default. |
| `BUFAB_ARCH_EMBEDDING_MODEL` | Overrides the architecture embedding model; falls back to `BUFAB_EMBEDDING_MODEL` then the same default. |
| `BUFAB_AZURE_MCP_COMMAND` | Command to spawn the Azure MCP child (default `npx`). |
| `BUFAB_AZURE_MCP_PACKAGE` | Package passed to npx (default `@azure/mcp@latest`). |
| `BUFAB_AZURE_MCP_SERVER_ARGS` | Extra whitespace-separated arguments appended to the Azure MCP `server start` invocation. |
| `BUFAB_AGENT_CONFIG_SOURCE_DIR` | Optional source directory used when clients call `resources/list` for exported `.claude`, `.clinerules`, `.cursor`, and `.gitattributes` files. When unset, `resources/list` uses the bundled `bufab-mcp/agent-config` template. |

## UI data bootstrap behavior

UI LanceDB starts empty by design (no implicit seed from JSON files).

- On a fresh workspace, `ui_export` and `ui_export_markdown` return an error until you add fragments.
- Populate data explicitly using `ui_upsert` (one or more fragments such as `spec-meta`, `layout`, `section-*`, `tokens-*`).
- `BUFAB_UI_FORCE_RESEED=1` only clears existing UI rows on startup; it does not auto-import data.

## Architecture data bootstrap behavior

Architecture LanceDB (`.lancedb-arch` / `BUFAB_ARCH_DB_PATH`) starts **empty**: the server creates tables on first open, but **does not insert profiles**. Empty tables look small on disk (~few KB per table); that is normal until you seed.

**Why `arch_list` is `[]` and `arch_search` returns nothing:** there are no `arch_profiles` rows and no `arch_chunks` until the first successful `arch_upsert` with a `requirements_json` body.

**Seed one profile (MCP tool `arch_upsert`):**

- `slug`: stable id, e.g. `default`
- `title`: human label, e.g. `Default product stack`
- `requirements_json`: **string** containing JSON (stringify the object your client expects)

Example payload (object shape; pass as a single JSON string in `requirements_json`):

```json
{
  "language": "go",
  "database": "sqlite",
  "sqlite_driver": "modernc.org/sqlite",
  "cgo_allowed": false,
  "frontend_framework": "react",
  "css_framework": "tailwind"
}
```

A copy-paste template lives at [`data/arch-profile-default.example.json`](data/arch-profile-default.example.json).

**Seed from the repo (recommended):** bundled profiles live in [`data/arch-guidelines-seed.json`](data/arch-guidelines-seed.json). After `npm run build`, run:

```bash
npm run seed:arch
```

This writes the `default` profile (and any others you add to that file) into `BUFAB_ARCH_DB_PATH` / `.lancedb-arch`, including chunks for `arch_search`.

After seeding:

1. `arch_list` / `arch_get` / `arch_export_markdown` (with `arch_slug`) return real data.
2. `arch_search` can return hits (first call may download the embedding model; allow network).
3. After code edits, call `arch_validate_files` with `arch_slug` and `files` (path + content).

There is **no** `arch_force_reseed` env flag; delete or `arch_delete` profiles if you need to reset.

**`rules_list` is `[]`:** same idea—infrastructure rules are only present after `rules_upsert` (or a populated `BUFAB_RULES_DB_PATH`). Architecture and rules stores are independent.

## Tools

| Name | Purpose |
|------|---------|
| `waf_guidelines` | Azure WAF service guidance (optional `service`), plus Bufab appendix when `data/bufab-infrastructure-appendix.md` exists. |
| `arch_upsert` | Create or update an architecture requirements profile and embeddings. |
| `arch_get` | Load an architecture profile by `slug` or `arch_id`. |
| `arch_list` | List architecture profiles, optional `status` filter. |
| `arch_search` | Semantic search over architecture requirement chunks. |
| `arch_delete` | Delete an architecture profile and related data. |
| `arch_validate_requirements` | Validate requirements JSON (errors/warnings + suggested changes). |
| `arch_validate_files` | Validate requirements against a set of changed files (returns `{violations, summary}`). |
| `arch_export_markdown` | Human-readable markdown export of architecture requirements + how-to-generate and validation checklist. |
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
| `setup_environment` | Export `.claude`, `.clinerules`, `.cursor` (`hooks.json` and `rules/*` only), and `.gitattributes` from a source directory. **Does not export `.cursor/mcp.json`.** If the requested directory has no config, it checks parent directories, the bundled `bufab-mcp/agent-config` template, the MCP process cwd, and `BUFAB_AGENT_CONFIG_SOURCE_DIR`. Each file includes a server-owned `resource_uri` readable through MCP `resources/read`. |

## Resources

| URI template | Purpose |
|--------------|---------|
| `bufab-agent-config://{source}/{+path}` | Reads a single exported agent config file. `source` is a server-owned project id and `path` is a relative file path under `.claude`, `.clinerules`, `.cursor`, or `.gitattributes`. |

`resources/list` advertises discovered config files as resources. By default it exposes the bundled `bufab-mcp/agent-config` template. To avoid exposing a whole editor cache when a custom source directory is used, `.cursor` discovery is limited to `.cursor/hooks.json` and `.cursor/rules/*` (not `mcp.json`); the total exported config list is capped.

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
- **`arch_list` returns `[]`**: the architecture LanceDB has no profiles yet. There is no auto-seed; call `arch_upsert` with `requirements_json` to create one. Also confirm `BUFAB_ARCH_DB_PATH` points at the directory you expect (same workspace as `bufab-mcp`); a different repo or missing `bufab-mcp` yields an empty or separate empty DB.
- **`arch_search` empty**: with no `arch_chunks` rows (no `arch_upsert` that wrote embeddings), search correctly returns no hits. After seeding, allow the first embedding call to finish (MiniLM download + `init()`); ensure the MCP process can reach the network on first use.

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

Add the same server entry as in your **global** Cursor MCP config, with absolute paths for `bufab-mcp/dist/index.js` and the LanceDB directories:

```json
{
     "mcpServers": {
       "bufab-mcp": {
         "command": "node",
         "args": ["/absolute/path/to/bufab-mcp/dist/index.js"],
         "env": {
           "BUFAB_UI_DB_PATH": "/absolute/path/to/bufab-mcp/.lancedb-ui",
           "BUFAB_RULES_DB_PATH": "/absolute/path/to/bufab-mcp/.lancedb",
           "BUFAB_ARCH_DB_PATH": "/absolute/path/to/bufab-mcp/.lancedb-arch"
         }
       }
     }
   }
```

Save the file — Cline picks it up automatically, no restart needed.
