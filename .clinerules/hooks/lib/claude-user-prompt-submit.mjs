#!/usr/bin/env node
// Claude Code UserPromptSubmit adapter. Always returns the Bufab reminder
// via hookSpecificOutput.additionalContext.

import { readStdin, BUFAB_REMINDER } from "./_core.mjs";

(async () => {
  await readStdin();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: BUFAB_REMINDER,
      },
    }),
  );
})();
