import type { ArchitectureRequirementsInput } from "./architectureSchema.js";

function renderList(items: string[], indent = ""): string[] {
  return items.map((x) => `${indent}- ${x}`);
}

export function renderArchitectureMarkdown(input: {
  slug?: string;
  title?: string;
  requirements: ArchitectureRequirementsInput;
}): string {
  const title = input.title?.trim() || input.slug?.trim() || "Architecture requirements";
  const r = input.requirements ?? {};

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");

  lines.push("## Tech requirements");
  lines.push(...renderList([
    `language: ${String(r.language ?? "(missing)")}`,
    `database: ${String(r.database ?? "(missing)")}`,
    r.go_version ? `go_version: ${String(r.go_version)}` : "go_version: (unspecified)",
    r.sqlite_driver ? `sqlite_driver: ${String(r.sqlite_driver)}` : "sqlite_driver: (unspecified)",
    r.cgo_allowed === true ? "cgo_allowed: true" : r.cgo_allowed === false ? "cgo_allowed: false" : "cgo_allowed: (unspecified)",
    r.frontend_framework ? `frontend_framework: ${String(r.frontend_framework)}` : "frontend_framework: (unspecified)",
    r.css_framework ? `css_framework: ${String(r.css_framework)}` : "css_framework: (unspecified)",
    Array.isArray(r.deployment_targets) && r.deployment_targets.length
      ? `deployment_targets: ${r.deployment_targets.join(", ")}`
      : "deployment_targets: (unspecified)",
  ]));
  lines.push("");

  lines.push("## Decision rules (how to choose)");
  lines.push(
    ...renderList([
      "If language is go: initialize module first (`go mod init ...`) and keep build/test runnable from CI.",
      "If database is sqlite: pick a driver early and make it explicit in dependencies and storage bootstrap.",
      "If sqlite_driver is mattn/go-sqlite3: ensure CGO is allowed in the build environment; otherwise prefer modernc.org/sqlite.",
      "If cgo_allowed is false: avoid CGO-only dependencies and ensure Docker/CI uses CGO_DISABLED builds.",
      "If frontend_framework is react: use React as the only UI framework and keep entrypoints consistent (React 18, react-dom).",
      "If css_framework is tailwind: configure Tailwind once and use Tailwind utility classes (avoid mixing multiple CSS frameworks).",
    ]),
  );
  lines.push("");

  lines.push("## Validation checklist (what to validate after changes)");
  lines.push(
    ...renderList([
      "Repo contains `go.mod` (or the change set includes it).",
      "Storage layer references the chosen SQLite driver consistently.",
      "No contradictions between requirements and code (e.g., driver mismatch, CGO policy mismatch).",
      "If React is required: package config and entrypoints reflect React usage.",
      "If Tailwind is required: Tailwind config + @tailwind directives (or equivalent) exist and build uses Tailwind.",
      "If migrations are introduced, migration files and tooling are present and invoked in docs/CI.",
    ]),
  );
  lines.push("");

  lines.push("## How to run validation");
  lines.push("");
  lines.push("Call `arch_validate_files` after file changes, passing the changed files and the active architecture profile.");
  lines.push("");

  return lines.join("\n").trim();
}

