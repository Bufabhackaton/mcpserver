#!/usr/bin/env node
// Reseeds the UI LanceDB from a canonical guideline JSON file (default:
// ../../guidelines/bufab_ui_guidelines.json) so every fragment exposed by
// `ui_export` reflects the SAME design-system version. Without this, partial
// reseeds can leave the DB internally inconsistent (e.g. v2.1 strict_constraints
// next to v2.0.1 tokens), which forces consumers to resolve conflicts at
// generation time and produces output that doesn't match any single version.
//
// Usage:
//   node scripts/seed-from-guidelines.mjs [path/to/bufab_ui_guidelines.json]
//
// Reads `meta` and `ui_rules.{layout,components,style,imagery,strict_constraints,
// final_check}` from the source JSON and upserts them into the LanceDB slugs
// that `ui_export` reads.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(__dirname, "..", "dist", "index.js");
const defaultGuidelines = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "guidelines",
  "bufab_ui_guidelines.json",
);
const guidelinesPath = process.argv[2]
  ? resolve(process.argv[2])
  : defaultGuidelines;

if (!existsSync(mcpEntry)) {
  console.error(`[seed] MCP not built at ${mcpEntry}; run 'npm run build'`);
  process.exit(1);
}
if (!existsSync(guidelinesPath)) {
  console.error(`[seed] guidelines file not found at ${guidelinesPath}`);
  process.exit(1);
}

const guidelines = JSON.parse(readFileSync(guidelinesPath, "utf8"));
const meta = guidelines?.meta;
const rules = guidelines?.ui_rules;
if (!meta || !rules) {
  console.error("[seed] expected guidelines to have meta + ui_rules");
  process.exit(1);
}
const version = meta.version ?? "unknown";

// Build the slug → body plan. Each entry maps a stable LanceDB slug
// to the JSON value that `ui_export` will reconstruct it back from.
//
// IMPORTANT: keys here must match what uiGuidelinesStore.ts reads. See:
//   - SECTION_TYPE_TO_SLUG (hero/text-image-split/.../industries-grid/.../footer/header/layout)
//   - parseTokenName (tokens-colors/typography/spacing/borders/shadows/buttons/tone)
//   - exportMergedGuidelines (spec-meta, layout-general, component-*, ui-rules-*)
const plan = [];

// --- meta ---
plan.push({
  slug: "spec-meta",
  title: "Spec metadata",
  body: { name: "Bufab Design System", ...meta },
  domain: "general",
});

// --- style/* -> tokens-* ---
const style = rules.style ?? {};
if (style.colors) {
  plan.push({
    slug: "tokens-colors",
    title: "Color tokens",
    body: { colors: style.colors },
    domain: "tokens",
  });
}
if (style.typography) {
  plan.push({
    slug: "tokens-typography",
    title: "Typography tokens",
    body: { typography: style.typography },
    domain: "tokens",
  });
}
if (style.spacing) {
  plan.push({
    slug: "tokens-spacing",
    title: "Spacing tokens",
    body: { spacing: style.spacing },
    domain: "tokens",
  });
}
if (style.borders_and_radius) {
  plan.push({
    slug: "tokens-borders",
    title: "Border + radius tokens",
    body: { borders_and_radius: style.borders_and_radius },
    domain: "tokens",
  });
}
if (style.shadows) {
  plan.push({
    slug: "tokens-shadows",
    title: "Shadow tokens",
    body: { shadows: style.shadows },
    domain: "tokens",
  });
}
if (style.buttons) {
  plan.push({
    slug: "tokens-buttons",
    title: "Button tokens",
    body: { buttons: style.buttons },
    domain: "tokens",
  });
}
if (style.visual_tone || style.anti_tone) {
  plan.push({
    slug: "tokens-tone",
    title: "Tone tokens",
    body: { visual_tone: style.visual_tone, anti_tone: style.anti_tone },
    domain: "tokens",
  });
}

// --- layout -> layout-general ---
if (rules.layout) {
  plan.push({
    slug: "layout-general",
    title: "Layout / page shell",
    body: rules.layout,
    domain: "layout",
  });
}

// --- components -> component-* and section-* ---
const components = rules.components ?? {};
if (components.header) {
  plan.push({
    slug: "component-header",
    title: "Header component",
    body: components.header,
    domain: "components",
  });
}
if (components.footer) {
  plan.push({
    slug: "component-footer",
    title: "Footer component",
    body: components.footer,
    domain: "components",
  });
}
if (components.hero) {
  // hero lives under `components` in v2.1 source but ui_export reads it as
  // a section (section-hero). Store it under the section slug so consumers
  // calling `ui_section_spec(section_type='hero')` get the v2.1 spec.
  plan.push({
    slug: "section-hero",
    title: "Hero section",
    body: components.hero,
    domain: "sections",
  });
}
const sectionTypes = components.sections?.types ?? {};
for (const [name, spec] of Object.entries(sectionTypes)) {
  plan.push({
    slug: `section-${name}`,
    title: `${name} section`,
    body: spec,
    domain: "sections",
  });
}

// --- imagery -> imagery (generic fragment, not currently surfaced by export
// but available via ui_get / ui_search) ---
if (rules.imagery) {
  plan.push({
    slug: "imagery",
    title: "Imagery rules",
    body: rules.imagery,
    domain: "imagery",
  });
}

// --- ui_rules.strict_constraints / final_check ---
if (Array.isArray(rules.strict_constraints)) {
  plan.push({
    slug: "ui-rules-strict-constraints",
    title: "Strict UI constraints",
    body: rules.strict_constraints,
    domain: "ui-rules",
  });
}
if (Array.isArray(rules.final_check)) {
  plan.push({
    slug: "ui-rules-final-check",
    title: "UI final-check questions",
    body: rules.final_check,
    domain: "ui-rules",
  });
}

console.log(`[seed] plan: ${plan.length} fragments to upsert from v${version}`);

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

const TIMEOUT_MS = 120000;
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
      change_summary: `Reseeded from bufab_ui_guidelines.json v${version}`,
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
    clientInfo: { name: "bufab-seed-from-guidelines", version: "1.0" },
  });
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  for (const entry of plan) {
    await upsert(entry);
  }

  clearTimeout(timeout);
  child.kill();
  console.log(`\n[seed] done — ${plan.length} fragments upserted from v${version}`);
  process.exit(0);
} catch (e) {
  clearTimeout(timeout);
  child.kill();
  console.error("[seed] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
