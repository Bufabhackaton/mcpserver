#!/usr/bin/env node
// Cline UserPromptSubmit adapter. Always injects the Bufab guideline
// reminder as `contextModification`.

import { readStdin, BUFAB_REMINDER } from "./_core.mjs";

(async () => {
  await readStdin();
  process.stdout.write(
    JSON.stringify({
      cancel: false,
      contextModification: BUFAB_REMINDER,
    }),
  );
})();
