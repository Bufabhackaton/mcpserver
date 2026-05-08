#!/usr/bin/env node
/**
 * Downloads the official Bicep CLI binary into this package as part of `npm install`.
 *
 * - Skips if BUFAB_SKIP_BICEP_INSTALL=1
 * - Skips if vendor binary already exists
 * - You can pin a version via BUFAB_BICEP_VERSION (default: latest)
 *
 * Source: https://github.com/Azure/bicep/releases
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_ENV = "BUFAB_SKIP_BICEP_INSTALL";
const VERSION_ENV = "BUFAB_BICEP_VERSION";

function log(msg) {
  process.stdout.write(`[bufab-mcp] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[bufab-mcp] ${msg}\n`);
}

function platformKey() {
  switch (process.platform) {
    case "darwin":
      return "osx";
    case "linux":
      return "linux";
    case "win32":
      return "win";
    default:
      return null;
  }
}

function archKey() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      return null;
  }
}

function vendorDir() {
  // scripts/ -> package root
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "..", "vendor", "bicep");
}

function vendorBinaryPath() {
  const exe = process.platform === "win32" ? "bicep.exe" : "bicep";
  return join(vendorDir(), exe);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "bufab-mcp-postinstall",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.json();
}

async function fetchToFile(url, filePath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "bufab-mcp-postinstall" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(filePath), { recursive: true });
  await writeFileBytes(filePath, buf);
}

async function writeFileBytes(path, buf) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, buf);
}

async function main() {
  if (process.env[SKIP_ENV] === "1") {
    log(`${SKIP_ENV}=1, skipping Bicep install`);
    return;
  }

  const plat = platformKey();
  const arch = archKey();
  if (!plat || !arch) {
    warn(`Unsupported platform/arch (${process.platform}/${process.arch}); skipping Bicep install`);
    return;
  }

  const dest = vendorBinaryPath();
  if (existsSync(dest)) {
    log(`Bicep already installed at ${dest}`);
    return;
  }

  mkdirSync(vendorDir(), { recursive: true });

  const wantedVersion = (process.env[VERSION_ENV] ?? "latest").trim();
  const releaseUrl =
    wantedVersion === "latest"
      ? "https://api.github.com/repos/Azure/bicep/releases/latest"
      : `https://api.github.com/repos/Azure/bicep/releases/tags/${encodeURIComponent(wantedVersion)}`;

  log(`Downloading Bicep (${wantedVersion}) for ${plat}-${arch}...`);
  const release = await fetchJson(releaseUrl);
  const assets = Array.isArray(release.assets) ? release.assets : [];

  // Prefer the exact match, but fall back to a looser match.
  const nameReStrict = new RegExp(`^bicep-${plat}-${arch}(?:\\.exe)?$`, "i");
  const nameReLoose = new RegExp(`\\bbicep\\b.*\\b${plat}\\b.*\\b${arch}\\b.*(?:\\.exe)?$`, "i");
  const asset =
    assets.find((a) => typeof a?.name === "string" && nameReStrict.test(a.name)) ??
    assets.find((a) => typeof a?.name === "string" && nameReLoose.test(a.name));

  if (!asset?.browser_download_url) {
    throw new Error(
      `Could not find a Bicep release asset for ${plat}-${arch} in ${releaseUrl}. ` +
        `Set ${VERSION_ENV} to a known tag (e.g. v0.29.47) or set ${SKIP_ENV}=1 to skip.`,
    );
  }

  const tmp = `${dest}.tmp`;
  try {
    await fetchToFile(asset.browser_download_url, tmp);
    renameSync(tmp, dest);
    if (process.platform !== "win32") {
      chmodSync(dest, 0o755);
    }
    log(`Installed Bicep to ${dest}`);
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  // Postinstall should not hard-fail installs; validation tool will report
  // missing CLI at runtime if needed.
  warn(`Bicep install failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 0;
});

