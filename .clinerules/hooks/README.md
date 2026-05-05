# Bufab guideline enforcement — agent hooks (Cline, Cursor, Claude Code)

> **Audience:** the hackathon team. The Bufab UI guidelines in
> `guidelines/bufab_ui_guidelines.md` describe 13 anti-patterns that AI agents
> need to respect (gradients, web fonts, oversized border-radius, header that
> turns white on scroll, accent orange used outside CTA buttons, etc.). This
> folder contains hook scripts that enforce them deterministically — without
> relying on the model to remember a system prompt. Hooks are wired up for
> the three IDE agents we plan to demo: **Cline**, **Cursor**, and
> **Claude Code**.

## Why hooks at all (and why this is different from `.cursorrules` / `.clinerules` / `CLAUDE.md`)

Up to today, the only way to ask an agent to respect the Bufab guidelines was
to drop them into the system prompt — `.cursorrules` for Cursor, `.clinerules`
for Cline, `CLAUDE.md` for Claude Code. That's prompt-only enforcement and it
has two well-known failure modes:

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

The deterministic enforcement is strongest on Cline and Claude Code, weakest
on Cursor — not because of how we wrote the adapters, but because of what
each tool's hook surface allows:

| Tool        | Post-write feedback to agent | Block dangerous shell | Prompt-time context injection |
| ----------- | ---------------------------- | --------------------- | ----------------------------- |
| **Cline**   | YES (`PostToolUse` `contextModification`) | n/a (no Bash tool yet) | YES (`UserPromptSubmit`) |
| **Claude Code** | YES (`PostToolUse` `additionalContext`, matcher `Edit\|Write\|MultiEdit`) | YES (`PreToolUse` on `Bash`, not yet implemented) | YES (`UserPromptSubmit`) |
| **Cursor**  | NO (`afterFileEdit` is informational only — stdout is discarded) | YES (`beforeShellExecution` `permission: "deny"`) | NO (`beforeSubmitPrompt` is informational only) |

For Cursor, since `afterFileEdit` cannot push violations into the agent's
context directly, we persist them to `<workspace>/.cursor/.bufab-violations.json`
(a "ledger") and let the `beforeShellExecution` hook deny the next
`git commit` / `git push` / `npm publish` if the ledger has unresolved
blockers. That delays enforcement from "in-flight" to "pre-commit", but
nothing leaves the developer's machine until the violations are fixed.

## What each hook does

### `validate.mjs` — the shared validator

A standalone Node.js script. Lives outside the hooks folder so other entry
points (a future git pre-commit hook, a future CI job, an MCP tool) can call
the same code with the same rules.

It currently detects, deterministically via regex:

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

`afterFileEdit` runs the validator on the edited file. Because Cursor
discards this hook's stdout (it is informational only), we cannot push the
violation report into the agent context. Instead we **append it to a
workspace-local ledger**:

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
5. **Caveat — Cursor cannot inject post-edit feedback into the agent:** the
   agent will *not* spontaneously notice a violation right after writing
   the bad code (unlike Cline / Claude Code). Real enforcement happens at
   commit time. If you want the agent to know sooner, you have to point it
   at `.cursor/.bufab-violations.json` yourself.

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

## What is pending (in priority order)

1. **Tighten AP-06 false-positives.** Right now `border-radius > 2px` flags
   everywhere. The spec carves out an exception for `industries-grid`
   tiles (4px allowed). Heuristic to add: skip the check when the file
   path or surrounding selector contains `industries` / `industries-grid`.
2. **More semantic blockers.** AP-01 (centered hero), AP-02 (card layouts
   outside industries-grid), AP-09..AP-13. These need light AST work
   (parse JSX/HTML, find the hero element, check its `text-align`/
   `justify-items`/Flex/Grid). Probably worth doing with `acorn` or
   `htmlparser2` rather than regex.
3. **Wire the validator into the bufab-mcp server as a tool.** Right now
   the validator is only reachable via the hook adapters. Exposing it as
   `validate_files(paths[])` makes it callable by any MCP client (Replit
   Agent if/when it supports MCP, plus any future tooling).
4. **CI safety net.** Replit code does not pass through any of these IDE
   agents at all, so none of these hooks fire on it. The only place to
   catch a Replit-generated violation is when the code is pushed to the
   SCM. Add a CI step (Azure DevOps Pipelines / GitHub Actions) that runs
   `node bufab-mcp/scripts/validate.mjs $(git diff --name-only ...)` on
   every PR and fails the build if `summary.blockers > 0`.
5. **Pre-commit hook.** Same script, `.git/hooks/pre-commit` (or Husky).
   Catches violations on the dev's machine before they leave it,
   regardless of which IDE produced them. Also closes the Cursor gap
   since Cursor's `beforeShellExecution` only fires when the agent runs
   the shell — not when the developer commits from a terminal.
6. **Soft-fail vs hard-fail toggle.** Right now `PostToolUse` (Cline,
   Claude Code) never cancels the tool. A `BUFAB_HOOK_STRICT=1` env var
   could flip it to `cancel: true` / `decision: "block"` for the demo,
   where we want to show the tool being blocked.
7. **Audit hook for the demo.** A `TaskComplete` (Cline) /
   `Stop` (Cursor / Claude Code) hook that runs the validator across
   every file the agent touched in the task and emits a one-shot
   scorecard (start at 100, -15 per blocker, -5 per warning, as defined
   in Part 10 of the guideline doc).
8. **Explicit Bash blocker on Claude Code.** Mirror Cursor's
   `beforeShellExecution` deny via Claude Code's `PreToolUse` matcher
   `"Bash"` checking for `git commit` / `git push` / publish commands.
9. **Cursor `beforeSubmitPrompt` reminder.** Cursor's docs imply
   `beforeSubmitPrompt` cannot inject context, but a stderr-only
   reminder might still help users in the Hooks panel. Cheap to try.

## Things that are intentionally NOT in scope here

- **Catching violations in already-committed code.** That is a bulk-audit
  problem; this folder is about the in-flight feedback loop.
- **Enforcing rules outside the UI guideline document** (Azure infra rules,
  governance, etc.). Those have their own MCP tools (`rules_*`,
  `waf_guidelines`) and would need their own validators.
- **Replit.** Replit does not expose hooks to anything we control. It is
  covered by the pending CI safety net (item #4) instead.
