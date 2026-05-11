#!/usr/bin/env node
// bufab-mcp CLI entry. Single bin script that dispatches between the modes
// consumers actually need:
//
//   - bufab-mcp                    -> start the MCP server on stdio
//                                     (dist/index.js, the default mode)
//   - bufab-mcp validate <files>   -> run the UI guideline validator on
//                                     one or more files (scripts/validate.mjs)
//   - bufab-mcp setup              -> register bufab-mcp as an MCP server in
//                                     every known agent config on this machine
//                                     (scripts/setup.mjs)
//
// We spawn the underlying script as a child process rather than dynamic-import
// so process.argv, top-level awaits, and stdio inheritance all behave exactly
// like the prior `node dist/index.js` / `node scripts/validate.mjs` invocations.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const args = process.argv.slice(2);

let target;
let forwardArgs;
if (args[0] === "validate") {
  target = resolve(pkgRoot, "scripts", "validate.mjs");
  forwardArgs = args.slice(1);
} else if (args[0] === "setup") {
  target = resolve(pkgRoot, "scripts", "setup.mjs");
  forwardArgs = args.slice(1);
} else if (args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(
    [
      "Usage:",
      "  bufab-mcp                       Start the MCP server on stdio.",
      "  bufab-mcp validate <files...>   Run the UI guideline validator.",
      "  bufab-mcp setup [flags]         Register bufab-mcp in every known",
      "                                  agent config (Cline, Cursor, Claude Code).",
      "                                  Run once per machine. `bufab-mcp setup --help`",
      "                                  for flags.",
      "  bufab-mcp --help                Show this message.",
      "",
    ].join("\n"),
  );
  process.exit(0);
} else {
  target = resolve(pkgRoot, "dist", "index.js");
  forwardArgs = args;
}

const result = spawnSync(process.execPath, [target, ...forwardArgs], {
  stdio: "inherit",
});
process.exit(result.status ?? 0);
