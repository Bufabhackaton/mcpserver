# Bufab PostToolUse hook for Cline.
#
# Runs after every Cline tool invocation. We only act on file-write tools
# (write_to_file, replace_in_file). We feed the touched file into
# bufab-mcp/scripts/validate.mjs and, if blockers/warnings are found, return a
# `contextModification` so Cline sees the violations on the next turn and fixes
# them.
#
# We never set `cancel: true` here — the write already happened. Letting Cline
# see structured feedback and self-correct is the goal.

$ErrorActionPreference = "Stop"

function Emit-Json($obj) {
    # Single-line JSON to stdout, per Cline hook contract.
    $obj | ConvertTo-Json -Depth 10 -Compress
}

function Pass {
    Emit-Json @{ cancel = $false }
    exit 0
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { Pass }

    $event = $raw | ConvertFrom-Json
    $tool = $event.postToolUse.toolName
    if (-not $tool) { Pass }
    if ($tool -ne "write_to_file" -and $tool -ne "replace_in_file") { Pass }
    if ($event.postToolUse.success -eq $false) { Pass }

    $relPath = $event.postToolUse.parameters.path
    if (-not $relPath) { Pass }

    # Resolve path. Cline usually passes workspace-relative paths.
    $workspace = $null
    if ($event.workspaceRoots -and $event.workspaceRoots.Count -gt 0) {
        $workspace = $event.workspaceRoots[0]
    }
    if ([System.IO.Path]::IsPathRooted($relPath)) {
        $absPath = $relPath
    } elseif ($workspace) {
        $absPath = Join-Path $workspace $relPath
    } else {
        $absPath = $relPath
    }
    if (-not (Test-Path $absPath)) { Pass }

    # Validator lives at <repo>/bufab-mcp/scripts/validate.mjs.
    # This script lives at <repo>/.clinerules/hooks/PostToolUse.ps1.
    $validator = Join-Path $PSScriptRoot "..\..\bufab-mcp\scripts\validate.mjs"
    $validator = [System.IO.Path]::GetFullPath($validator)
    if (-not (Test-Path $validator)) {
        [Console]::Error.WriteLine("validator not found at $validator")
        Pass
    }

    $stdout = & node $validator $absPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $stdout) { Pass }

    $result = $stdout | ConvertFrom-Json
    if (-not $result.violations -or $result.violations.Count -eq 0) { Pass }

    $blockers = @($result.violations | Where-Object { $_.severity -eq "blocker" })
    $warnings = @($result.violations | Where-Object { $_.severity -eq "warning" })

    $lines = @()
    $lines += "Bufab UI guidelines validator found violations in ${relPath}:"
    $lines += ""
    if ($blockers.Count -gt 0) {
        $lines += "BLOCKERS (must fix before this counts as done):"
        foreach ($v in $blockers) {
            $lines += "  - [$($v.rule)] line $($v.line): $($v.matched) -> $($v.message)"
        }
    }
    if ($warnings.Count -gt 0) {
        $lines += ""
        $lines += "WARNINGS:"
        foreach ($v in $warnings) {
            $lines += "  - [$($v.rule)] line $($v.line): $($v.matched) -> $($v.message)"
        }
    }
    $lines += ""
    $lines += "Fix the file and re-edit. Full rules: guidelines/bufab_ui_guidelines.md."

    Emit-Json @{
        cancel = $false
        contextModification = ($lines -join "`n")
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine("PostToolUse hook error: $($_.Exception.Message)")
    Pass
}
