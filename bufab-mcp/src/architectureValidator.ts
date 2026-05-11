import { extname } from "node:path";
import {
  ArchDatabase,
  ArchLanguage,
  CssFramework,
  FrontendFramework,
  SqliteDriver,
  normalizeArchitectureRequirements,
} from "./architectureSchema.js";

export type Violation = {
  rule: string;
  severity: "blocker" | "warning";
  file: string;
  line: number;
  matched: string;
  message: string;
};

export type ValidationResult = {
  violations: Violation[];
  summary: { blockers: number; warnings: number; filesScanned: number };
  normalized_requirements?: unknown;
  suggested_changes?: Array<{ path: string; value: unknown; reason: string }>;
};

export type ValidateFilesInput = {
  requirements: unknown;
  files: Array<{ path: string; content: string }>;
};

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function push(out: Violation[], v: Violation) {
  out.push(v);
}

function hasAnyFile(files: Array<{ path: string }>, names: string[]): boolean {
  const set = new Set(files.map((f) => f.path.replace(/\\/g, "/")));
  return names.some((n) => set.has(n));
}

function includesGoModule(files: Array<{ path: string; content: string }>): boolean {
  for (const f of files) {
    if (f.path.replace(/\\/g, "/").endsWith("go.mod")) return true;
    if (f.content.includes("module ") && f.content.includes("go ")) return true;
  }
  return false;
}

function findInFiles(
  files: Array<{ path: string; content: string }>,
  re: RegExp,
): Array<{ file: string; index: number; match: string }> {
  const hits: Array<{ file: string; index: number; match: string }> = [];
  for (const f of files) {
    for (const m of f.content.matchAll(re)) {
      hits.push({ file: f.path, index: m.index ?? 0, match: m[0] });
    }
  }
  return hits;
}

function isGoFile(path: string): boolean {
  return extname(path).toLowerCase() === ".go";
}

export function validateArchitectureRequirementsOnly(requirements: unknown): {
  ok: boolean;
  errors: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  normalized_requirements: unknown;
  suggested_changes: Array<{ path: string; value: unknown; reason: string }>;
} {
  const normalized = normalizeArchitectureRequirements(requirements);
  const errors: Array<{ rule: string; message: string }> = [];
  const warnings: Array<{ rule: string; message: string }> = [];
  const suggested_changes: Array<{ path: string; value: unknown; reason: string }> = [];

  // language
  const lang = typeof normalized.language === "string" ? normalized.language : "";
  if (!lang) {
    errors.push({ rule: "ARCH-REQ-01", message: "Missing required field `language` (supported: go)." });
  } else if (!ArchLanguage.safeParse(lang).success) {
    errors.push({ rule: "ARCH-REQ-01", message: `Unsupported language '${normalized.language}'. Supported: go.` });
  }

  // database
  const db = typeof normalized.database === "string" ? normalized.database : "";
  if (!db) {
    errors.push({ rule: "ARCH-REQ-02", message: "Missing required field `database` (supported: sqlite)." });
  } else if (!ArchDatabase.safeParse(db).success) {
    errors.push({ rule: "ARCH-REQ-02", message: `Unsupported database '${normalized.database}'. Supported: sqlite.` });
  }

  // sqlite driver vs cgo policy
  if (normalized.database === "sqlite" && typeof normalized.sqlite_driver === "string") {
    if (!SqliteDriver.safeParse(normalized.sqlite_driver).success) {
      errors.push({
        rule: "ARCH-REQ-03",
        message: `Unsupported sqlite_driver '${normalized.sqlite_driver}'. Supported: modernc.org/sqlite, mattn/go-sqlite3.`,
      });
    } else if (normalized.sqlite_driver === "mattn/go-sqlite3" && normalized.cgo_allowed === false) {
      errors.push({
        rule: "ARCH-REQ-04",
        message: "sqlite_driver is mattn/go-sqlite3 but cgo_allowed=false. Choose modernc.org/sqlite or allow CGO.",
      });
      suggested_changes.push({
        path: "sqlite_driver",
        value: "modernc.org/sqlite",
        reason: "Pure-Go SQLite driver avoids CGO requirement.",
      });
    } else if (normalized.sqlite_driver === "mattn/go-sqlite3" && normalized.cgo_allowed === undefined) {
      warnings.push({
        rule: "ARCH-REQ-04",
        message:
          "sqlite_driver is mattn/go-sqlite3 but cgo_allowed is not specified. This driver requires CGO in many environments.",
      });
    }
  }

  // frontend framework
  if (typeof (normalized as any).frontend_framework === "string") {
    const ff = String((normalized as any).frontend_framework);
    if (!FrontendFramework.safeParse(ff).success) {
      errors.push({
        rule: "ARCH-FE-01",
        message: `Unsupported frontend_framework '${ff}'. Supported: react.`,
      });
    }
  }
  if (typeof (normalized as any).css_framework === "string") {
    const cf = String((normalized as any).css_framework);
    if (!CssFramework.safeParse(cf).success) {
      errors.push({
        rule: "ARCH-FE-02",
        message: `Unsupported css_framework '${cf}'. Supported: tailwind.`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized_requirements: normalized,
    suggested_changes,
  };
}

export function validateArchitectureFiles(input: ValidateFilesInput): ValidationResult {
  const violations: Violation[] = [];
  const suggested_changes: Array<{ path: string; value: unknown; reason: string }> = [];

  const reqResult = validateArchitectureRequirementsOnly(input.requirements);
  for (const e of reqResult.errors) {
    push(violations, {
      rule: e.rule,
      severity: "blocker",
      file: "(requirements)",
      line: 1,
      matched: "(requirements)",
      message: e.message,
    });
  }
  for (const w of reqResult.warnings) {
    push(violations, {
      rule: w.rule,
      severity: "warning",
      file: "(requirements)",
      line: 1,
      matched: "(requirements)",
      message: w.message,
    });
  }
  suggested_changes.push(...reqResult.suggested_changes);

  // If requirements are invalid, we still do file checks best-effort.
  const normalized = reqResult.normalized_requirements as any;

  const files = input.files ?? [];
  const filesScanned = files.length;

  if (normalized?.language === "go") {
    if (!includesGoModule(files)) {
      push(violations, {
        rule: "ARCH-GO-01",
        severity: "warning",
        file: "(repo)",
        line: 1,
        matched: "go.mod",
        message:
          "Requirements specify Go, but no evidence of a Go module was found in provided files (missing go.mod). If this is a new repo, create go.mod first.",
      });
    }
  }

  if (normalized?.database === "sqlite") {
    const goFiles = files.filter((f) => isGoFile(f.path));
    const sqliteEvidence = findInFiles(
      goFiles,
      /\b(sqlite|modernc\.org\/sqlite|mattn\/go-sqlite3)\b/g,
    );
    if (goFiles.length && sqliteEvidence.length === 0) {
      push(violations, {
        rule: "ARCH-SQLITE-01",
        severity: "warning",
        file: "(repo)",
        line: 1,
        matched: "sqlite",
        message:
          "Requirements specify SQLite, but no SQLite driver usage/import was found in provided Go files. Ensure the selected driver is added and used in storage initialization.",
      });
    }

    // If a driver is specified, verify that the code doesn't contradict it (best-effort).
    if (typeof normalized?.sqlite_driver === "string") {
      const wanted = normalized.sqlite_driver;
      const hasModernc = sqliteEvidence.some((h) => h.match.includes("modernc.org/sqlite"));
      const hasMattn = sqliteEvidence.some((h) => h.match.includes("mattn/go-sqlite3"));
      if (wanted === "modernc.org/sqlite" && hasMattn) {
        push(violations, {
          rule: "ARCH-SQLITE-02",
          severity: "blocker",
          file: sqliteEvidence.find((h) => h.match.includes("mattn/go-sqlite3"))?.file ?? "(repo)",
          line: 1,
          matched: "mattn/go-sqlite3",
          message:
            "Requirements specify sqlite_driver=modernc.org/sqlite but code references mattn/go-sqlite3 in provided files.",
        });
      }
      if (wanted === "mattn/go-sqlite3" && hasModernc) {
        push(violations, {
          rule: "ARCH-SQLITE-02",
          severity: "warning",
          file: sqliteEvidence.find((h) => h.match.includes("modernc.org/sqlite"))?.file ?? "(repo)",
          line: 1,
          matched: "modernc.org/sqlite",
          message:
            "Requirements specify sqlite_driver=mattn/go-sqlite3 but code references modernc.org/sqlite in provided files.",
        });
      }
    }
  }

  // Frontend evidence checks (best-effort, based on provided changed files).
  if (normalized?.frontend_framework === "react") {
    const hasPackageJson = hasAnyFile(files, ["package.json"]);
    const reactEvidence = findInFiles(
      files,
      /\breact\b|from\s+['"]react['"]|@types\/react|react-dom|vite-plugin-react|next\/react|jsx-runtime/g,
    );
    if (hasPackageJson && reactEvidence.length === 0) {
      push(violations, {
        rule: "ARCH-FE-10",
        severity: "warning",
        file: "(repo)",
        line: 1,
        matched: "react",
        message:
          "Requirements specify React, but no React-related evidence was found in provided files. Ensure dependencies and entrypoints include React.",
      });
    }
  }

  if (normalized?.css_framework === "tailwind") {
    const twConfigNames = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts"];
    const hasTwConfig = hasAnyFile(files, twConfigNames);
    const twEvidence = findInFiles(files, /\btailwindcss\b|@tailwind\b|tailwind\.config\./g);
    if (!hasTwConfig && twEvidence.length === 0) {
      push(violations, {
        rule: "ARCH-FE-11",
        severity: "warning",
        file: "(repo)",
        line: 1,
        matched: "tailwind",
        message:
          "Requirements specify Tailwind CSS, but no Tailwind config or directives were found in provided files. Ensure Tailwind is configured (tailwind.config.* and @tailwind directives).",
      });
    }
  }

  // Optional: detect CGO hints when cgo_allowed=false (best-effort)
  if ((reqResult.normalized_requirements as any)?.cgo_allowed === false) {
    const hits = findInFiles(files, /\bCGO_ENABLED\b|\bcgo\b/g);
    for (const h of hits.slice(0, 3)) {
      push(violations, {
        rule: "ARCH-CGO-01",
        severity: "warning",
        file: h.file,
        line: lineOf(files.find((f) => f.path === h.file)?.content ?? "", h.index),
        matched: h.match,
        message:
          "Requirements specify cgo_allowed=false. Ensure build pipeline and dependencies do not require CGO.",
      });
    }
  }

  const blockers = violations.filter((v) => v.severity === "blocker").length;
  const warnings = violations.filter((v) => v.severity === "warning").length;

  return {
    violations,
    summary: { blockers, warnings, filesScanned },
    normalized_requirements: reqResult.normalized_requirements,
    suggested_changes,
  };
}

