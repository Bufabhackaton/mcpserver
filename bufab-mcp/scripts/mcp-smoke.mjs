#!/usr/bin/env node
/**
 * Minimal MCP stdio smoke test: initialize → initialized → tools/list → resources/templates/list.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "dist", "index.js");
const tmp = await mkdtemp(join(tmpdir(), "bufab-mcp-smoke-"));
await writeFile(join(tmp, ".clinerules"), "smoke-rule\n", "utf8");
await writeFile(join(tmp, ".claude"), "smoke-claude\n", "utf8");

const child = spawn(process.execPath, [server], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, BUFAB_AGENT_CONFIG_SOURCE_DIR: tmp },
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
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} id=${id}`));
      }
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
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
    const { resolve, timeout } = pending.get(msg.id);
    clearTimeout(timeout);
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
  if (!names.includes("arch_validate_requirements")) {
    throw new Error(`missing arch_validate_requirements; got ${names.join(", ")}`);
  }
  if (!names.includes("arch_validate_files")) {
    throw new Error(`missing arch_validate_files; got ${names.join(", ")}`);
  }

  const templates = await request("resources/templates/list", {});
  if (templates.error) {
    throw new Error(JSON.stringify(templates.error));
  }
  const uris = (templates.result?.resourceTemplates ?? []).map((t) => t.uriTemplate);
  if (!uris.includes("bufab-agent-config://{source}/{+path}")) {
    throw new Error(`missing setup environment resource template; got ${uris.join(", ")}`);
  }
  console.log("resources/templates/list OK:", uris.join(", "));

  try {
    const listedResources = await request("resources/list", {});
    if (listedResources.error) {
      throw new Error(JSON.stringify(listedResources.error));
    }
    const listedUris = (listedResources.result?.resources ?? []).map((r) => r.uri);
    if (!listedUris.some((uri) => uri.endsWith("/.clinerules"))) {
      throw new Error(`resources/list did not include .clinerules: ${listedUris.join(", ")}`);
    }
    if (!listedUris.some((uri) => uri.endsWith("/.claude"))) {
      throw new Error(`resources/list did not include .claude: ${listedUris.join(", ")}`);
    }
    console.log("resources/list OK:", listedUris.join(", "));

    const setup = await request("tools/call", {
      name: "setup_environment",
      arguments: { source_dir: tmp },
    });
    if (setup.error) {
      throw new Error(JSON.stringify(setup.error));
    }
    const text = setup.result?.content?.find((part) => part.type === "text")?.text;
    const payload = JSON.parse(text);
    const clinerules = payload.files?.find((file) => file.path === ".clinerules");
    const uri = clinerules?.resource_uri;
    if (!uri) {
      throw new Error(`setup_environment did not return a resource_uri: ${text}`);
    }
    if (!payload.files?.some((file) => file.path === ".claude")) {
      throw new Error(`setup_environment did not include .claude: ${text}`);
    }
    const resource = await request("resources/read", { uri });
    if (resource.error) {
      throw new Error(JSON.stringify(resource.error));
    }
    const content = resource.result?.contents?.[0]?.text;
    if (content !== "smoke-rule\n") {
      throw new Error(`resources/read returned unexpected content: ${JSON.stringify(content)}`);
    }
    console.log("resources/read OK:", uri);

    const childDir = join(tmp, "child", "project");
    await mkdir(childDir, { recursive: true });
    const discoveredSetup = await request("tools/call", {
      name: "setup_environment",
      arguments: { source_dir: childDir },
    });
    if (discoveredSetup.error) {
      throw new Error(JSON.stringify(discoveredSetup.error));
    }
    const discoveredText = discoveredSetup.result?.content?.find((part) => part.type === "text")?.text;
    const discoveredPayload = JSON.parse(discoveredText);
    if (discoveredPayload.source_dir !== tmp || discoveredPayload.discovery_used !== true) {
      throw new Error(`setup_environment did not discover parent config: ${discoveredText}`);
    }
    console.log("setup_environment discovery OK:", discoveredPayload.source_dir);

    const req = {
      language: "go",
      database: "sqlite",
      sqlite_driver: "modernc.org/sqlite",
      cgo_allowed: false,
    };
    const validateReq = await request("tools/call", {
      name: "arch_validate_requirements",
      arguments: { requirements: req },
    });
    if (validateReq.error) {
      throw new Error(JSON.stringify(validateReq.error));
    }
    const validateReqText = validateReq.result?.content?.find((part) => part.type === "text")?.text;
    const validateReqPayload = JSON.parse(validateReqText);
    if (validateReqPayload.ok !== true) {
      throw new Error(`arch_validate_requirements expected ok=true: ${validateReqText}`);
    }

    const validateFiles = await request("tools/call", {
      name: "arch_validate_files",
      arguments: {
        requirements: req,
        files: [
          { path: "go.mod", content: "module example.com/app\n\ngo 1.22\n" },
          { path: "internal/storage/db.go", content: 'package storage\n\nimport _ \"modernc.org/sqlite\"\n' },
        ],
      },
    });
    if (validateFiles.error) {
      throw new Error(JSON.stringify(validateFiles.error));
    }
    const validateFilesText = validateFiles.result?.content?.find((part) => part.type === "text")?.text;
    const validateFilesPayload = JSON.parse(validateFilesText);
    if (!validateFilesPayload.summary || typeof validateFilesPayload.summary.filesScanned !== "number") {
      throw new Error(`arch_validate_files returned unexpected payload: ${validateFilesText}`);
    }

    // Guard against source id collisions when different absolute paths share a basename.
    const collisionRoot = await mkdtemp(join(tmpdir(), "bufab-mcp-collision-"));
    try {
      const dirA = join(collisionRoot, "one", "project");
      const dirB = join(collisionRoot, "two", "project");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      await writeFile(join(dirA, ".clinerules"), "collision-a\n", "utf8");
      await writeFile(join(dirB, ".clinerules"), "collision-b\n", "utf8");

      const setupA = await request("tools/call", {
        name: "setup_environment",
        arguments: { source_dir: dirA },
      });
      if (setupA.error) {
        throw new Error(JSON.stringify(setupA.error));
      }
      const payloadA = JSON.parse(setupA.result?.content?.find((part) => part.type === "text")?.text);
      const uriA = payloadA.files?.find((file) => file.path === ".clinerules")?.resource_uri;
      if (!uriA) {
        throw new Error(`setup_environment did not return uri for dirA: ${JSON.stringify(payloadA)}`);
      }

      const setupB = await request("tools/call", {
        name: "setup_environment",
        arguments: { source_dir: dirB },
      });
      if (setupB.error) {
        throw new Error(JSON.stringify(setupB.error));
      }
      const payloadB = JSON.parse(setupB.result?.content?.find((part) => part.type === "text")?.text);
      const uriB = payloadB.files?.find((file) => file.path === ".clinerules")?.resource_uri;
      if (!uriB) {
        throw new Error(`setup_environment did not return uri for dirB: ${JSON.stringify(payloadB)}`);
      }
      if (uriA === uriB) {
        throw new Error(`setup_environment generated colliding resource URIs: ${uriA}`);
      }

      const readA = await request("resources/read", { uri: uriA });
      if (readA.error) {
        throw new Error(JSON.stringify(readA.error));
      }
      const readAText = readA.result?.contents?.[0]?.text;
      if (readAText !== "collision-a\n") {
        throw new Error(`resources/read returned wrong content for uriA: ${JSON.stringify(readAText)}`);
      }

      const readB = await request("resources/read", { uri: uriB });
      if (readB.error) {
        throw new Error(JSON.stringify(readB.error));
      }
      const readBText = readB.result?.contents?.[0]?.text;
      if (readBText !== "collision-b\n") {
        throw new Error(`resources/read returned wrong content for uriB: ${JSON.stringify(readBText)}`);
      }

      console.log("setup_environment collision guard OK:", uriA, uriB);
    } finally {
      await rm(collisionRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
