#!/usr/bin/env node
// Cline PostToolUse adapter. Translates Cline's hook payload to the shared
// validator pipeline and emits Cline's response shape.

import {
  readStdin,
  resolveAgainstWorkspace,
  runValidator,
  formatViolationReport,
} from "./_core.mjs";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
const pass = () => emit({ cancel: false });

(async () => {
  const raw = await readStdin();
  if (!raw.trim()) pass();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    pass();
  }

  const tool = event?.postToolUse?.toolName;
  if (tool !== "write_to_file" && tool !== "replace_in_file") pass();
  if (event.postToolUse.success === false) pass();

  const relPath = event.postToolUse?.parameters?.path;
  if (!relPath) pass();

  const absPath = resolveAgainstWorkspace(relPath, event.workspaceRoots?.[0]);
  const result = runValidator(absPath);
  if (!result) pass();

  const message = formatViolationReport(relPath, result);
  if (!message) pass();

  emit({ cancel: false, contextModification: message });
})().catch((e) => {
  process.stderr.write(`PostToolUse hook error: ${e instanceof Error ? e.stack : String(e)}\n`);
  pass();
});
