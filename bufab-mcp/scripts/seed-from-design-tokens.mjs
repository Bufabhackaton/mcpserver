#!/usr/bin/env node
// Reseeds the UI LanceDB from the canonical Bufab design-tokens JSON
// (default: ../data/bufab-design-tokens.json — the v2.0.1 Glassmorphism
// on Dark Teal source).
//
// Ships pure v2.0.1: tokens / components / layout / writingStyle reflect
// the glassmorphism source verbatim, and NO ui_rules fragments are
// written (no strict_constraints, no final_check). The 1.2.0 hybrid that
// kept v2.1 constraints on top of v2.0.1 tokens was an explicit design
// choice that turned out to be unworkable — strict_constraints won every
// time over the visual tokens, so agents produced corporate-flat output
// even when the tokens said "use glass". 1.3.0 drops the contradiction.
//
// If you want corporate v2.1 instead, run `npm run seed:v2.1` (which
// invokes scripts/seed-from-guidelines.mjs against the v2.1 source).
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

console.log(
  `[seed] plan: ${plan.length} fragments — pure v${version} (no ui_rules)`,
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
