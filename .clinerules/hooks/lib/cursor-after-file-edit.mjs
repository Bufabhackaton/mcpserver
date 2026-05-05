#!/usr/bin/env node
// Cursor afterFileEdit adapter.
//
// Cursor's afterFileEdit hook is "informational only" — its stdout is
// discarded, so we cannot push a violation report into the agent's context
// directly (unlike Cline PostToolUse / Claude Code PostToolUse).
//
// Workaround: persist violations to <workspace>/.cursor/.bufab-violations.json
// and surface a one-line summary on stderr (visible in Cursor's "Hooks"
// output channel). The companion beforeShellExecution hook then reads that
// file to block commits/pushes when blockers are pending.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { readStdin, resolveAgainstWorkspace, runValidator } from "./_core.mjs";

(async () => {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = event?.file_path;
  if (!filePath) process.exit(0);

  const workspace = event?.workspace_roots?.[0];
  const absPath = resolveAgainstWorkspace(filePath, workspace);
  const result = runValidator(absPath);
  if (!result) process.exit(0);

  if (!workspace) process.exit(0);
  const ledgerPath = resolve(workspace, ".cursor", ".bufab-violations.json");

  let prior = { violations: [] };
  if (existsSync(ledgerPath)) {
    try {
      prior = JSON.parse(readFileSync(ledgerPath, "utf8"));
    } catch {
      prior = { violations: [] };
    }
  }
  // Drop any prior violations for this same file (we just re-validated it).
  const others = (prior.violations ?? []).filter((v) => v.file !== filePath);
  const merged = [...others, ...(result.violations ?? [])];
  const ledger = {
    violations: merged,
    summary: {
      blockers: merged.filter((v) => v.severity === "blocker").length,
      warnings: merged.filter((v) => v.severity === "warning").length,
    },
    updated_at: new Date().toISOString(),
  };

  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  if (ledger.summary.blockers > 0 || ledger.summary.warnings > 0) {
    process.stderr.write(
      `[bufab] ${filePath}: ${ledger.summary.blockers} blocker(s), ${ledger.summary.warnings} warning(s) - see .cursor/.bufab-violations.json\n`,
    );
  }
  process.exit(0);
})().catch((e) => {
  process.stderr.write(
    `cursor-after-file-edit error: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(0);
});
