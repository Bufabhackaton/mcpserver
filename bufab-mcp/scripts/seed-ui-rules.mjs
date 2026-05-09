#!/usr/bin/env node
// Upserts the ui-rules-strict-constraints and ui-rules-final-check fragments
// into the UI LanceDB by calling this MCP server's ui_upsert tool over stdio.
// Reads the canonical guideline values from a JSON file passed as argv[2]
// (defaults to ../../guidelines/bufab_ui_guidelines.json relative to this MCP).
//
// Usage:
//   node scripts/seed-ui-rules.mjs [path/to/bufab_ui_guidelines.json]

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
const strictConstraints = guidelines?.ui_rules?.strict_constraints;
const finalCheck = guidelines?.ui_rules?.final_check;
if (!Array.isArray(strictConstraints)) {
  console.error("[seed] guidelines.ui_rules.strict_constraints missing or not an array");
  process.exit(1);
}
if (!Array.isArray(finalCheck)) {
  console.error("[seed] guidelines.ui_rules.final_check missing or not an array");
  process.exit(1);
}
const version = guidelines?.meta?.version ?? "unknown";

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

const TIMEOUT_MS = 60000;
const timeout = setTimeout(() => {
  console.error(`[seed] timed out after ${TIMEOUT_MS}ms`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS);

async function upsert(slug, title, value, summary) {
  const out = await req("tools/call", {
    name: "ui_upsert",
    arguments: {
      slug,
      title,
      body: JSON.stringify(value, null, 2),
      kind: "json_fragment",
      domain: "ui-rules",
      change_summary: summary,
      status: "active",
    },
  });
  if (out.error) throw new Error(`${slug}: ${JSON.stringify(out.error)}`);
  const text = out.result?.content?.[0]?.text;
  if (out.result?.isError) throw new Error(`${slug}: ${text}`);
  console.log(`[seed] upserted ${slug} (${value.length} entries)`);
}

try {
  const init = await req("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bufab-seed-ui-rules", version: "1.0" },
  });
  if (init.error) throw new Error("initialize: " + JSON.stringify(init.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const summary = `Seeded from bufab_ui_guidelines.json v${version}`;
  await upsert(
    "ui-rules-strict-constraints",
    "Strict UI constraints",
    strictConstraints,
    summary,
  );
  await upsert(
    "ui-rules-final-check",
    "UI final-check questions",
    finalCheck,
    summary,
  );

  clearTimeout(timeout);
  child.kill();
  console.log("\n[seed] done");
  process.exit(0);
} catch (e) {
  clearTimeout(timeout);
  child.kill();
  console.error("[seed] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
