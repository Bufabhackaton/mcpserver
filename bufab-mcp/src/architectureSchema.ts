import { z } from "zod";

export const ArchLanguage = z.enum(["go"]);
export type ArchLanguage = z.infer<typeof ArchLanguage>;

export const ArchDatabase = z.enum(["sqlite"]);
export type ArchDatabase = z.infer<typeof ArchDatabase>;

export const SqliteDriver = z.enum(["modernc.org/sqlite", "mattn/go-sqlite3"]);
export type SqliteDriver = z.infer<typeof SqliteDriver>;

export const FrontendFramework = z.enum(["react"]);
export type FrontendFramework = z.infer<typeof FrontendFramework>;

export const CssFramework = z.enum(["tailwind"]);
export type CssFramework = z.infer<typeof CssFramework>;

export const ArchitectureRequirementsSchema = z
  .object({
    language: z.string().optional(),
    database: z.string().optional(),
    go_version: z.string().optional(),
    sqlite_driver: z.string().optional(),
    cgo_allowed: z.boolean().optional(),
    deployment_targets: z.array(z.string()).optional(),
    frontend_framework: z.string().optional(),
    css_framework: z.string().optional(),
  })
  .passthrough();

export type ArchitectureRequirementsInput = z.infer<typeof ArchitectureRequirementsSchema>;

export type ArchitectureRequirements = Omit<ArchitectureRequirementsInput, "language" | "database" | "sqlite_driver"> & {
  language: ArchLanguage;
  database: ArchDatabase;
  sqlite_driver?: SqliteDriver;
};

function normAtom(v: string): string {
  return v.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function normalizeArchitectureRequirements(raw: unknown): ArchitectureRequirementsInput {
  const parsed = ArchitectureRequirementsSchema.parse(raw);
  const out: ArchitectureRequirementsInput = { ...parsed };

  if (typeof parsed.language === "string") {
    const l = normAtom(parsed.language);
    out.language = l === "golang" ? "go" : l;
  }
  if (typeof parsed.database === "string") {
    const db = normAtom(parsed.database);
    out.database = db === "sq-lite" ? "sqlite" : db;
  }
  if (typeof parsed.sqlite_driver === "string") {
    const d = parsed.sqlite_driver.trim();
    out.sqlite_driver = d;
  }
  if (typeof parsed.go_version === "string") {
    out.go_version = parsed.go_version.trim();
  }
  if (Array.isArray(parsed.deployment_targets)) {
    out.deployment_targets = parsed.deployment_targets.map((t) => t.trim()).filter(Boolean);
  }
  if (typeof parsed.frontend_framework === "string") {
    out.frontend_framework = normAtom(parsed.frontend_framework);
  }
  if (typeof parsed.css_framework === "string") {
    const css = normAtom(parsed.css_framework);
    out.css_framework = css === "tailwind-css" ? "tailwind" : css;
  }

  return out;
}

