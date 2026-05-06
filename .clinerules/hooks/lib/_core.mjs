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

function missingGuidelinesReminder(details) {
  const lines = [
    "[Bufab UI guidelines reminder unavailable]",
    "",
    "Live UI guidelines could not be loaded from the MCP server (ui_export).",
    details ? `Reason: ${details}` : null,
    "",
    "Fix:",
    "- build bufab-mcp (`npm -C bufab-mcp run build`)",
    "- seed UI LanceDB via `ui_upsert` (or ensure BUFAB_UI_DB_PATH points at a populated DB)",
    "",
    "Until this is fixed, treat UI work as blocked (the validator also depends on live MCP guidelines).",
  ].filter(Boolean);
  return lines.join("\n");
}

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
let _gError = null;
try {
  _g = await loadGuidelines();
} catch (e) {
  _gError = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[bufab] error: failed to load live guidelines for reminder text (${_gError})\n`);
}
export const BUFAB_REMINDER = buildReminderFromGuidelines(_g) ?? missingGuidelinesReminder(_gError);

// Add a short infra reminder (kept static to avoid doing filesystem scans in hooks).
export const BUFAB_INFRA_REMINDER =
  "\n\n[Bufab infrastructure note]\n" +
  "When generating or editing Azure Bicep infrastructure, validate with bufab-mcp `bicep_validate`.\n" +
  "Provide all required files (main, modules, *.bicepparam, bicepconfig.json) so `bicep build` and `bicep lint` can resolve imports.";

export const BUFAB_WAF_REMINDER =
  "\n\n[Azure Well-Architected Framework (WAF) check]\n" +
  "Before finalizing infrastructure decisions, consult WAF guidance via bufab-mcp `waf_guidelines` for the relevant Azure service (or omit `service` to list supported services).\n" +
  "Also review internal overlay via `rules_get(slug=bufab-infrastructure-context-overlay)` to ensure Bufab-specific requirements are met.";

export const BUFAB_MCP_INFRA_REMINDER =
  "\n\n[Bufab MCP infrastructure recommendations]\n" +
  "Before finalizing or shipping infrastructure, consult Bufab's infra overlay stored in MCP via `rules_get(slug=bufab-infrastructure-context-overlay)` (or `rules_search(query=...)` for specific topics like tags, naming, secrets, networking).\n" +
  "Treat those rules as the source of truth for internal recommendations on top of WAF.";

export function isBicepRelatedPath(filePath) {
  const p = String(filePath ?? "").toLowerCase();
  return p.endsWith(".bicep") || p.endsWith(".bicepparam") || p.endsWith("bicepconfig.json");
}

export function formatBicepValidateHint(filePath) {
  if (!isBicepRelatedPath(filePath)) return null;
  return [
    "Bicep files were edited in this turn.",
    "Before you consider the infrastructure work done, run `bicep_validate` with all required files (modules, params, bicepconfig.json) and check both `bicep build` and `bicep lint` results.",
  ].join("\n");
}
