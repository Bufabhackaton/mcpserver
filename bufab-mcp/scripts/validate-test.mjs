#!/usr/bin/env node
/**
 * Test runner for validate.mjs.
 *
 * Runs the validator against each fixture in ./test-fixtures and asserts the
 * expected violations are present (and unexpected blockers are not).
 *
 * Uses a fixed guideline snapshot so results are deterministic and do not
 * depend on local MCP/LanceDB runtime state.
 *
 * Exit code: 0 on success, 1 if any case fails. Suitable for CI.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(__dirname, "validate.mjs");
const FIXTURES = join(__dirname, "test-fixtures");
const SNAPSHOT = join(FIXTURES, "guidelines.snapshot.json");

/** @type {{ name: string, fixture: string, expectBlockers: string[], expectWarnings: string[] }[]} */
const cases = [
  {
    name: "ui-good.css — no violations",
    fixture: "ui-good.css",
    expectBlockers: [],
    expectWarnings: [],
  },
  {
    name: "ui-bad.css — gradient + radius + accent misuse + web font + off-palette",
    fixture: "ui-bad.css",
    // AP-03/AP-04/AP-05/AP-06 are retired; the current bad-fixture signal is
    // COLOR-03 plus the @font-face TYPE-01 warning.
    expectBlockers: ["COLOR-03"],
    expectWarnings: ["TYPE-01"],
  },
  {
    name: "infra-good.bicep — no violations",
    fixture: "infra-good.bicep",
    expectBlockers: [],
    expectWarnings: [],
  },
  {
    name: "infra-bad.bicep — missing tags + bad name + hardcoded AccountKey",
    fixture: "infra-bad.bicep",
    expectBlockers: ["INFRA-01", "INFRA-03"],
    expectWarnings: ["INFRA-02"],
  },
  {
    name: "infra-good.tf — no violations",
    fixture: "infra-good.tf",
    expectBlockers: [],
    expectWarnings: [],
  },
  {
    name: "infra-bad.tf — missing tags + bad name + hardcoded password",
    fixture: "infra-bad.tf",
    expectBlockers: ["INFRA-01", "INFRA-03"],
    expectWarnings: ["INFRA-02"],
  },
];

function runOne(c) {
  const filePath = join(FIXTURES, c.fixture);
  const result = spawnSync(process.execPath, [VALIDATOR, filePath], {
    env: { ...process.env, BUFAB_VALIDATOR_GUIDELINES_FILE: SNAPSHOT },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      reason:
        `validator exited ${result.status}\n${result.stderr}\n` +
        "Ensure the test snapshot exists and is valid JSON.",
    };
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: `cannot parse stdout:\n${result.stdout.slice(0, 500)}` };
  }

  const actualBlockers = new Set(
    (report.violations ?? []).filter((v) => v.severity === "blocker").map((v) => v.rule),
  );
  const actualWarnings = new Set(
    (report.violations ?? []).filter((v) => v.severity === "warning").map((v) => v.rule),
  );

  const missingBlockers = c.expectBlockers.filter((r) => !actualBlockers.has(r));
  const unexpectedBlockers = [...actualBlockers].filter((r) => !c.expectBlockers.includes(r));
  const missingWarnings = c.expectWarnings.filter((r) => !actualWarnings.has(r));
  const unexpectedWarnings = [...actualWarnings].filter((r) => !c.expectWarnings.includes(r));

  if (
    missingBlockers.length === 0 &&
    unexpectedBlockers.length === 0 &&
    missingWarnings.length === 0 &&
    unexpectedWarnings.length === 0
  ) {
    return { ok: true };
  }
  const reasons = [];
  if (missingBlockers.length) reasons.push(`missing blockers: ${missingBlockers.join(", ")}`);
  if (unexpectedBlockers.length) reasons.push(`unexpected blockers: ${unexpectedBlockers.join(", ")}`);
  if (missingWarnings.length) reasons.push(`missing warnings: ${missingWarnings.join(", ")}`);
  if (unexpectedWarnings.length) reasons.push(`unexpected warnings: ${unexpectedWarnings.join(", ")}`);
  return { ok: false, reason: reasons.join("; ") };
}

let failed = 0;
for (const c of cases) {
  const out = runOne(c);
  if (out.ok) {
    console.log(`OK    ${c.name}`);
  } else {
    console.error(`FAIL  ${c.name}\n      ${out.reason}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} validator tests passed`);
