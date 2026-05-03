#!/usr/bin/env node
/**
 * Opens UiGuidelinesStore (triggers auto-seed if empty), prints entity count and sample get_token.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UiGuidelinesStore } from "../dist/uiGuidelinesStore.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const store = await UiGuidelinesStore.open(dist);
const n = await store.countEntities();
console.log("ui_entities count:", n);
const tok = await store.getToken("primary");
console.log("get_token(primary):", JSON.stringify(tok));
const spec = await store.getSectionSpec("hero");
console.log("get_section_spec(hero) keys:", spec && typeof spec === "object" ? Object.keys(spec) : spec);
