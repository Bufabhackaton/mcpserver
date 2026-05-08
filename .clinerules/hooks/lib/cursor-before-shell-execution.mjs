#!/usr/bin/env node
// Cursor beforeShellExecution adapter.
//
// Reads the violation ledger written by cursor-after-file-edit.mjs and, if
// any blockers are pending, denies commit/push/publish commands so violating
// code cannot leave the developer's machine. Everything else passes through.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStdin } from "./_core.mjs";

const COMMIT_PATTERNS = [
  /^\s*git\s+commit\b/,
  /^\s*git\s+push\b/,
  /^\s*npm\s+publish\b/,
  /^\s*pnpm\s+publish\b/,
  /^\s*yarn\s+publish\b/,
];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
const allow = () => emit({ permission: "allow" });

function getLedgerPaths(workspace) {
  return [
    resolve(workspace, ".cursor", ".bufab-violations.json"),
    resolve(workspace, ".bufab-violations.json"),
  ];
}

(async () => {
  const raw = await readStdin();
  if (!raw.trim()) allow();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    allow();
  }

  const command = String(event?.command ?? "");
  if (!COMMIT_PATTERNS.some((re) => re.test(command))) allow();

  const workspace = event?.workspace_roots?.[0];
  if (!workspace) allow();

  const [primaryLedgerPath, fallbackLedgerPath] = getLedgerPaths(workspace);
  const ledgerPath = existsSync(primaryLedgerPath)
    ? primaryLedgerPath
    : existsSync(fallbackLedgerPath)
      ? fallbackLedgerPath
      : null;
  if (!ledgerPath) allow();

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    allow();
  }
  if (!ledger?.summary || ledger.summary.blockers === 0) allow();

  const lines = [
    `Bufab guideline blockers must be fixed before "${command.trim()}":`,
    "",
  ];
  for (const v of ledger.violations ?? []) {
    if (v.severity === "blocker") {
      lines.push(`  - [${v.rule}] ${v.file}:${v.line}: ${v.matched} -> ${v.message}`);
    }
  }
  lines.push("");
  lines.push(
    "Re-edit the offending files (afterFileEdit refreshes the ledger) or delete the violations ledger once truly fixed.",
  );

  emit({
    permission: "deny",
    agentMessage: lines.join("\n"),
    userMessage: `Bufab: ${ledger.summary.blockers} blocker(s) pending - see ${ledgerPath.endsWith(".cursor/.bufab-violations.json") ? ".cursor/.bufab-violations.json" : ".bufab-violations.json"}`,
  });
})().catch((e) => {
  process.stderr.write(
    `cursor-before-shell-execution error: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  allow();
});
