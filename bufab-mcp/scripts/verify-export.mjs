import { UiGuidelinesStore } from "../dist/uiGuidelinesStore.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = join(__dirname, "..");

async function run() {
  try {
    const store = await UiGuidelinesStore.open(baseDir);
    const exported = await store.exportMergedGuidelines();
    console.log(JSON.stringify(exported, null, 2));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();