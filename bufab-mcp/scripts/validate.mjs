#!/usr/bin/env node
// Bufab UI guidelines validator.
//
// Detects deterministic blocker/warning violations defined in
// guidelines/bufab_ui_guidelines.md (Part 9 anti-patterns and Parts 3-5 rules).
//
// Usage:
//   node validate.mjs <path> [<path> ...]            # validate specific files
//   node validate.mjs --stdin                        # read content from stdin (single file)
//   node validate.mjs --content '...' --file foo.tsx # validate inline content
//
// Output: JSON on stdout.
//   {
//     "violations": [{ rule, severity, file, line, matched, message }],
//     "summary":    { blockers, warnings, filesScanned }
//   }
// Exit code: 0 always (the consumer decides how to react). Errors go to stderr.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, basename, join, resolve as resolvePath, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Guideline source loader
//
// The hardcoded constants below are *fallback* values. The validator prefers
// to read the live guidelines whenever it can — so a guideline change (new
// accepted color, new forbidden font, new strict_constraint line) propagates
// to every hook fire without a code change. Each hook spawns a fresh `node`
// process, so "load on startup" effectively means "load on every invocation".
//
// $BUFAB_DISABLE_GUIDELINES=1 short-circuits everything and forces hardcoded.
// ---------------------------------------------------------------------------

// Source selection via $BUFAB_GUIDELINES_SOURCE (default: "mcp"):
//   - "file": read bufab_ui_guidelines.json directly (deterministic; preferred for tests)
//   - "mcp":  spawn the bufab-mcp server, call ui_export, parse the result
//             (live LanceDB source of truth; reflects ui_upsert without committing JSON)
//
// Within "file" mode, resolution order is:
//   1. $BUFAB_UI_GUIDELINES_JSON if set and exists
//   2. Walk up from this script's dir; at each level try
//      <dir>/guidelines/bufab_ui_guidelines.json then
//      <dir>/allguidelines/bufab_ui_guidelines.json (legacy)
//   3. Fall back to hardcoded defaults

const GUIDELINES_FILENAME = "bufab_ui_guidelines.json";
const GUIDELINES_DIR_NAMES = ["guidelines", "allguidelines"];
const GUIDELINES_WALK_LIMIT = 10;
const MCP_CALL_TIMEOUT_MS = 30000;

let _cachedGuidelines; // undefined = not attempted; null = attempted, missing/invalid

function findGuidelinesJsonPath(startDir) {
  const fromEnv = process.env.BUFAB_UI_GUIDELINES_JSON;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  let dir = startDir;
  for (let i = 0; i < GUIDELINES_WALK_LIMIT; i++) {
    for (const name of GUIDELINES_DIR_NAMES) {
      const candidate = join(dir, name, GUIDELINES_FILENAME);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadGuidelinesFromFileSync(startDir) {
  const path = findGuidelinesJsonPath(startDir);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    process.stderr.write(
      `[bufab] failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

function loadGuidelinesFromMcp() {
  return new Promise((resolveP, rejectP) => {
    const mcpBinary = resolvePath(__dirname, "..", "dist", "index.js");
    if (!existsSync(mcpBinary)) {
      rejectP(new Error(`MCP not built at ${mcpBinary}; run 'npm run build' in bufab-mcp`));
      return;
    }
    const childEnv = { ...process.env };
    const child = spawn(process.execPath, [mcpBinary], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    const rl = createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const request = (method, params) => {
      const id = nextId++;
      send({ jsonrpc: "2.0", id, method, params });
      return new Promise((res) => pending.set(id, res));
    };
    const cleanup = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectP(new Error(`MCP call timed out after ${MCP_CALL_TIMEOUT_MS}ms`));
    }, MCP_CALL_TIMEOUT_MS);
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const cb = pending.get(msg.id);
        pending.delete(msg.id);
        cb(msg);
      }
    });
    child.stderr.on("data", () => {
      /* swallow MCP boot logs */
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      cleanup();
      rejectP(e);
    });
    (async () => {
      try {
        const init = await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bufab-validator", version: "1.0.0" },
        });
        if (init.error) throw new Error(JSON.stringify(init.error));
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const out = await request("tools/call", {
          name: "ui_export",
          arguments: {},
        });
        if (out.error) throw new Error(JSON.stringify(out.error));
        const text = out.result?.content?.[0]?.text;
        if (!text) throw new Error("empty ui_export response");
        const guidelines = JSON.parse(text);
        clearTimeout(timeout);
        cleanup();
        resolveP(guidelines);
      } catch (e) {
        clearTimeout(timeout);
        cleanup();
        rejectP(e);
      }
    })();
  });
}

export async function loadGuidelines(startDir = __dirname) {
  if (_cachedGuidelines !== undefined) return _cachedGuidelines;
  if (process.env.BUFAB_DISABLE_GUIDELINES === "1") {
    _cachedGuidelines = null;
    return null;
  }
  const source = (process.env.BUFAB_GUIDELINES_SOURCE || "mcp").toLowerCase();
  if (source === "file") {
    const fromFile = loadGuidelinesFromFileSync(startDir);
    _cachedGuidelines = fromFile ?? null;
    return _cachedGuidelines;
  }
  try {
    const fromMcp = await loadGuidelinesFromMcp();
    _cachedGuidelines = fromMcp ?? null;
    return _cachedGuidelines;
  } catch (e) {
    process.stderr.write(
      `[bufab] MCP source failed (${e instanceof Error ? e.message : String(e)}); falling back to file\n`,
    );
  }
  const fromFile = loadGuidelinesFromFileSync(startDir);
  _cachedGuidelines = fromFile ?? null;
  return _cachedGuidelines;
}

function extractAllTokenHex(guidelines) {
  const set = new Set();
  const visit = (val) => {
    if (typeof val === "string") {
      const matches = val.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (matches) for (const m of matches) set.add(m.toLowerCase());
    } else if (Array.isArray(val)) {
      for (const v of val) visit(v);
    } else if (val && typeof val === "object") {
      for (const v of Object.values(val)) visit(v);
    }
  };
  visit(guidelines);
  // Accept short and long forms of black/white interchangeably.
  if (set.has("#ffffff")) set.add("#fff");
  if (set.has("#fff")) set.add("#ffffff");
  if (set.has("#000000")) set.add("#000");
  if (set.has("#000")) set.add("#000000");
  return set;
}

const HARDCODED_TOKEN_HEX = new Set(
  [
    "#0D3349",
    "#1f3c46",
    "#325c6d",
    "#E8610A",
    "#C4520A",
    "#FFFFFF",
    "#FFF",
    "#F4F6F8",
    "#1A1A1A",
    "#5C6B7A",
    "#D0D7DE",
    "#000000",
    "#000",
  ].map((s) => s.toLowerCase()),
);

let _tokenHexSet = null;
function getTokenHexSet() {
  if (_tokenHexSet) return _tokenHexSet;
  // Sync access path. Reads from the pre-warmed cache if available; otherwise
  // does a sync file load when source=file; otherwise falls back to hardcoded.
  let g = _cachedGuidelines;
  if (g === undefined) {
    if (process.env.BUFAB_DISABLE_GUIDELINES !== "1") {
      const source = (process.env.BUFAB_GUIDELINES_SOURCE || "mcp").toLowerCase();
      if (source === "file") {
        g = loadGuidelinesFromFileSync(__dirname);
      }
    }
    _cachedGuidelines = g ?? null;
  }
  if (g) {
    _tokenHexSet = extractAllTokenHex(g);
  } else {
    process.stderr.write(
      "[bufab] guidelines not loaded; using hardcoded token defaults. Set BUFAB_GUIDELINES_SOURCE=file (and/or BUFAB_UI_GUIDELINES_JSON) for deterministic loading.\n",
    );
    _tokenHexSet = HARDCODED_TOKEN_HEX;
  }
  return _tokenHexSet;
}

const UI_VALIDATABLE_EXTS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".vue",
  ".svelte",
  ".astro",
]);

const IAC_VALIDATABLE_EXTS = new Set([".bicep", ".bicepparam", ".tf"]);

const INFRA_RULE_SLUG = "bufab-infrastructure-context-overlay";

const WEB_FONT_NAMES = [
  "Inter",
  "Roboto",
  "Poppins",
  "Montserrat",
  "Open Sans",
  "Lato",
  "Nunito",
  "Source Sans",
  "Source Sans Pro",
  "Raleway",
  "Ubuntu",
  "Work Sans",
  "Manrope",
  "DM Sans",
  "Plus Jakarta",
  "Geist",
];

function normalizeHex(hex) {
  const lower = hex.toLowerCase();
  if (lower.length === 4) {
    // #abc -> #aabbcc
    return `#${lower[1]}${lower[1]}${lower[2]}${lower[2]}${lower[3]}${lower[3]}`;
  }
  return lower;
}

function isTokenHex(hex) {
  const norm = normalizeHex(hex);
  const set = getTokenHexSet();
  if (set.has(norm)) return true;
  for (const t of set) {
    if (normalizeHex(t) === norm) return true;
  }
  return false;
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function pushViolation(out, v) {
  out.push(v);
}

function detectGradients(content, file, out) {
  const re = /\b(linear-gradient|radial-gradient|conic-gradient)\s*\(/g;
  for (const m of content.matchAll(re)) {
    pushViolation(out, {
      rule: "AP-03",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: m[0],
      message:
        "Gradients are forbidden (AP-03). The single permitted exception is a <linearGradient> inside a technical SVG diagram representing a continuous physical property.",
    });
  }
}

function detectWebFonts(content, file, out) {
  const fontFaceRe = /@font-face\s*\{/g;
  for (const m of content.matchAll(fontFaceRe)) {
    pushViolation(out, {
      rule: "AP-05",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: "@font-face",
      message:
        "@font-face is forbidden (AP-05). Use the system font stack: 'Helvetica Neue', Helvetica, Arial, sans-serif.",
    });
  }
  const cdnRe = /(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net)/g;
  for (const m of content.matchAll(cdnRe)) {
    pushViolation(out, {
      rule: "AP-05",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: m[0],
      message:
        "Web font CDN reference forbidden (AP-05). Remove the import and rely on the system font stack.",
    });
  }
  // Direct font-family declarations using known web fonts
  for (const name of WEB_FONT_NAMES) {
    const re = new RegExp(
      `font-family\\s*:[^;]*['"\`]${name.replace(/\s+/g, "\\s+")}['"\`]`,
      "gi",
    );
    for (const m of content.matchAll(re)) {
      pushViolation(out, {
        rule: "TYPE-01",
        severity: "blocker",
        file,
        line: lineOf(content, m.index),
        matched: m[0],
        message: `Web/Google font '${name}' is forbidden (TYPE-01). Use 'Helvetica Neue', Helvetica, Arial, sans-serif.`,
      });
    }
  }
}

function detectBorderRadius(content, file, out) {
  // CSS: border-radius: <n>px (or rem)
  const cssRe = /border-radius\s*:\s*([^;]+);/gi;
  for (const m of content.matchAll(cssRe)) {
    const value = m[1];
    const pxMatch = value.match(/(\d+(?:\.\d+)?)\s*px/);
    if (pxMatch) {
      const px = Number(pxMatch[1]);
      if (px > 2) {
        pushViolation(out, {
          rule: "AP-06",
          severity: "blocker",
          file,
          line: lineOf(content, m.index),
          matched: `border-radius: ${value.trim()}`,
          message: `border-radius ${px}px exceeds the 2px maximum (AP-06). Exception: industries-grid tiles allow up to 4px.`,
        });
      }
    }
    const remMatch = value.match(/(\d+(?:\.\d+)?)\s*rem/);
    if (remMatch && Number(remMatch[1]) > 0.125) {
      pushViolation(out, {
        rule: "AP-06",
        severity: "blocker",
        file,
        line: lineOf(content, m.index),
        matched: `border-radius: ${value.trim()}`,
        message: `border-radius ${remMatch[1]}rem exceeds the 2px (~0.125rem) maximum (AP-06).`,
      });
    }
  }
  // Tailwind class names
  const twRe = /\brounded(?:-(?:t|r|b|l|tl|tr|bl|br))?-(md|lg|xl|2xl|3xl|full)\b/g;
  for (const m of content.matchAll(twRe)) {
    pushViolation(out, {
      rule: "AP-06",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: m[0],
      message: `Tailwind class '${m[0]}' implies border-radius > 2px (AP-06). Use 'rounded-none' or 'rounded-sm' (2px).`,
    });
  }
  // Tailwind arbitrary value: rounded-[Npx]
  const twArbRe = /\brounded(?:-(?:t|r|b|l|tl|tr|bl|br))?-\[(\d+(?:\.\d+)?)px\]/g;
  for (const m of content.matchAll(twArbRe)) {
    const px = Number(m[1]);
    if (px > 2) {
      pushViolation(out, {
        rule: "AP-06",
        severity: "blocker",
        file,
        line: lineOf(content, m.index),
        matched: m[0],
        message: `Tailwind '${m[0]}' = ${px}px exceeds the 2px maximum (AP-06).`,
      });
    }
  }
}

function detectHeaderScrollListener(content, file, out) {
  // Heuristic: a scroll handler near the word "header" or class names like .scrolled / isScrolled.
  const heuristics = [
    /\.scrolled\b/g,
    /\bisScrolled\b/g,
    /\bsetScrolled\b/g,
    /\bsetIsScrolled\b/g,
    /addEventListener\s*\(\s*['"`]scroll['"`]/g,
    /window\.onscroll\s*=/g,
  ];
  for (const re of heuristics) {
    for (const m of content.matchAll(re)) {
      // Only flag if "header" appears within ±400 chars to reduce false positives.
      const window = content.slice(Math.max(0, m.index - 400), m.index + 400);
      if (/\bheader\b/i.test(window) || /<Header\b/.test(window)) {
        pushViolation(out, {
          rule: "AP-07/08",
          severity: "blocker",
          file,
          line: lineOf(content, m.index),
          matched: m[0],
          message:
            "Header must not change appearance on scroll (AP-07/08). Remove scroll listeners and conditional classes; the header stays #1f3c46 always.",
        });
        break; // one finding per heuristic is enough
      }
    }
  }
}

function detectAccentColorMisuse(content, file, out) {
  // #E8610A used in non-background contexts is suspicious (AP-04).
  const re = /(color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color)\s*:\s*#E8610A\b/gi;
  for (const m of content.matchAll(re)) {
    pushViolation(out, {
      rule: "AP-04",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: m[0],
      message:
        "Accent orange #E8610A must appear only as a CTA button background (AP-04). Forbidden as text/border/icon color.",
    });
  }
}

function detectOffPaletteHex(content, file, out) {
  // Find all hex colors and warn on anything outside the token set.
  const re = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g;
  const seen = new Set();
  for (const m of content.matchAll(re)) {
    if (isTokenHex(m[0])) continue;
    const key = `${m[0].toLowerCase()}@${lineOf(content, m.index)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushViolation(out, {
      rule: "COLOR-03",
      severity: "blocker",
      file,
      line: lineOf(content, m.index),
      matched: m[0],
      message: `Color ${m[0]} is not in the Bufab token set (COLOR-03). Replace with a token from bufab_ui_guidelines.json (e.g. #1f3c46, #E8610A, #325c6d, #F4F6F8, #D0D7DE).`,
    });
  }
}

function detectFontFamilyShape(content, file, out) {
  // font-family declarations missing the canonical system stack.
  const re = /font-family\s*:\s*([^;{}]+)[;}\n]/gi;
  for (const m of content.matchAll(re)) {
    const value = m[1].toLowerCase();
    const looksSystem =
      value.includes("helvetica neue") ||
      value.includes("helvetica") ||
      value.includes("arial") ||
      value.includes("sans-serif") ||
      value.includes("system-ui") ||
      value.includes("inherit") ||
      value.includes("var(") ||
      value.includes("initial") ||
      value.includes("unset");
    if (!looksSystem) {
      pushViolation(out, {
        rule: "TYPE-01",
        severity: "warning",
        file,
        line: lineOf(content, m.index),
        matched: m[0].trim(),
        message:
          "font-family does not include the system stack (TYPE-01). Use: 'Helvetica Neue', Helvetica, Arial, sans-serif.",
      });
    }
  }
}

function isValidatableFile(path) {
  const ext = extname(path).toLowerCase();
  if (UI_VALIDATABLE_EXTS.has(ext)) return true;
  if (IAC_VALIDATABLE_EXTS.has(ext)) return true;
  if (path.toLowerCase().endsWith(".tf.json")) return true;
  return false;
}

function isUiFile(path) {
  return UI_VALIDATABLE_EXTS.has(extname(path).toLowerCase());
}

function isIacFile(path) {
  const ext = extname(path).toLowerCase();
  if (IAC_VALIDATABLE_EXTS.has(ext)) return true;
  if (path.toLowerCase().endsWith(".tf.json")) return true;
  return false;
}

function shouldSkipPath(path) {
  const norm = path.replace(/\\/g, "/");
  return (
    norm.includes("/node_modules/") ||
    norm.includes("/dist/") ||
    norm.includes("/.git/") ||
    norm.includes("/.next/") ||
    norm.includes("/build/")
  );
}

// ---------------------------------------------------------------------------
// Infrastructure-as-code checks
//
// Driven by the rule body stored under slug `bufab-infrastructure-context-overlay`
// in the MCP `.lancedb` (rules_*). The actual rule text is prose, so the
// regex-level checks are hardcoded here against the well-known Bufab
// expectations: required tags, naming convention, and no hardcoded secrets.
// Each violation message points back at `rules_get(slug=...)` so the agent or
// dev can fetch the full rationale.
// ---------------------------------------------------------------------------

function fileLooksLikeBicep(content, file) {
  return file.toLowerCase().endsWith(".bicep") || file.toLowerCase().endsWith(".bicepparam");
}

function fileLooksLikeTerraform(file) {
  const lower = file.toLowerCase();
  return lower.endsWith(".tf") || lower.endsWith(".tf.json");
}

function detectInfraRequiredTags(content, file, out) {
  if (!isIacFile(file)) return;
  // Skip parameter-only files; they shouldn't carry tags.
  if (file.toLowerCase().endsWith(".bicepparam")) return;
  // Heuristic: only flag files that actually declare resources.
  const declaresBicepResource = /^\s*resource\s+\S+\s+'/m.test(content);
  const declaresTerraformResource = /^\s*resource\s+"[^"]+"\s+"/m.test(content);
  if (!declaresBicepResource && !declaresTerraformResource) return;

  const required = ["Owner", "CostCenter", "ProjectID"];
  const missing = required.filter((k) => !new RegExp(`\\b${k}\\b`).test(content));
  if (missing.length === 0) return;

  pushViolation(out, {
    rule: "INFRA-01",
    severity: "blocker",
    file,
    line: 1,
    matched: "(file scan)",
    message:
      `Missing required Bufab tags: ${missing.join(", ")}. ` +
      `Every Azure resource must be tagged with Owner, CostCenter, and ProjectID. ` +
      `See rules_get(slug=${INFRA_RULE_SLUG}) for the full overlay.`,
  });
}

function detectInfraNaming(content, file, out) {
  if (!isIacFile(file)) return;

  // Bicep: `name: 'literal-string'` (skip interpolated `${...}` values).
  if (fileLooksLikeBicep(content, file)) {
    const re = /^[ \t]*name\s*:\s*'([^'$\n]+)'/gm;
    for (const m of content.matchAll(re)) {
      const value = m[1];
      if (!value.startsWith("bufab-")) {
        pushViolation(out, {
          rule: "INFRA-02",
          severity: "warning",
          file,
          line: lineOf(content, m.index),
          matched: m[0].trim(),
          message:
            `Resource name '${value}' should follow bufab-<env>-<region>-<app>-<resource>. ` +
            `See rules_get(slug=${INFRA_RULE_SLUG}).`,
        });
      }
    }
  }

  // Terraform HCL: `name = "literal-string"` (skip interpolated `${...}` values).
  if (fileLooksLikeTerraform(file)) {
    const re = /^[ \t]*name\s*=\s*"([^"$\n]+)"/gm;
    for (const m of content.matchAll(re)) {
      const value = m[1];
      if (!value.startsWith("bufab-")) {
        pushViolation(out, {
          rule: "INFRA-02",
          severity: "warning",
          file,
          line: lineOf(content, m.index),
          matched: m[0].trim(),
          message:
            `Resource name '${value}' should follow bufab-<env>-<region>-<app>-<resource>. ` +
            `See rules_get(slug=${INFRA_RULE_SLUG}).`,
        });
      }
    }
  }
}

function detectHardcodedSecrets(content, file, out) {
  if (!isIacFile(file)) return;

  const patterns = [
    {
      re: /AccountKey=[A-Za-z0-9+/=]{20,}/g,
      label: "storage AccountKey",
      remediation: "use Key Vault references or Managed Identity",
    },
    {
      re: /SharedAccessSignature=[^"'\s]{20,}/g,
      label: "Shared Access Signature",
      remediation: "use Managed Identity",
    },
    {
      re: /\bsv=\d{4}-\d{2}-\d{2}&[^"'\s]*sig=/g,
      label: "SAS token",
      remediation: "use Managed Identity",
    },
    {
      // Catch field names like `password`, `pwd`, `secret`, `clientSecret`,
      // and the snake_case variants (`administrator_login_password`,
      // `client_secret`) followed by an assignment to a quoted literal.
      re: /\w*(?:password|pwd|secret)\w*\s*[:=]\s*(['"])[^'"\n]{6,}\1/gi,
      label: "credential",
      remediation: "load from Key Vault or env, never as a literal",
    },
  ];

  for (const p of patterns) {
    for (const m of content.matchAll(p.re)) {
      pushViolation(out, {
        rule: "INFRA-03",
        severity: "blocker",
        file,
        line: lineOf(content, m.index),
        matched: m[0].slice(0, 40) + (m[0].length > 40 ? "..." : ""),
        message:
          `Hardcoded ${p.label} in IaC file — ${p.remediation}. ` +
          `See rules_get(slug=${INFRA_RULE_SLUG}).`,
      });
    }
  }
}

function validateContent(content, file) {
  const violations = [];
  if (isUiFile(file)) {
    detectGradients(content, file, violations);
    detectWebFonts(content, file, violations);
    detectBorderRadius(content, file, violations);
    detectHeaderScrollListener(content, file, violations);
    detectAccentColorMisuse(content, file, violations);
    detectOffPaletteHex(content, file, violations);
    detectFontFamilyShape(content, file, violations);
  }
  if (isIacFile(file)) {
    detectInfraRequiredTags(content, file, violations);
    detectInfraNaming(content, file, violations);
    detectHardcodedSecrets(content, file, violations);
  }
  return violations;
}

async function main() {
  // Pre-warm the guidelines cache so detection functions can read it
  // synchronously. Required when BUFAB_GUIDELINES_SOURCE=mcp.
  await loadGuidelines();
  const argv = process.argv.slice(2);
  let mode = "files";
  let stdinFile = "<stdin>";
  let inlineContent = null;
  let inlineFile = null;
  const paths = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdin") {
      mode = "stdin";
    } else if (a === "--stdin-file") {
      stdinFile = argv[++i] ?? "<stdin>";
    } else if (a === "--content") {
      mode = "inline";
      inlineContent = argv[++i] ?? "";
    } else if (a === "--file") {
      inlineFile = argv[++i] ?? "<inline>";
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node validate.mjs <path> [<path> ...]\n" +
          "       node validate.mjs --stdin [--stdin-file <name>]\n" +
          "       node validate.mjs --content '<text>' --file <name>\n",
      );
      return;
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
    } else {
      paths.push(a);
    }
  }

  const allViolations = [];
  let filesScanned = 0;

  if (mode === "stdin") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString("utf8");
    if (isValidatableFile(stdinFile)) {
      filesScanned++;
      allViolations.push(...validateContent(content, stdinFile));
    }
  } else if (mode === "inline") {
    const file = inlineFile ?? "<inline>";
    if (isValidatableFile(file)) {
      filesScanned++;
      allViolations.push(...validateContent(inlineContent ?? "", file));
    }
  } else {
    for (const p of paths) {
      try {
        if (shouldSkipPath(p)) continue;
        const st = statSync(p);
        if (!st.isFile()) continue;
        if (!isValidatableFile(p)) continue;
        const content = readFileSync(p, "utf8");
        filesScanned++;
        allViolations.push(...validateContent(content, p));
      } catch (e) {
        process.stderr.write(`Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }

  const blockers = allViolations.filter((v) => v.severity === "blocker").length;
  const warnings = allViolations.filter((v) => v.severity === "warning").length;
  const result = {
    violations: allViolations,
    summary: { blockers, warnings, filesScanned },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// Only run as CLI when invoked directly (so other modules can `import` the
// helpers — e.g. _core.mjs reusing loadGuidelines).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(`validator crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(2);
  });
}
