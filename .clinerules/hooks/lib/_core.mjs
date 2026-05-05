// Shared utilities used by every per-tool hook adapter (Cline, Cursor,
// Claude Code). Keeps the validator-spawning, BOM-stripping, and report
// formatting in one place so each adapter only has to translate the
// tool-specific input/output schema.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGuidelines } from "../../../bufab-mcp/scripts/validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// lib/ -> hooks/ -> .clinerules/ -> repo root -> bufab-mcp/scripts/validate.mjs
export const VALIDATOR_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "bufab-mcp",
  "scripts",
  "validate.mjs",
);

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let raw = Buffer.concat(chunks).toString("utf8");
  // Strip a leading UTF-8 BOM. PowerShell's native pipe prepends one which
  // would break JSON.parse downstream.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return raw;
}

export function resolveAgainstWorkspace(relPath, workspaceRoot) {
  if (!relPath) return null;
  if (isAbsolute(relPath)) return relPath;
  if (workspaceRoot) return resolve(workspaceRoot, relPath);
  return relPath;
}

export function runValidator(absPath) {
  if (!absPath || !existsSync(absPath)) return null;
  if (!existsSync(VALIDATOR_PATH)) {
    process.stderr.write(`[bufab] validator not found at ${VALIDATOR_PATH}\n`);
    return null;
  }
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [VALIDATOR_PATH, absPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    process.stderr.write(
      `[bufab] validator failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export function formatViolationReport(displayPath, result) {
  const violations = result?.violations ?? [];
  const blockers = violations.filter((v) => v.severity === "blocker");
  const warnings = violations.filter((v) => v.severity === "warning");
  if (blockers.length === 0 && warnings.length === 0) return null;

  const lines = [`Bufab UI guidelines validator found violations in ${displayPath}:`, ""];
  if (blockers.length) {
    lines.push("BLOCKERS (must fix before this counts as done):");
    for (const v of blockers) {
      lines.push(`  - [${v.rule}] line ${v.line}: ${v.matched} -> ${v.message}`);
    }
  }
  if (warnings.length) {
    lines.push("");
    lines.push("WARNINGS:");
    for (const v of warnings) {
      lines.push(`  - [${v.rule}] line ${v.line}: ${v.matched} -> ${v.message}`);
    }
  }
  lines.push("");
  lines.push("Fix the file and re-edit. Full rules: guidelines/bufab_ui_guidelines.md.");
  return lines.join("\n");
}

// Hardcoded fallback used only when the guidelines JSON is missing. The
// preferred path is buildReminderFromGuidelines() which derives the reminder
// from ui_rules.strict_constraints in the live JSON.
const HARDCODED_REMINDER = `[Bufab UI guidelines are active in this repo]
Blockers (each violation is a -15 score penalty; PR cannot merge):
- AP-03  no gradients anywhere (linear-gradient, radial-gradient, conic-gradient)
- AP-04  accent #E8610A only as CTA button background, never as text/border/icon
- AP-05  no web fonts; system stack only ('Helvetica Neue', Helvetica, Arial, sans-serif)
- AP-06  border-radius max 2px (4px allowed only inside industries-grid tiles)
- AP-07  header background must always be #1f3c46 - no scroll-driven color change
- AP-08  no scroll listeners or .scrolled classes on the header
- AP-01  hero text must be left-aligned, never centered
- AP-02  cards/tiles only inside industries-grid; nowhere else
- COLOR-03 only the Bufab token palette; no ad-hoc hex colors

Before writing UI code, call the bufab-mcp tools:
- ui_section_spec(section_type) for the section you are about to build
- ui_token(name) for any color or spacing value
- ui_search(query) for anything not covered by the two above

A post-write hook will validate every file you write/edit and feed back any
violations it finds. Treat that feedback as a build error - fix and re-edit.

Full reference: guidelines/bufab_ui_guidelines.md`;

function buildReminderFromGuidelines(guidelines) {
  const constraints = guidelines?.ui_rules?.strict_constraints;
  if (!Array.isArray(constraints) || constraints.length === 0) return null;
  const version = guidelines?.meta?.version;
  const lines = [
    `[Bufab UI guidelines are active in this repo${version ? ` (v${version})` : ""}]`,
    "",
    "Strict constraints (each blocker violation is a -15 score penalty; PR cannot merge):",
  ];
  for (const c of constraints) lines.push(`- ${c}`);
  lines.push("");
  lines.push("Before writing UI code, call the bufab-mcp tools:");
  lines.push("- ui_section_spec(section_type) for the section you are about to build");
  lines.push("- ui_token(name) for any color or spacing value");
  lines.push("- ui_search(query) for anything not covered by the two above");
  lines.push("");
  lines.push(
    "A post-write hook will validate every file you write/edit and feed back any",
  );
  lines.push("violations it finds. Treat that feedback as a build error - fix and re-edit.");
  lines.push("");
  lines.push("Full reference: guidelines/bufab_ui_guidelines.md");
  return lines.join("\n");
}

// Computed at module load via top-level await. Each hook spawns a fresh node
// process, so this re-fetches the guidelines on every invocation — edits to
// the JSON (or to LanceDB via ui_upsert when BUFAB_GUIDELINES_SOURCE=mcp)
// land immediately without a redeploy.
const _g = await loadGuidelines(__dirname);
export const BUFAB_REMINDER = _g
  ? (buildReminderFromGuidelines(_g) ?? HARDCODED_REMINDER)
  : HARDCODED_REMINDER;
