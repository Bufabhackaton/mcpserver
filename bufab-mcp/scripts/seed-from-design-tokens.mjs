#!/usr/bin/env node
// Reseeds the UI LanceDB from the canonical Bufab design-tokens JSON
// (default: ../data/bufab-design-tokens.json — the v2.0.1 Glassmorphism
// on Dark Teal source).
//
// Single source of truth: every fragment we write to LanceDB is derived
// from the design-tokens file. The strict_constraints and final_check
// arrays below are hand-written to be CONSISTENT with the v2.0.1 theme
// (so the validator's token set won't pick up legacy hex codes like
// #E8610A through the back door of constraint prose).
//
// Usage:
//   node scripts/seed-from-design-tokens.mjs [path/to/bufab-design-tokens.json]
//
// Run with BUFAB_UI_FORCE_RESEED=1 to clear prior rows before upserting:
//   BUFAB_UI_FORCE_RESEED=1 node scripts/seed-from-design-tokens.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(__dirname, "..", "dist", "index.js");
const defaultTokens = resolve(__dirname, "..", "data", "bufab-design-tokens.json");
const tokensPath = process.argv[2] ? resolve(process.argv[2]) : defaultTokens;

if (!existsSync(mcpEntry)) {
  console.error(`[seed] MCP not built at ${mcpEntry}; run 'npm run build'`);
  process.exit(1);
}
if (!existsSync(tokensPath)) {
  console.error(`[seed] design-tokens file not found at ${tokensPath}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(tokensPath, "utf8"));
const meta = data?.meta;
if (!meta) {
  console.error("[seed] expected design-tokens to have a meta block");
  process.exit(1);
}
const version = meta.version ?? "unknown";

// strict_constraints + final_check for v2.0.1 Glassmorphism on Dark Teal.
// Every line below is consistent with the tokens above — no legacy hex
// codes, no contradictions with the canonical design.
const STRICT_CONSTRAINTS = [
  "Page background is always the dark teal gradient — linear-gradient(135deg, #1f3c46 0%, #0f2028 50%, #1a3a44 100%). Never a flat color or a different gradient.",
  "Every surface (card, panel, sidebar, modal, input) is frosted glass — rgba(255,255,255,0.06) with backdrop-filter blur(12px).",
  "Primary action color is cyan glass — button.primary uses rgba(78,205,196,0.20) background and #4ecdc4 border. Never a different accent color.",
  "Cyan #4ecdc4 is the only saturated accent used for primary actions, focus rings, active states, and CTA glows.",
  "Sky blue #a8d8e8 is the only secondary accent — used for app names in topbar, secondary labels, and upload-zone idle borders.",
  "Headings use Roboto Condensed; body uses Roboto; code/identifiers use Roboto Mono. No other webfonts.",
  "All headings are UPPERCASE with letter-spacing 0.08em.",
  "Border radius comes from the named scale only: 4 / 8 / 12 / 16 / 24 / 9999 (full). No arbitrary values.",
  "Topbar background is rgba(255,255,255,0.04) with blur(20px). Never solid, never a different color.",
  "BUFAB brand name is always #FFFFFF weight 700; app name in the topbar is always #a8d8e8 weight 400.",
  "Buttons use the heading font, UPPERCASE, with letter-spacing 0.08em.",
  "Form inputs have a glass surface and a cyan #4ecdc4 bottom-border on focus, never a different focus color.",
  "Badges are floating glass pills with semantic backgrounds: success #4caf82, warning #f0a040, error #e05c5c, info/brand #4ecdc4.",
  "Tables are glass containers — alternating rows get a sky-blue tint, selected rows get cyan tint plus a 3px cyan left border.",
  "Tone is professional, clear, direct. Sentence case for descriptions, ALL CAPS only for badges and button labels. No marketing fluff.",
];
const FINAL_CHECK = [
  "Is the page background the dark teal gradient (never a flat color)?",
  "Are all surfaces frosted glass with blur(12px) or blur(20px) for overlays?",
  "Is the primary CTA cyan glass (rgba(78,205,196,0.20) with #4ecdc4 border) and never another color?",
  "Do headings use Roboto Condensed uppercase with letter-spacing 0.08em?",
  "Are every color and shadow value referenced from the design-tokens file rather than hardcoded?",
  "Are border radii from the named scale (4/8/12/16/24/full)?",
  "Is the topbar transparent glass with blur(20px), BUFAB in white, app name in sky blue?",
  "Are badges floating glass pills with semantic tinted backgrounds?",
  "Is the writing style direct, professional, no startup or marketing tone?",
  "Are inputs glass with a cyan bottom-border focus state?",
];

// Build the slug → body plan.
const plan = [];

// --- meta ---
plan.push({
  slug: "spec-meta",
  title: "Spec metadata",
  body: meta,
  domain: "general",
});

// --- tokens.* -> tokens-* ---
const tokens = data.tokens ?? {};
const tokenSlugMap = {
  colors: "tokens-colors",
  effects: "tokens-effects",
  typography: "tokens-typography",
  spacing: "tokens-spacing",
  borderRadius: "tokens-borders",
  shadows: "tokens-shadows",
  transitions: "tokens-transitions",
  zIndex: "tokens-zindex",
};
for (const [tokenKey, slug] of Object.entries(tokenSlugMap)) {
  if (tokens[tokenKey]) {
    plan.push({
      slug,
      title: tokenKey,
      body: tokens[tokenKey],
      domain: "tokens",
    });
  }
}

// --- layout -> layout-general ---
if (data.layout) {
  plan.push({
    slug: "layout-general",
    title: "Layout / page shell",
    body: data.layout,
    domain: "layout",
  });
}

// --- components.* -> component-<name> (skip the meta keys) ---
const components = data.components ?? {};
for (const [name, spec] of Object.entries(components)) {
  if (name === "category" || name === "description") continue;
  const slug = `component-${name.toLowerCase()}`;
  plan.push({
    slug,
    title: `${name} component`,
    body: spec,
    domain: "components",
  });
}

// --- writingStyle -> writing-style ---
if (data.writingStyle) {
  plan.push({
    slug: "writing-style",
    title: "Writing style",
    body: data.writingStyle,
    domain: "writing",
  });
}

// --- v2.1 strict_constraints + final_check on top of the v2.0.1 base ---
plan.push({
  slug: "ui-rules-strict-constraints",
  title: "Strict UI constraints (v2.1 corporate guardrails)",
  body: STRICT_CONSTRAINTS,
  domain: "ui-rules",
});
plan.push({
  slug: "ui-rules-final-check",
  title: "UI final-check questions (v2.1)",
  body: FINAL_CHECK,
  domain: "ui-rules",
});

console.log(
  `[seed] plan: ${plan.length} fragments — v${version} tokens/components + v2.1 ui_rules guardrails`,
);

// --- spawn MCP and call ui_upsert for each plan entry ---
const child = spawn(process.execPath, [mcpEntry], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write("[mcp-stderr] " + d));

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const req = (method, params) => {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((res) => pending.set(id, res));
};
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const TIMEOUT_MS = 180000;
const timeout = setTimeout(() => {
  console.error(`[seed] timed out after ${TIMEOUT_MS}ms`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

async function upsert({ slug, title, body, domain }) {
  const out = await req("tools/call", {
    name: "ui_upsert",
    arguments: {
      slug,
      title,
      body: JSON.stringify(body, null, 2),
      kind: "json_fragment",
      domain,
      change_summary: `Reseeded from ${tokensPath} (v${version} hybrid)`,
      status: "active",
    },
  });
  if (out.error) throw new Error(`${slug}: ${JSON.stringify(out.error)}`);
  if (out.result?.isError) {
    const text = out.result?.content?.[0]?.text;
    throw new Error(`${slug}: ${text}`);
  }
  console.log(`[seed] ✓ ${slug}`);
}

try {
  const init = await req("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bufab-seed-from-design-tokens", version: "1.0" },
  });
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  for (const entry of plan) {
    await upsert(entry);
  }

  clearTimeout(timeout);
  child.kill();
  console.log(`\n[seed] done — ${plan.length} fragments upserted`);
  process.exit(0);
} catch (e) {
  clearTimeout(timeout);
  child.kill();
  console.error("[seed] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
