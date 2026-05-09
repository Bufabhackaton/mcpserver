#!/usr/bin/env node
/**
 * Seed architecture profiles into LanceDB (same effect as arch_upsert).
 *
 * Usage (from bufab-mcp):
 *   npm run build && npm run seed:arch
 *
 * Env: BUFAB_ARCH_DB_PATH overrides the DB directory (default: <package>/.lancedb-arch).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ArchitectureStore } from "../dist/architectureStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const distDir = join(pkgRoot, "dist");
const seedPath = join(pkgRoot, "data", "arch-guidelines-seed.json");

async function main() {
  let raw;
  try {
    raw = readFileSync(seedPath, "utf8");
  } catch (e) {
    console.error(`Cannot read ${seedPath}:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }

  /** @type {{ slug: string; title: string; requirements: unknown }[]} */
  const profiles = JSON.parse(raw);
  if (!Array.isArray(profiles) || profiles.length === 0) {
    console.error("Seed file must be a non-empty array of { slug, title, requirements }");
    process.exit(1);
  }

  const store = await ArchitectureStore.open(distDir);

  for (const p of profiles) {
    if (!p.slug || !p.title || p.requirements === undefined) {
      console.error("Each entry needs slug, title, requirements:", p);
      process.exit(1);
    }
    const requirements_json = JSON.stringify(p.requirements, null, 2);
    const out = await store.upsertProfile({
      slug: p.slug,
      title: p.title,
      requirements_json,
      change_summary: "seed:arch-guidelines-seed.json",
      status: "active",
    });
    console.log("upserted", p.slug, out);
  }

  const listed = await store.listProfiles();
  console.log("arch_profiles count:", listed.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
