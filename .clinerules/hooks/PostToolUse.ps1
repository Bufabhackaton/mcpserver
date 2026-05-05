# PostToolUse Cline hook - Windows shim.
# Spawns node on the cross-platform implementation under lib/ and pipes the
# Cline event into it via redirected stdin. We use System.Diagnostics.Process
# directly because PowerShell's native-command pipe corrupts stdin in some
# Cline harness versions.
# See ./README.md for the contract and what the hook does.
$ErrorActionPreference = "Stop"
$stdin = [Console]::In.ReadToEnd()
$impl = Join-Path $PSScriptRoot "lib\post-tool-use.mjs"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "node"
$psi.Arguments = '"' + $impl + '"'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Write($stdin)
$proc.StandardInput.Close()
$out = $proc.StandardOutput.ReadToEnd()
$err = $proc.StandardError.ReadToEnd()
$proc.WaitForExit()

if ($out) { [Console]::Out.Write($out) }
if ($err) { [Console]::Error.Write($err) }
exit $proc.ExitCode
