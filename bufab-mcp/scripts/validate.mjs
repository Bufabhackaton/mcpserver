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

import { readFileSync, statSync } from "node:fs";
import { extname, basename, sep } from "node:path";

const TOKEN_HEX = new Set(
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

const VALIDATABLE_EXTS = new Set([
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
  if (TOKEN_HEX.has(norm)) return true;
  // Accept any of our raw tokens regardless of normalization shape
  for (const t of TOKEN_HEX) {
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
  return VALIDATABLE_EXTS.has(extname(path).toLowerCase());
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

function validateContent(content, file) {
  const violations = [];
  detectGradients(content, file, violations);
  detectWebFonts(content, file, violations);
  detectBorderRadius(content, file, violations);
  detectHeaderScrollListener(content, file, violations);
  detectAccentColorMisuse(content, file, violations);
  detectOffPaletteHex(content, file, violations);
  detectFontFamilyShape(content, file, violations);
  return violations;
}

async function main() {
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

main().catch((e) => {
  process.stderr.write(`validator crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
