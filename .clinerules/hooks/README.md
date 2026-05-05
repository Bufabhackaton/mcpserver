# Bufab guideline enforcement — Cline hooks

> **Audience:** the hackathon team. Most of you use Cursor day-to-day; Cline/Claude has
> a feature called **hooks** that Cursor does not, and we use it here to make
> the Bufab UI guidelines actually enforced instead of just suggested. This
> README explains the concept first, then what's in this folder, then what's
> still missing.

## Why hooks at all (and why this is different from `.cursorrules` / `.clinerules`)

The guidelines in `guidelines/bufab_ui_guidelines.md` describe 13 anti-patterns
that a Bufab page can violate (gradients, web fonts, oversized border-radius,
header that turns white on scroll, accent orange used outside CTA buttons,
etc.). Up to today, the only way to ask an agent to respect them was to drop
them into the system prompt — `.cursorrules` for Cursor, `.clinerules` for
Cline, custom system prompt for Claude Code. That's prompt-only enforcement
and it has two well-known failure modes:

1. **The model forgets.** A long task drifts and rules from the system prompt
   get crowded out by recent tool output.
2. **The model rationalises.** It writes `border-radius: 8px` "just for this
   one card" and there is nothing in the loop that says no.

A hook is a script that the Cline/Claude runtime *itself* invokes at specific lifecycle points, outside
the LLM. The script reads a JSON payload on stdin and writes a JSON response
on stdout. The runtime acts on that response — it can block a tool call, or
inject extra context that the LLM is forced to read on the next turn.

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

Cursor does not have an equivalent today. Claude Code does (different schema,
but the same idea: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, ...). We
implement Cline's flavour here because the hackathon demo is on Cline.

Reference: <https://docs.cline.bot/customization/hooks>

## File layout

```
<repo>/
├── .clinerules/
│   ├── hooks/
│   │   ├── PostToolUse.ps1          ← runs the validator after every write
│   │   ├── UserPromptSubmit.ps1     ← injects blocker summary on every turn
│   │   └── README.md                ← this file
│   └── (project-level rules can also live here as plain .md)
└── bufab-mcp/
    └── scripts/
        └── validate.mjs             ← the actual checker (Node.js)
```

Cline picks up hooks automatically when they are present at one of the two
expected paths:

- `.clinerules/hooks/<HookName>.<ext>` — project-scoped (this repo)
- `~/Documents/Cline/Hooks/<HookName>.<ext>` — user-scoped (all repos)

On Windows the file extension must be `.ps1` (PowerShell). On macOS/Linux the
file is extensionless and must be `chmod +x`'d. We ship Windows scripts here
because that is what the hackathon dev box runs; mac/Linux ports are pending.

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

# validate stdin (used by the hook)
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
*caller* (hook, CI, etc.) decides what to do with the report.

### `PostToolUse.ps1` — hard enforcement after writes

Runs after every Cline tool. Filters down to `write_to_file` and
`replace_in_file` (the two write tools Cline exposes today). For everything
else, it returns `{"cancel":false}` immediately.

For a write, it:

1. Reads the JSON event from stdin (Cline's contract).
2. Pulls `parameters.path` (the file Cline just wrote).
3. Resolves it against `workspaceRoots[0]` if it is relative.
4. Runs `node bufab-mcp/scripts/validate.mjs <abs_path>`.
5. If `summary.blockers + summary.warnings == 0`, returns `{"cancel":false}`.
6. Otherwise, returns
   ```json
   { "cancel": false,
     "contextModification": "Bufab UI guidelines validator found violations in ...\n\nBLOCKERS ...\n  - [AP-03] line 12: linear-gradient( -> Gradients are forbidden ..." }
   ```

We deliberately set `cancel: false` even when blockers are present — the
write already happened, undoing it would only confuse Cline. Instead we feed
the violation list back as `contextModification`, which the runtime injects
into the *next* turn. Cline reads it, recognises the structured report, and
fixes the file.

If you want a stricter posture, change `cancel` to `true` and add an
`errorMessage`. That will make Cline retry the write instead.

### `UserPromptSubmit.ps1` — soft enforcement on every prompt

Fires every time the user submits a message. Always returns
`contextModification` containing:

- A condensed list of the 9 most critical blockers (so the LLM sees them
  inline rather than relying on a system-prompt rule that may have drifted)
- A reminder to call the bufab-mcp tools (`ui_section_spec`, `ui_token`,
  `ui_search`) before generating UI
- The path to the full guideline document for deeper lookups

This is the prompt layer. It is NOT the layer that catches violations — it
just keeps the rules salient. The `PostToolUse` hook is what makes a
violation expensive.

## Setup checklist (for someone trying this on a fresh machine)

1. **Node.js 18+** must be on `PATH`. The validator is plain ESM Node, no
   dependencies to install.
2. **Cline 3.36+** must be installed in VS Code.
3. Open this repo in VS Code such that the workspace root is `mcpserver/`
   (the directory that contains `.clinerules/`).
4. In Cline's settings, confirm hooks are enabled (default: on in 3.36+).
5. Sanity-check the hooks fire:
   - Start a new task.
   - The first response from Cline should mention the Bufab guidelines —
     proof that `UserPromptSubmit.ps1` injected its context.
   - Ask Cline to write a CSS file with a `linear-gradient`. The next turn
     after the write should show Cline acknowledging the AP-03 violation —
     proof that `PostToolUse.ps1` ran and the contextModification reached
     the model.

To debug a hook in isolation, pipe a fake event into it directly:

```powershell
$payload = '{"taskId":"t1","hookName":"PostToolUse","workspaceRoots":["C:/path/to/repo"],"postToolUse":{"toolName":"write_to_file","parameters":{"path":"src/Hero.tsx"},"success":true,"result":"","executionTimeMs":12}}'
$payload | powershell -NoProfile -File .clinerules/hooks/PostToolUse.ps1
```

The hook always writes its JSON response to stdout. Anything to stderr is
debug-only and ignored by Cline.

## What is pending (in priority order)

1. **macOS/Linux ports of the hooks.** Bash scripts with the same logic;
   needs `jq` for JSON parsing. Trivial port — copy from the doc page
   examples.
2. **Tighten AP-06 false-positives.** Right now `border-radius > 2px` flags
   everywhere. The spec carves out an exception for `industries-grid`
   tiles (4px allowed). Heuristic to add: skip the check when the file
   path or surrounding selector contains `industries` / `industries-grid`.
3. **More semantic blockers.** AP-01 (centered hero), AP-02 (card layouts
   outside industries-grid), AP-09..AP-13. These need light AST work
   (parse JSX/HTML, find the hero element, check its `text-align`/
   `justify-items`/Flex/Grid). Probably worth doing with `acorn` or
   `htmlparser2` rather than regex.
4. **Wire the validator into the bufab-mcp server as a tool.** Right now
   the validator is only reachable via the hook. Exposing it as
   `validate_files(paths[])` makes it callable by any MCP client (Claude
   Code, Cursor with MCP, Replit Agent if/when it supports MCP).
5. **CI safety net.** Replit code does not pass through Cline at all, so
   the hooks never fire on it. The only place to catch a Replit-generated
   violation is when the code is pushed to the SCM. Add a CI step
   (Azure DevOps Pipelines / GitHub Actions) that runs
   `node bufab-mcp/scripts/validate.mjs $(git diff --name-only ...)` on
   every PR and fails the build if `summary.blockers > 0`.
6. **Pre-commit hook.** Same script, `.git/hooks/pre-commit` (or Husky).
   Catches violations on the dev's machine before they leave it. Lower
   priority than CI because CI is the one that can actually block a merge.
7. **Soft-fail vs hard-fail toggle.** Right now `PostToolUse` never
   cancels the tool. A `BUFAB_HOOK_STRICT=1` env var could flip it to
   `cancel: true` for the demo, where we want to show the tool being
   blocked.
8. **Audit hook for the demo.** A `TaskComplete.ps1` that runs the
   validator across every file Cline touched in the task and emits a
   one-shot scorecard (start at 100, -15 per blocker, -5 per warning, as
   defined in Part 10 of the guideline doc).

## Things that are intentionally NOT in scope here

- **Catching violations in already-committed code.** That is a bulk-audit
  problem; this folder is about the in-flight feedback loop.
- **Enforcing rules outside the UI guideline document** (Azure infra rules,
  governance, etc.). Those have their own MCP tools (`rules_*`,
  `waf_guidelines`) and would need their own validators.
- **Working in Cursor.** Cursor has no hook equivalent. The plan for Cursor
  is to rely on (a) `.cursor/rules` for soft prompt-level guidance and
  (b) the CI safety net described above to actually block bad code.
