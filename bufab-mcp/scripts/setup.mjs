#!/usr/bin/env node
// Registers `bufab-mcp` as an MCP server in the configs of every agent host
// we know about, on a best-effort basis. Idempotent: existing entries are
// updated in place, other MCP servers in the same files are preserved.
//
// Writes (skips destinations whose parent directory does not exist unless
// the destination is the workspace .mcp.json which we always create):
//   - <cwd>/.mcp.json                                       → Claude Code + Cursor (workspace)
//   - <HOME>/.cline/data/settings/cline_mcp_settings.json   → Cline CLI
//   - <APPDATA|XDG_CONFIG|Library>/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
//                                                            → Cline VS Code extension
//   - <HOME>/.cursor/mcp.json                                → Cursor user-level
//
// The MCP server entry uses `npx -y @greadcadinho/bufab-mcp` so it works
// regardless of where the package was installed (project-local, global, or
// not yet installed at all — npx downloads on first use).
//
// Flags:
//   --dry-run                Show what would be written, write nothing.
//   --workspace-only         Only write <cwd>/.mcp.json.
//   --skip-vscode-extension  Don't touch the VS Code extension's settings.
//   --skip-cursor-user       Don't touch ~/.cursor/mcp.json.
//   --quiet                  Print only failures.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";

const SERVER_NAME = "bufab-mcp";
const SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@greadcadinho/bufab-mcp"],
};

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function mergeServerInto(existing) {
  const next =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  if (!next.mcpServers || typeof next.mcpServers !== "object") {
    next.mcpServers = {};
  }
  next.mcpServers = { ...next.mcpServers, [SERVER_NAME]: { ...SERVER_ENTRY } };
  return next;
}

function dirExists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function vsCodeUserDir() {
  if (platform() === "win32") {
    return process.env.APPDATA ? resolve(process.env.APPDATA, "Code", "User") : null;
  }
  if (platform() === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Code", "User");
  }
  const xdg = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config");
  return resolve(xdg, "Code", "User");
}

function targets({ workspaceOnly, skipVsCodeExt, skipCursorUser }) {
  const home = homedir();
  const cwd = process.cwd();
  const out = [];

  // Workspace .mcp.json — Claude Code + Cursor 1.7+
  out.push({
    label: "workspace .mcp.json (Claude Code, Cursor)",
    path: resolve(cwd, ".mcp.json"),
    parentRequired: false, // always create
  });

  if (workspaceOnly) return out;

  // Cline CLI
  out.push({
    label: "Cline CLI settings",
    path: resolve(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    parentRequired: false,
  });

  // Cline VS Code extension
  if (!skipVsCodeExt) {
    const userDir = vsCodeUserDir();
    if (userDir && dirExists(userDir)) {
      out.push({
        label: "Cline VS Code extension settings",
        path: resolve(
          userDir,
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
        parentRequired: false,
      });
    }
  }

  // Cursor user-level
  if (!skipCursorUser) {
    out.push({
      label: "Cursor user-level (~/.cursor/mcp.json)",
      path: resolve(home, ".cursor", "mcp.json"),
      parentRequired: false,
    });
  }

  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    dryRun: argv.includes("--dry-run"),
    workspaceOnly: argv.includes("--workspace-only"),
    skipVsCodeExt: argv.includes("--skip-vscode-extension"),
    skipCursorUser: argv.includes("--skip-cursor-user"),
    quiet: argv.includes("--quiet"),
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: bufab-mcp setup [flags]",
        "",
        "Registers bufab-mcp as an MCP server in every known agent config on this machine.",
        "Idempotent — existing entries are updated, other MCP servers preserved.",
        "",
        "Flags:",
        "  --dry-run                Show what would be written; write nothing.",
        "  --workspace-only         Only write <cwd>/.mcp.json.",
        "  --skip-vscode-extension  Don't touch the VS Code extension settings.",
        "  --skip-cursor-user       Don't touch ~/.cursor/mcp.json.",
        "  --quiet                  Print only failures.",
        "",
      ].join("\n"),
    );
    return;
  }

  const log = (...args) => {
    if (!opts.quiet) console.log(...args);
  };

  const list = targets(opts);
  const written = [];
  const failed = [];

  for (const t of list) {
    try {
      const existing = readJson(t.path);
      const merged = mergeServerInto(existing);
      if (opts.dryRun) {
        written.push({ ...t, action: "would write" });
      } else {
        writeJson(t.path, merged);
        written.push({ ...t, action: "wrote" });
      }
    } catch (e) {
      failed.push({ ...t, error: e instanceof Error ? e.message : String(e) });
    }
  }

  log(`bufab-mcp setup${opts.dryRun ? " (dry-run)" : ""} complete.\n`);
  if (written.length > 0) {
    log("Registered server entry:");
    log(`  command: ${SERVER_ENTRY.command}`);
    log(`  args:    ${JSON.stringify(SERVER_ENTRY.args)}`);
    log("");
    log("Targets:");
    for (const t of written) {
      log(`  ${t.action === "wrote" ? "[OK]" : "[--]"} ${t.label}`);
      log(`         ${t.path}`);
    }
  }
  if (failed.length > 0) {
    log("");
    log("Failures:");
    for (const t of failed) log(`  [FAIL] ${t.label}: ${t.error}`);
  }
  if (!opts.quiet && !opts.dryRun) {
    log("");
    log("Restart your IDE / Cline session to pick up the new MCP server.");
  }
  if (failed.length > 0) process.exit(1);
}

main();
