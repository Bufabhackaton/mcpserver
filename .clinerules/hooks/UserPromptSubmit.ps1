# Bufab UserPromptSubmit hook for Cline.
#
# Fires every time the user submits a message. We inject a short reminder of
# the most critical Bufab UI blockers and tell Cline to consult the bufab-mcp
# server (ui_section_spec / ui_token / ui_search) before generating any UI.
#
# This is a soft enforcement layer (Cline still has to listen). The hard
# enforcement is PostToolUse, which runs the validator deterministically.

$ErrorActionPreference = "Stop"

function Emit-Json($obj) {
    $obj | ConvertTo-Json -Depth 10 -Compress
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Emit-Json @{ cancel = $false }
        exit 0
    }

    # We don't actually need to inspect the prompt - the reminder is short
    # enough to be cheap on every turn, and skipping it on some turns would
    # let Cline drift. Read it just in case we want heuristics later.
    $event = $raw | ConvertFrom-Json
    $null = $event.userPromptSubmit.prompt

    $reminder = @"
[Bufab UI guidelines are active in this repo]
Blockers (each violation is a -15 score penalty; PR cannot merge):
- AP-03  no gradients anywhere (linear-gradient, radial-gradient, conic-gradient)
- AP-04  accent #E8610A only as CTA button background, never as text/border/icon
- AP-05  no web fonts; system stack only ('Helvetica Neue', Helvetica, Arial, sans-serif)
- AP-06  border-radius max 2px (4px allowed only inside industries-grid tiles)
- AP-07  header background must always be #1f3c46 - no scroll-driven color change
- AP-08  no scroll listeners or .scrolled classes on the header
- AP-01  hero text must be left-aligned, never centered
- AP-02  cards/tiles only inside industries-grid; nowhere else
- COLOR-03 only the Bufab token palette; no ad-hoc hex colors

Before writing UI code, call the bufab-mcp tools:
- ui_section_spec(section_type) for the section you are about to build
- ui_token(name) for any color or spacing value
- ui_search(query) for anything not covered by the two above

A PostToolUse hook will validate every file you write/edit and feed back any
violations it finds. Treat that feedback as a build error - fix and re-edit.

Full reference: guidelines/bufab_ui_guidelines.md
"@

    Emit-Json @{
        cancel = $false
        contextModification = $reminder
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("UserPromptSubmit hook error: $($_.Exception.Message)")
    Emit-Json @{ cancel = $false }
    exit 0
}
