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
    const message = `validator not found at ${VALIDATOR_PATH}`;
    process.stderr.write(`[bufab] ${message}\n`);
    return {
      violations: [
        {
          rule: "VALIDATOR-00",
          severity: "blocker",
          file: absPath,
          line: 1,
          matched: "<validator missing>",
          message: `Validator infrastructure error: ${message}`,
        },
      ],
      summary: { blockers: 1, warnings: 0, filesScanned: 1 },
    };
  }
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [VALIDATOR_PATH, absPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const details =
      e && typeof e === "object" && "stderr" in e && typeof e.stderr === "string" && e.stderr.trim()
        ? e.stderr.trim()
        : e instanceof Error
          ? e.message
          : String(e);
    process.stderr.write(
      `[bufab] validator failed: ${details}\n`,
    );
    return {
      violations: [
        {
          rule: "VALIDATOR-00",
          severity: "blocker",
          file: absPath,
          line: 1,
          matched: "<validator failed>",
          message: `Validator infrastructure error: ${details}`,
        },
      ],
      summary: { blockers: 1, warnings: 0, filesScanned: 1 },
    };
  }
  try {
    return JSON.parse(stdout);
  } catch {
    const details = `validator output was not valid JSON: ${String(stdout).slice(0, 300)}`;
    process.stderr.write(`[bufab] ${details}\n`);
    return {
      violations: [
        {
          rule: "VALIDATOR-00",
          severity: "blocker",
          file: absPath,
          line: 1,
          matched: "<invalid validator output>",
          message: `Validator infrastructure error: ${details}`,
        },
      ],
      summary: { blockers: 1, warnings: 0, filesScanned: 1 },
    };
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
const HARDCODED_REMINDER = `[Bufab UI guidelines are active in this repo (v2.0.1)]
Strict constraints (each blocker violation is a -15 score penalty; PR cannot merge):
- AP-03  Glassmorphism theme: Always use the dark teal gradient for page background.
- AP-04  Accents: Use #4ecdc4 (Cyan) for primary actions and #a8d8e8 (Sky Blue) for secondary.
- AP-05  Typography: Use 'Roboto', 'Roboto Condensed', or 'Roboto Mono'.
- AP-06  Surfaces: All glass surfaces must have backdrop-filter: blur(12px) and 1px border.
- AP-07  Depth: Every glass surface must have an inner top highlight (inset 0 1px 0 rgba(255,255,255,0.18)).
- AP-08  Header: Fixed/sticky, height 60px, fully transparent glass. No scroll-driven changes.
- COLOR-03 only the Bufab token palette; no ad-hoc hex colors.

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
// process, so this re-fetches live MCP/LanceDB guidelines on every invocation.
// If live loading fails (MCP unavailable, empty UI DB, etc.), do not crash hook
// module initialization — fall back to the static reminder text.
let _g = null;
try {
  _g = await loadGuidelines();
} catch (e) {
  process.stderr.write(
    `[bufab] warning: failed to load live guidelines for reminder text; using hardcoded reminder (${
      e instanceof Error ? e.message : String(e)
    })\n`,
  );
}
export const BUFAB_REMINDER = buildReminderFromGuidelines(_g) ?? HARDCODED_REMINDER;
