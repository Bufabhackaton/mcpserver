#!/usr/bin/env node
// Claude Code PostToolUse adapter. Configured via .claude/settings.json with
// matcher "Edit|Write|MultiEdit". Returns Claude Code's
// hookSpecificOutput.additionalContext shape so the violation report ends
// up in Claude's context on the next turn.

import {
  readStdin,
  resolveAgainstWorkspace,
  runValidator,
  formatViolationReport,
} from "./_core.mjs";

function passThrough() {
  process.exit(0);
}

(async () => {
  const raw = await readStdin();
  if (!raw.trim()) passThrough();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    passThrough();
  }

  const tool = event?.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") passThrough();

  const filePath = event?.tool_input?.file_path;
  if (!filePath) passThrough();

  const absPath = resolveAgainstWorkspace(filePath, event?.cwd);
  const result = runValidator(absPath);
  if (!result) passThrough();

  const message = formatViolationReport(filePath, result);
  if (!message) passThrough();

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: message,
      },
    }),
  );
})().catch((e) => {
  process.stderr.write(`PostToolUse hook error: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(0);
});
