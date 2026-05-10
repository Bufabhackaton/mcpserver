// Shared utilities used by every per-tool hook adapter (Cline, Cursor,
// Claude Code). Keeps the validator-spawning, BOM-stripping, and report
// formatting in one place so each adapter only has to translate the
// tool-specific input/output schema.
//
// Canonical layout (mirrors bufab-mcp/agent-config after client init):
//   {PROJECT_NAME}/.clinerules/hooks/lib/_core.mjs
//   {PROJECT_NAME}/.clinerules/hooks/lib/validate.mjs   (exported with agent-config)
// where PROJECT_NAME is the app repo root. Validator may still live at
// bufab-mcp/scripts/validate.mjs for older layouts — see resolveValidatorPath.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function validatorBesideCore() {
  return resolve(__dirname, "validate.mjs");
}

function validatorAtPkgScripts(root) {
  return resolve(root, "bufab-mcp", "scripts", "validate.mjs");
}

/**
 * Prefer `hooks/lib/validate.mjs` (exported with agent-config). Else walk ancestors
 * for `bufab-mcp/scripts/validate.mjs`. PROJECT_NAME / folder naming is not hardcoded.
 */
function resolveValidatorPath() {
  const beside = validatorBesideCore();
  if (existsSync(beside)) return beside;

  const maxHops = 24;
  let dir = __dirname;
  for (let i = 0; i < maxHops; i++) {
    const candidate = validatorAtPkgScripts(dir);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return validatorBesideCore();
}

export const VALIDATOR_PATH = resolveValidatorPath();

/** Next to validate.mjs (hooks/lib or bufab-mcp/scripts). */
const BUNDLED_GUIDELINES_SNAPSHOT = resolve(dirname(VALIDATOR_PATH), "bufab-ui-guidelines.snapshot.json");

/**
 * Point validate.mjs at the bundled JSON before `loadGuidelines()` runs. Older
 * validators only support this path (not built-in offline fallback), and the
 * spawned PostToolUse child inherits the same env.
 */
function ensureBundledGuidelinesEnvFromValidatorDir() {
  if (process.env.BUFAB_VALIDATOR_GUIDELINES_FILE?.trim()) return;
  if (existsSync(BUNDLED_GUIDELINES_SNAPSHOT)) {
    process.env.BUFAB_VALIDATOR_GUIDELINES_FILE = BUNDLED_GUIDELINES_SNAPSHOT;
  }
}

ensureBundledGuidelinesEnvFromValidatorDir();

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
    "- Prefer live rules: build bufab-mcp (`npm -C bufab-mcp run build`) and ensure `ui_export` works (seed UI LanceDB via `ui_upsert` / BUFAB_UI_DB_PATH).",
    "- If you only have exported hooks: verify `hooks/lib/bufab-ui-guidelines.snapshot.json` exists next to `validate.mjs` for offline reminder + validation fallback.",
    "",
    "Until this is fixed, treat UI work as blocked (the validator also depends on live MCP guidelines).",
    "",
    "[How to use bufab-mcp for UI + infrastructure]",
    "- For UI: use `ui_section_spec(section_type)`, `ui_token(name)`, and `ui_search(query)` before writing UI code.",
    "- For infrastructure: consult WAF via `waf_guidelines` and internal overlays via `rules_get(slug=bufab-infrastructure-context-overlay)` / `rules_search(query=...)`.",
    "- For Azure Bicep changes: validate with `bicep_validate` (include all required files: main, modules, *.bicepparam, bicepconfig.json).",
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
  lines.push("[Infrastructure guidance]");
  lines.push("- Before finalizing infrastructure decisions, consult WAF via bufab-mcp `waf_guidelines`.");
  lines.push(
    "- Also review internal overlay via `rules_get(slug=bufab-infrastructure-context-overlay)` (or `rules_search(query=...)`).",
  );
  lines.push("- When generating/editing Azure Bicep, validate with bufab-mcp `bicep_validate`.");
  lines.push(
    "  Provide all required files (main, modules, *.bicepparam, bicepconfig.json) so `bicep build` and `bicep lint` can resolve imports.",
  );
  lines.push("");
  lines.push("Full reference: guidelines/bufab_ui_guidelines.md");
  return lines.join("\n");
}

// Computed at module load via top-level await. Each hook spawns a fresh node
// process, so guidelines load runs on every invocation.
// If bufab-ui-guidelines.snapshot.json exists beside validate.mjs, BUFAB_VALIDATOR_GUIDELINES_FILE
// is set so validate.mjs skips MCP (covers PostToolUse + UserPromptSubmit + older validators).
let _g = null;
let _gError = null;
try {
  if (!existsSync(VALIDATOR_PATH)) {
    throw new Error(`validator not found at ${VALIDATOR_PATH}`);
  }
  ensureBundledGuidelinesEnvFromValidatorDir();
  const validatorModule = await import(pathToFileURL(VALIDATOR_PATH).href);
  if (typeof validatorModule?.loadGuidelines !== "function") {
    throw new Error(`loadGuidelines() export missing in ${VALIDATOR_PATH}`);
  }
  _g = await validatorModule.loadGuidelines();
} catch (e) {
  _gError = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    `[bufab] hook init: guideline reminder unavailable (${_gError}). Deploy bufab-ui-guidelines.snapshot.json next to validate.mjs (or set BUFAB_VALIDATOR_GUIDELINES_FILE), prefer live MCP with built bufab-mcp for current tokens.\n`,
  );
}
export const BUFAB_REMINDER = buildReminderFromGuidelines(_g) ?? missingGuidelinesReminder(_gError);

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
