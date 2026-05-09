# Bufab guideline enforcement — agent hooks (Cline, Cursor, Claude Code)

> **Audience:** the hackathon team. Bufab maintains two guideline sources
> that AI agents need to respect:
>
> 1. **UI guidelines** — 13 anti-patterns in `guidelines/bufab_ui_guidelines.md`
>    (gradients, web fonts, oversized border-radius, header that turns white
>    on scroll, accent orange used outside CTA buttons, etc.). Also stored
>    structurally in the `bufab-mcp` server's `.lancedb-ui` and queryable via
>    the `ui_*` MCP tools.
> 2. **Infrastructure overlay** — Bufab-specific Azure expectations on top
>    of the Microsoft Well-Architected Framework: required tags
>    (`Owner`/`CostCenter`/`ProjectID`), naming convention
>    (`bufab-<env>-<region>-<app>-<resource>`), Bicep preferred for new
>    workloads, Key Vault for secrets, etc. Stored in `.lancedb` under
>    slug `bufab-infrastructure-context-overlay` and queryable via the
>    `rules_*` MCP tools.
>
> This folder contains hook scripts that enforce both deterministically —
> without relying on the model to remember a system prompt. Hooks are wired
> up for the three IDE agents we plan to demo: **Cline**, **Cursor**, and
> **Claude Code**.
>
> **All three tools support hooks today.** Cursor added them in 1.7
> (Oct 2025), Cline in 3.36 (Oct 2025), and Claude Code has had them since
> launch. Each tool has a slightly different hook schema; this folder ships
> per-tool adapter scripts that share one validator.

## Why hooks (vs prompt-only `.cursorrules` / `.clinerules` / `CLAUDE.md` rules)

Every tool already has a *prompt-level* rules file — `.cursorrules` for
Cursor, `.clinerules` for Cline, `CLAUDE.md` for Claude Code. Those work, but
they're soft: rules get injected into the system prompt and the LLM is
expected to follow them. That has two well-known failure modes:

1. **The model forgets.** A long task drifts and rules from the system prompt
   get crowded out by recent tool output.
2. **The model rationalises.** It writes `border-radius: 8px` "just for this
   one card" and there is nothing in the loop that says no.

A hook is a script that the agent runtime *itself* invokes at specific
lifecycle points, outside the LLM. The script reads a JSON payload on stdin
and writes a JSON response on stdout. The runtime acts on that response — it
can block a tool call, deny a shell command, or inject extra context that
the LLM is forced to read on the next turn.

That gives us a deterministic enforcement layer the LLM cannot opt out of:

```
user prompt
    └─► UserPromptSubmit hook  ◄── runs before LLM sees the prompt
            └─► LLM
                  └─► PreToolUse hook   ◄── runs before tool executes
                        └─► tool runs
                              └─► PostToolUse hook  ◄── runs after tool
                                    └─► next turn (LLM sees hook output)
```

All three IDE agents we target now support this lifecycle, with slightly
different schemas. We ship one shared validator (`bufab-mcp/scripts/validate.mjs`)
plus thin per-tool adapter scripts that translate each tool's input/output
shape.

References:
- Cline: <https://docs.cline.bot/customization/hooks>
- Cursor: <https://cursor.com/docs/hooks>
- Claude Code: <https://code.claude.com/docs/en/hooks>

## File layout

```
<repo>/
├── .clinerules/
│   └── hooks/
│       ├── PostToolUse              ← Cline bash shim (macOS/Linux), executable
│       ├── PostToolUse.ps1          ← Cline PowerShell shim (Windows)
│       ├── UserPromptSubmit         ← Cline bash shim, executable
│       ├── UserPromptSubmit.ps1     ← Cline PowerShell shim
│       ├── lib/                     ← all real adapter logic (Node.js, cross-platform)
│       │   ├── _core.mjs                    ← shared: validator spawn + violation formatting
│       │   ├── post-tool-use.mjs            ← Cline adapter
│       │   ├── user-prompt-submit.mjs       ← Cline adapter
│       │   ├── claude-post-tool-use.mjs     ← Claude Code adapter
│       │   ├── claude-user-prompt-submit.mjs← Claude Code adapter
│       │   ├── cursor-after-file-edit.mjs   ← Cursor adapter
│       │   └── cursor-before-shell-execution.mjs ← Cursor adapter
│       └── README.md                ← this file
├── .claude/
│   └── settings.json                ← Claude Code hook configuration
├── .cursor/
│   └── hooks.json                   ← Cursor hook configuration (also: mcp.json)
├── .gitattributes                   ← forces LF on the bash shims and .mjs files
└── bufab-mcp/
    └── scripts/
        └── validate.mjs             ← the actual checker (Node.js)
```

The `.clinerules/hooks/lib/` directory is named after Cline because Cline
mandates `.clinerules/hooks/<HookName>` paths. The `lib/` subfolder under it
just happens to be a convenient home for *all* the adapter scripts — the
Cursor `hooks.json` and Claude Code `settings.json` simply reference into it.
Node 18+ is the only runtime requirement.

## How the three tools differ

All three tools have hooks, but each hook surface allows different things.
The matrix below reflects what is **wired up today** in this repo, not the
theoretical capability of each platform:

| Tool            | Post-write feedback to the agent                                               | Block a dangerous shell command                                       | Prompt-time context injection                            |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------- |
| **Cline**       | direct — `PostToolUse` returns `contextModification` (next turn sees it)       | possible via `PreToolUse` on `execute_command` (not yet wired)        | direct — `UserPromptSubmit` returns `contextModification` |
| **Claude Code** | direct — `PostToolUse` (matcher `Edit\|Write\|MultiEdit`) returns `additionalContext` | possible via `PreToolUse` matcher `Bash` (not yet wired)              | direct — `UserPromptSubmit` returns `additionalContext`  |
| **Cursor**      | indirect — `afterFileEdit` writes a workspace ledger (`afterFileEdit` is informational-only by design) | direct — `beforeShellExecution` returns `permission: "deny"` (wired)  | not wired — `beforeSubmitPrompt` is informational-only   |

Cursor's `afterFileEdit` is "informational-only" in the upstream spec —
its stdout is discarded, so a script there cannot push the violation
report straight into the agent's context the way Cline and Claude Code's
`PostToolUse` can. We work around that by persisting violations to
`<workspace>/.cursor/.bufab-violations.json` (a "ledger") and letting
`beforeShellExecution` deny the next `git commit` / `git push` /
`npm publish` while the ledger has unresolved blockers. That shifts
Cursor's enforcement from "in-flight feedback" to "pre-commit gate" —
nothing violating the guidelines leaves the developer's machine.

## What each hook does

### `validate.mjs` — the shared validator

A standalone Node.js script. Lives outside the hooks folder so other entry
points (a future git pre-commit hook, a future CI job, an MCP tool) can call
the same code with the same rules.

It currently detects, deterministically via regex:

**UI rules** (run only on `.css`, `.scss`, `.html`, `.tsx`, `.jsx`, `.ts`, `.js`, `.vue`, `.svelte`, `.astro`):

| ID         | Severity | What we look for                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| AP-03      | blocker  | `linear-gradient(`, `radial-gradient(`, `conic-gradient(`                    |
| AP-04      | blocker  | `#E8610A` used in a `color`, `border-color`, `fill`, `stroke`, ... declaration |
| AP-05      | blocker  | `@font-face`, `fonts.googleapis.com`, `fonts.gstatic.com`, Typekit, Bunny    |
| AP-06      | blocker  | `border-radius` > 2px in CSS, or Tailwind `rounded-md/lg/xl/2xl/3xl/full` etc |
| AP-07/08   | blocker  | Scroll listener or `.scrolled` / `isScrolled` reference within ±400 chars of `header` |
| COLOR-03   | blocker  | Any hex color outside the Bufab token set                                    |
| TYPE-01    | blocker  | `font-family` with a known web font name (Inter, Roboto, Poppins, Montserrat, ...) |
| TYPE-01    | warning  | `font-family` declaration that does not include the system stack             |

**Infrastructure rules** (run only on `.bicep`, `.bicepparam`, `.tf`, `.tf.json`):

| ID         | Severity | What we look for                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------- |
| INFRA-01   | blocker  | Resource-declaring file missing required tags `Owner`, `CostCenter`, `ProjectID` |
| INFRA-02   | warning  | Resource `name` literal that does not start with `bufab-<env>-<region>-<app>-<resource>` |
| INFRA-03   | blocker  | Hardcoded `AccountKey=...`, SAS token (`sv=...&sig=...`), `SharedAccessSignature=...`, or `password`/`secret` field assigned to a literal |

The infra rules are sourced from the `bufab-infrastructure-context-overlay`
rule stored in `.lancedb` (queryable via `rules_get(slug=bufab-infrastructure-context-overlay)`).
The validator's regexes encode the deterministic checks; each violation
message points back at the rule slug so the agent or dev can fetch the
full prose for context.

Run it manually:

```bash
# validate one or more files
node bufab-mcp/scripts/validate.mjs src/components/Hero.tsx src/styles/globals.css

# validate stdin
echo '.x { background: linear-gradient(...); }' | node bufab-mcp/scripts/validate.mjs --stdin --stdin-file Hero.tsx

# validate inline content
node bufab-mcp/scripts/validate.mjs --content '...' --file Hero.tsx
```

Output is JSON:

```json
{
  "violations": [
    { "rule": "AP-03", "severity": "blocker", "file": "...", "line": 12,
      "matched": "linear-gradient(", "message": "Gradients are forbidden ..." }
  ],
  "summary": { "blockers": 1, "warnings": 0, "filesScanned": 1 }
}
```

The validator never fails — it always exits 0 with a JSON report. The
*caller* (hook adapter, CI, etc.) decides what to do with the report.

#### Test suite

`bufab-mcp/scripts/validate-test.mjs` runs the validator against six
fixtures under `bufab-mcp/scripts/test-fixtures/` and asserts the
expected blockers/warnings appear (and that "good" fixtures stay clean):

```bash
cd bufab-mcp
npm run test:validator
```

The runner uses live MCP guidelines (`ui_export`). This requires a built
`bufab-mcp` server and populated UI LanceDB (`ui_upsert` fragments).
Exits non-zero on first mismatch — suitable for CI.

When you add a new check to the validator, add a fixture that
exercises it and a case row in `validate-test.mjs`. Same flow for
adding new accepted-color tokens or new strict_constraints — update
the corresponding `*-good` fixture to use them.

#### Live-loading from the MCP (default)

The validator's accepted-color palette and the `UserPromptSubmit` reminder
text are **not hardcoded**. They are derived at every spawn from the
live MCP export:

- **`mcp`** *(default)* — spawn `bufab-mcp/dist/index.js` per validator
  invocation, call the `ui_export` tool over JSON-RPC, parse the merged
  guidelines it returns. The MCP rebuilds the document from LanceDB, so
  rules updated via `ui_upsert` (or any other LanceDB write) propagate
  to the next hook fire without any repo file sync step.
If `mcp` mode fails (binary not built, server crash, empty UI LanceDB, etc.),
the validator fails fast (exit 2). No fallback token set is used.

Because every hook fire spawns a fresh `node` process, "load on startup"
effectively means "load on every invocation" — a guideline change lands
immediately without redeploying anything. Add a new accepted color, add
a new `strict_constraint` line, `ui_upsert` a new fragment — the next
file Cline/Cursor/Claude Code writes will already be validated against
the new rules.

**Trade-off of the `mcp` default**: ~1-3 s cold start per hook fire
(LanceDB init + JSON-RPC handshake). Acceptable for typical demo flows;
if it shows up in latency, see Pending #3 (cross-spawn cache + fingerprint).

What is **not** auto-loaded: the regex/AST detection logic itself
(`detectGradients`, `detectHeaderScrollListener`, etc.). Those are code
because the *check shape* is structural. A genuinely new behavioral
pattern still needs a new check function.

Environment variables for ops:

| Variable                       | Effect                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| `BUFAB_UI_FORCE_RESEED=1`      | (consumed by the MCP server) clears UI rows in LanceDB on boot.        |

### Cline adapters (`lib/post-tool-use.mjs`, `lib/user-prompt-submit.mjs`)

`PostToolUse`: Filters down to `write_to_file` and `replace_in_file`. For
everything else, returns `{"cancel":false}` immediately. For a write, it
runs the validator and — on any violations — returns

```json
{ "cancel": false,
  "contextModification": "Bufab UI guidelines validator found violations in ...\n  - [AP-03] line 12: linear-gradient( -> Gradients are forbidden ..." }
```

Cline injects `contextModification` into Cline's *next* turn. The agent
reads the structured report and fixes the file. We deliberately set
`cancel: false` even when blockers are present — the write already happened,
undoing it would only confuse Cline.

`UserPromptSubmit`: Always returns a `contextModification` containing a
condensed list of the 9 most critical blockers and a reminder to call the
bufab-mcp tools (`ui_section_spec`, `ui_token`, `ui_search`).

The `.ps1` (Windows) and extensionless (macOS/Linux) files at
`.clinerules/hooks/` are thin shims that just hand stdin/stdout to the Node
implementation. The Windows shim uses `System.Diagnostics.Process` directly
rather than PowerShell's native pipe, because the latter prepends a UTF-8
BOM that breaks JSON.parse downstream.

### Claude Code adapters (`lib/claude-post-tool-use.mjs`, `lib/claude-user-prompt-submit.mjs`)

Configured via [`.claude/settings.json`](../../.claude/settings.json) with
matcher `"Edit|Write|MultiEdit"` for `PostToolUse`. Same logic as the Cline
versions — they just translate to and from Claude Code's JSON shape:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Bufab UI guidelines validator found violations in ..."
  }
}
```

Claude Code injects `additionalContext` (max 10k chars) alongside the next
model call.

`UserPromptSubmit` is configured with no matcher (fires on every prompt) and
returns the same Bufab reminder as the Cline variant.

### Cursor adapters (`lib/cursor-after-file-edit.mjs`, `lib/cursor-before-shell-execution.mjs`)

Configured via [`.cursor/hooks.json`](../../.cursor/hooks.json).

`afterFileEdit` runs the validator on the edited file. Cursor's
`afterFileEdit` is informational-only — its stdout is discarded, so we
push violations to a **workspace-local ledger** instead of returning
them to Cursor:

- File: `<workspace>/.cursor/.bufab-violations.json`
- Schema: `{ violations: [...], summary: { blockers, warnings }, updated_at }`
- The hook drops any prior entries for the same file before merging in the
  new ones, so the ledger always reflects the *current* state of every
  file Cursor has edited in this session.
- On any non-zero count we also write a one-line summary to stderr, which
  shows up in Cursor's "Hooks" output channel for the user to glance at.

The ledger is gitignored (`.gitignore` entry: `.cursor/.bufab-violations.json`).

`beforeShellExecution` reads that ledger. If the user (or the agent) tries
to run `git commit`, `git push`, `npm publish`, `pnpm publish`, or
`yarn publish` while `summary.blockers > 0`, the hook returns:

```json
{ "permission": "deny",
  "agentMessage": "Bufab guideline blockers must be fixed before \"git commit -m foo\":\n  - [AP-03] ...",
  "userMessage": "Bufab: 4 blocker(s) pending - see .cursor/.bufab-violations.json" }
```

Everything else returns `{"permission":"allow"}` — we deliberately do *not*
audit unrelated commands.

If the ledger is stale (e.g. the user fixed the file outside Cursor and the
afterFileEdit hook never re-ran), they can delete the ledger to clear it.

## Setup checklists (one per tool — only the ones you actually use)

### Common to all three

1. **Node.js 18+** must be on `PATH`. The validator and adapters are plain
   ESM Node — no `npm install` needed.
2. **macOS/Linux only:** confirm the bash shims (Cline) are executable —
   `ls -l .clinerules/hooks/PostToolUse` should show `-rwxr-xr-x`. If not:
   ```bash
   chmod +x .clinerules/hooks/PostToolUse .clinerules/hooks/UserPromptSubmit
   ```

### Cline (3.36+)

1. Install the **Cline VS Code extension** (3.36 or later — that is the
   release that introduced hooks).
2. Open this repo in VS Code such that the workspace root is `mcpserver/`
   (the directory that contains `.clinerules/`).
3. In Cline's settings, confirm hooks are enabled (default: on in 3.36+).
4. Sanity-check:
   - Start a new task. The first response should mention the Bufab
     guidelines (proof that `UserPromptSubmit` injected its reminder).
   - Ask Cline to write a CSS file with a `linear-gradient`. The next turn
     should show Cline acknowledging the AP-03 violation (proof that
     `PostToolUse` ran and the contextModification reached the model).

### Cursor (1.7+)

1. Install **Cursor 1.7 or later** (the release that introduced hooks).
2. Open this repo as the workspace root.
3. The hooks are auto-discovered from `.cursor/hooks.json`. Verify in the
   "Output" panel → "Hooks" that the two scripts appear at agent start.
4. Sanity-check:
   - Ask Cursor to write a CSS file with `border-radius: 16px`. After the
     write, look at the "Hooks" output panel: you should see a
     `[bufab] ...: 1 blocker(s)` line and `.cursor/.bufab-violations.json`
     should appear in the workspace.
   - Try `git commit -m test` from Cursor's chat. The
     `beforeShellExecution` hook should deny it with the violation list.
5. **Note on Cursor's enforcement timing:** Cursor's `afterFileEdit` is
   informational-only upstream, so the agent does not spontaneously see a
   violation the moment it writes bad code (Cline and Claude Code do).
   Real enforcement kicks in at the next `git commit` / `git push` /
   publish via `beforeShellExecution`. If you want the agent to react
   sooner inside the same task, point it at `.cursor/.bufab-violations.json`
   yourself.

### Claude Code

1. Install / update **Claude Code** to a version that supports
   `hookSpecificOutput.additionalContext` (see the Claude Code hooks docs).
2. Open this repo. Claude Code reads hooks from `.claude/settings.json`
   automatically.
3. Sanity-check:
   - Start a new conversation. The first turn should reference the Bufab
     guidelines (proof of `UserPromptSubmit`).
   - Ask Claude Code to write a CSS file with a `linear-gradient`. The
     turn after the `Write` tool runs should mention the AP-03 violation
     and offer a fix (proof of `PostToolUse`).
4. The hook command in `settings.json` uses `$CLAUDE_PROJECT_DIR`. If that
   variable is not set in your harness, replace it with an absolute path
   to the repo.

## Debug recipes

Each adapter is a plain Node.js script that reads JSON on stdin and writes
JSON on stdout. To debug one in isolation:

**Cline (PowerShell on Windows):**
```powershell
$payload = '{"taskId":"t1","hookName":"PostToolUse","workspaceRoots":["C:/path/to/repo"],"postToolUse":{"toolName":"write_to_file","parameters":{"path":"src/Hero.tsx"},"success":true,"result":"","executionTimeMs":12}}'
$payload | powershell -NoProfile -File .clinerules/hooks/PostToolUse.ps1
```

**Cline (bash on macOS/Linux):**
```bash
payload='{"taskId":"t1","hookName":"PostToolUse","workspaceRoots":["/path/to/repo"],"postToolUse":{"toolName":"write_to_file","parameters":{"path":"src/Hero.tsx"},"success":true,"result":"","executionTimeMs":12}}'
echo "$payload" | .clinerules/hooks/PostToolUse
```

**Claude Code:**
```bash
payload='{"session_id":"abc","cwd":"/path/to/repo","hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":"/path/to/repo/src/Hero.tsx","content":"..."},"tool_response":{"type":"text","text":"ok"}}'
echo "$payload" | node .clinerules/hooks/lib/claude-post-tool-use.mjs
```

**Cursor:**
```bash
payload='{"file_path":"src/Hero.tsx","edits":[],"hook_event_name":"afterFileEdit","workspace_roots":["/path/to/repo"]}'
echo "$payload" | node .clinerules/hooks/lib/cursor-after-file-edit.mjs
# then test the deny path:
payload='{"command":"git commit -m foo","hook_event_name":"beforeShellExecution","workspace_roots":["/path/to/repo"]}'
echo "$payload" | node .clinerules/hooks/lib/cursor-before-shell-execution.mjs
```

Each adapter writes its JSON response to stdout. Anything written to stderr
is debug-only and surfaces in the host tool's hook output panel.

## What is pending

### Detection — make the validator catch more

1. **AP-06 industries-grid carve-out.** Today every `border-radius > 2px`
   is flagged; the spec allows up to 4px inside `industries-grid` tiles.
   Heuristic to add: skip the check when the file path or surrounding
   selector contains `industries` / `industries-grid`.
2. **Semantic blockers (AP-01, AP-02, AP-09..AP-13).** Need light AST
   work — parse JSX/HTML to find the hero element and check its
   alignment, detect cards-outside-industries-grid, etc. `acorn` or
   `htmlparser2` rather than regex.
3. **More INFRA checks.** Today INFRA-01..03 are encoded; the rule body
   covers more (App Service vs AKS preference, encryption-at-rest,
   approved SKU families, private connectivity for PaaS). These need
   either richer regex patterns or proper Bicep/HCL parsers (e.g.
   `bicep`'s own AST library, or `hcl-parser` for Terraform). Worth
   doing once we see real infra files in the demo.
4. **Data-driven INFRA rules from `.lancedb` / `rules_*`.** Right now
   the INFRA detection logic is hardcoded regex; only the rule body
   text is fetched on demand via `rules_get`. Mirror the UI live-MCP
   loading pattern so an `INFRA-04 forbidden-SKU` rule can
   be added by `rules_upsert` without a code change. Requires adopting
   a structured "rule packet" shape (regex + severity + message + slug).

### Live guidelines — next step

Strict-only live MCP loading is **done** for UI guidelines. One layer left
from the original plan:

5. **Layer 3 — cross-spawn cache + fingerprint.** Today MCP mode pays a
   ~1-3 s cold start per hook fire (LanceDB init + JSON-RPC handshake).
   Add a small on-disk cache of the last `ui_export` result keyed by a
   version/etag the MCP returns; the validator uses the cached snapshot
   when the etag is unchanged and only re-spawns the MCP on drift. OPA
   Bundle Service pattern. Worth doing once we see real latency from
   `mcp` mode in the demo.

### Reach — catch code that did not pass through any of these hooks

6. **CI safety net.** Replit code never passes through Cline / Cursor /
   Claude Code, so none of these hooks fire on it. Add a CI step
   (Azure DevOps Pipelines / GitHub Actions) that runs
   `node bufab-mcp/scripts/validate.mjs $(git diff --name-only ...)`
   on every PR and fails the build if `summary.blockers > 0`. **This
   is the only defense against Replit-generated violations.**
7. **Pre-commit git hook** (`.git/hooks/pre-commit` or Husky). Catches
   violations on the dev's machine regardless of which IDE produced
   them. Also closes the gap of Cursor's `beforeShellExecution` not
   firing for commits done outside Cursor's chat (e.g. from VS Code's
   git UI or a terminal).
8. **Expose the validator as a `bufab-mcp` MCP tool.** Right now it's
   only reachable via the hook adapters. A `validate_files(paths[])`
   tool makes it callable from any MCP client.

### Demo polish

9. **Bash command blocking for Cline and Claude Code.** Mirror Cursor's
   `beforeShellExecution` deny: Cline `PreToolUse` on `execute_command`
   and Claude Code `PreToolUse` matcher `Bash`, both checking for
   `git commit` / `git push` / publish commands when the ledger has
   blockers.
10. **`BUFAB_HOOK_STRICT=1` toggle.** Flips `PostToolUse` from
    `contextModification` (soft-fail) to `cancel: true` / `decision: "block"`
    so the demo can show the tool being blocked outright.
11. **Task scorecard.** A `TaskComplete` (Cline) / `Stop` (Cursor and
    Claude Code) hook that runs the validator across every file the
    agent touched and emits the per-task score from Part 10 of the
    guideline doc (start at 100, -15 per blocker, -5 per warning).
12. **Cursor `beforeSubmitPrompt` reminder.** Stdout is informational-only
    so we can't add to context, but a stderr line surfaces in the Hooks
    panel for the user. Cheap to try.

## Things that are intentionally NOT in scope here

- **Catching violations in already-committed code.** That is a bulk-audit
  problem; this folder is about the in-flight feedback loop.
- **The full Azure governance surface.** We enforce three deterministic
  Bufab-specific infra rules today (INFRA-01..03 above). The broader Azure
  Well-Architected Framework guidance available via `waf_guidelines`
  (resilience, performance efficiency, cost models, full security
  baseline, etc.) is **not** machine-checked here — that lives in
  `waf_guidelines` for the agent to consult, and ultimately in
  Azure Policy / PR review.
- **Replit.** Replit does not expose hooks to anything we control. It is
  covered by the pending CI safety net (item #6 above) instead.
