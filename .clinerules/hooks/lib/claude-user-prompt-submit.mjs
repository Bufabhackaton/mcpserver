#!/usr/bin/env node
// Claude Code UserPromptSubmit adapter. Always returns the Bufab reminder
// via hookSpecificOutput.additionalContext.

import {
  readStdin,
  BUFAB_REMINDER,
  BUFAB_INFRA_REMINDER,
  BUFAB_WAF_REMINDER,
  BUFAB_MCP_INFRA_REMINDER,
} from "./_core.mjs";

(async () => {
  await readStdin();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          BUFAB_REMINDER + BUFAB_WAF_REMINDER + BUFAB_MCP_INFRA_REMINDER + BUFAB_INFRA_REMINDER,
      },
    }),
  );
})();
