#!/usr/bin/env node
/**
 * Minimal MCP stdio smoke test: initialize → initialized → tools/list.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "dist", "index.js");

const child = spawn(process.execPath, [server], {
  stdio: ["pipe", "pipe", "inherit"],
});

const rl = createInterface({ input: child.stdout });

function send(msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

const pending = new Map();
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} id=${id}`));
      }
    }, 15000);
  });
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error("non-json line:", line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

child.on("exit", (code, sig) => {
  if (pending.size) {
    console.error("server exited early", code, sig);
    process.exit(code ?? 1);
  }
});

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-smoke", version: "1.0.0" },
  });
  if (init.error) {
    throw new Error(JSON.stringify(init.error));
  }
  console.log("initialize OK:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const tools = await request("tools/list", {});
  if (tools.error) {
    throw new Error(JSON.stringify(tools.error));
  }
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log("tools/list OK:", names.join(", "));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
