import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Connection, connect } from "@lancedb/lancedb";
import { TransformersEmbeddingFunction } from "@lancedb/lancedb/embedding/transformers";
import { Field, FixedSizeList, Float32, Int32, Bool, Utf8, Schema } from "apache-arrow";
import { chunkText } from "./chunkText.js";

export const UI_CHUNK_EMBED_DIM = 384;

const T_ENTITIES = "ui_entities";
const T_VERSIONS = "ui_versions";
const T_CHUNKS = "ui_chunks";

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Top-level `notes` from guideline JSON bodies; otherwise null (non-JSON or key absent). */
function extractNotesFromBody(body: string | undefined): unknown | null {
  if (!body?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "notes")
    ) {
      return (parsed as Record<string, unknown>).notes ?? null;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function packageRootDir(fromDir: string): string {
  return join(fromDir, "..");
}

function defaultUiDbPath(fromDir: string): string {
  return join(packageRootDir(fromDir), ".lancedb-ui");
}

let uiEmbedder: TransformersEmbeddingFunction | null = null;

async function getUiEmbedder(): Promise<TransformersEmbeddingFunction> {
  uiEmbedder ??= new TransformersEmbeddingFunction({
    model: process.env.BUFAB_UI_EMBEDDING_MODEL ?? process.env.BUFAB_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
    ndims: UI_CHUNK_EMBED_DIM,
  });
  await uiEmbedder.init();
  return uiEmbedder;
}

const entitiesSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("slug", new Utf8(), false),
  new Field("title", new Utf8(), false),
  new Field("kind", new Utf8(), false),
  new Field("domain", new Utf8(), false),
  new Field("status", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("updated_at", new Utf8(), false),
]);

const uiVersionsSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("entity_id", new Utf8(), false),
  new Field("version", new Int32(), false),
  new Field("body", new Utf8(), false),
  new Field("effective_from", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("is_current", new Bool(), false),
  new Field("change_summary", new Utf8(), false),
]);

const uiChunksSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("version_id", new Utf8(), false),
  new Field("entity_id", new Utf8(), false),
  new Field("chunk_index", new Int32(), false),
  new Field("text", new Utf8(), false),
  new Field("is_current_version", new Bool(), false),
  new Field(
    "vector",
    new FixedSizeList(UI_CHUNK_EMBED_DIM, new Field("item", new Float32(), true)),
    false,
  ),
]);

export type UiFragment = {
  slug: string;
  title: string;
  kind: string;
  domain: string;
  body: string;
};
const SECTION_TYPE_TO_SLUG: Record<string, string> = {
  layout: "layout",
  header: "component-header",
  footer: "component-footer",
  hero: "section-hero",
  "text-image-split": "section-text-image-split",
  "value-columns": "section-value-columns",
  "diagram-section": "section-diagram-section",
  "industries-grid": "section-industries-grid",
  "insights-list": "section-insights-list",
  "text-cta-block": "section-text-cta-block",
};

export function resolveSectionSlug(sectionType: string): string | null {
  const raw = sectionType.trim();
  if (!raw) {
    return null;
  }
  const key = raw.toLowerCase().replace(/\s+/g, "-");
  if (SECTION_TYPE_TO_SLUG[key]) {
    return SECTION_TYPE_TO_SLUG[key];
  }
  if (key.startsWith("section-")) {
    return key;
  }
  if (key === "component-header" || key === "component-footer" || key === "layout") {
    return key;
  }
  return `section-${key}`;
}

type TokenPath = { slug: string; path: string[] };

function parseTokenName(name: string): TokenPath | null {
  const raw = name.trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const head = parts[0]!.toLowerCase();
  if (head === "colors" || head === "color") {
    return { slug: "tokens-colors", path: parts.slice(1) };
  }
  if (head === "typography") {
    return { slug: "tokens-typography", path: parts.slice(1) };
  }
  if (head === "spacing") {
    return { slug: "tokens-spacing", path: parts.slice(1) };
  }
  if (head === "borders" || head === "borders_and_radius") {
    return { slug: "tokens-borders", path: parts.slice(1) };
  }
  if (head === "shadows") {
    return { slug: "tokens-shadows", path: parts.slice(1) };
  }
  if (head === "buttons") {
    return { slug: "tokens-buttons", path: parts.slice(1) };
  }
  if (head === "tone" || head === "visual_tone" || head === "anti_tone") {
    return { slug: "tokens-tone", path: parts.length > 1 ? parts.slice(1) : [] };
  }
  const knownColors = [
    "primary",
    "accent",
    "background",
    "surface-alt",
    "text-primary",
    "text-secondary",
    "text-on-dark",
    "text-on-dark-muted",
    "border",
    "overlay",
  ];
  if (parts.length === 1 && knownColors.includes(parts[0]!)) {
    return { slug: "tokens-colors", path: parts };
  }
  if (parts[0] === "scale" || parts[0] === "h1" || parts[0] === "h2" || parts[0] === "h3") {
    return { slug: "tokens-typography", path: parts[0] === "scale" ? parts.slice(1) : ["scale", ...parts] };
  }
  return null;
}

function getNested(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    if (typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function titleFromSlug(slug: string): string {
  return slug
    .replace(/^section-/, "")
    .replace(/^component-/, "")
    .replace(/^tokens-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderMarkdownValue(value: unknown, indent = ""): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => `${indent}- ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  if (value && typeof value === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        out.push(`${indent}- **${k}**:`);
        out.push(...renderMarkdownValue(v, `${indent}  `));
      } else {
        out.push(`${indent}- **${k}**: ${String(v)}`);
      }
    }
    return out;
  }
  return [`${indent}- ${String(value)}`];
}

export class UiGuidelinesStore {
  private readonly conn: Connection;

  private constructor(conn: Connection) {
    this.conn = conn;
  }

  static async open(baseDir: string): Promise<UiGuidelinesStore> {
    const path = process.env.BUFAB_UI_DB_PATH ?? defaultUiDbPath(baseDir);
    await mkdir(path, { recursive: true });
    const conn = await connect(path);
    const names = await conn.tableNames();
    if (!names.includes(T_ENTITIES)) {
      await conn.createEmptyTable(T_ENTITIES, entitiesSchema, { mode: "create" });
    }
    if (!names.includes(T_VERSIONS)) {
      await conn.createEmptyTable(T_VERSIONS, uiVersionsSchema, { mode: "create" });
    }
    if (!names.includes(T_CHUNKS)) {
      await conn.createEmptyTable(T_CHUNKS, uiChunksSchema, { mode: "create" });
    }
    const store = new UiGuidelinesStore(conn);
    if (process.env.BUFAB_UI_FORCE_RESEED === "1") {
      await store.clearAll();
    }
    return store;
  }

  async countEntities(): Promise<number> {
    const t = await this.conn.openTable(T_ENTITIES);
    return t.countRows();
  }

  async clearAll(): Promise<void> {
    const chunks = await this.conn.openTable(T_CHUNKS);
    const versions = await this.conn.openTable(T_VERSIONS);
    const entities = await this.conn.openTable(T_ENTITIES);
    await chunks.delete("id != ''");
    await versions.delete("id != ''");
    await entities.delete("id != ''");
  }

  async listEntities(filters?: { status?: string; domain?: string; kind?: string }): Promise<unknown[]> {
    const t = await this.conn.openTable(T_ENTITIES);
    const versions = await this.conn.openTable(T_VERSIONS);
    const parts: string[] = [];
    if (filters?.status?.trim()) {
      parts.push(`status = ${sqlStr(filters.status.trim())}`);
    }
    if (filters?.domain?.trim()) {
      parts.push(`domain = ${sqlStr(filters.domain.trim())}`);
    }
    if (filters?.kind?.trim()) {
      parts.push(`kind = ${sqlStr(filters.kind.trim())}`);
    }
    let q = t.query();
    if (parts.length) {
      q = q.where(parts.join(" AND "));
    }
    const entities = await q.toArray();
    const currentBodies = await versions.query().where("is_current = true").toArray();
    const bodyByEntityId = new Map<string, string>();
    for (const row of currentBodies) {
      const r = row as { entity_id: string; body: string };
      bodyByEntityId.set(r.entity_id, r.body);
    }
    return entities.map((row) => {
      const ent = row as { id: string };
      const body = bodyByEntityId.get(ent.id);
      const notes = extractNotesFromBody(body);
      return { ...ent, notes };
    });
  }

  async getEntity(options: {
    slug?: string;
    entity_id?: string;
    include_history?: boolean;
  }): Promise<{ entity: unknown; current_version?: unknown; versions?: unknown[] } | null> {
    const t = await this.conn.openTable(T_ENTITIES);
    let rows: unknown[];
    if (options.entity_id?.trim()) {
      rows = await t.query().where(`id = ${sqlStr(options.entity_id.trim())}`).limit(1).toArray();
    } else if (options.slug?.trim()) {
      rows = await t.query().where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`).limit(1).toArray();
    } else {
      return null;
    }
    if (!rows.length) {
      return null;
    }
    const entity = rows[0] as { id: string };
    const vt = await this.conn.openTable(T_VERSIONS);
    const current = await vt
      .query()
      .where(`entity_id = ${sqlStr(entity.id)} AND is_current = true`)
      .limit(1)
      .toArray();
    if (!options.include_history) {
      return { entity, current_version: current[0] };
    }
    const all = await vt.query().where(`entity_id = ${sqlStr(entity.id)}`).toArray();
    all.sort((a, b) => (b as { version: number }).version - (a as { version: number }).version);
    return { entity, current_version: current[0], versions: all };
  }

  async upsertEntity(input: {
    slug: string;
    title: string;
    body?: string;
    kind?: string;
    domain?: string;
    change_summary?: string;
    status?: string;
    entity_id?: string;
  }): Promise<{ entity_id: string; version_id: string; version: number; chunked: boolean }> {
    const slug = input.slug.trim().toLowerCase();
    if (!slug) {
      throw new Error("slug is required");
    }
    const title = input.title.trim();
    const kind = (input.kind ?? "json_fragment").trim();
    const domain = (input.domain ?? "general").trim();
    const status = (input.status ?? "active").trim();
    const now = new Date().toISOString();
    const entities = await this.conn.openTable(T_ENTITIES);
    const versions = await this.conn.openTable(T_VERSIONS);
    const chunks = await this.conn.openTable(T_CHUNKS);

    let entityId = input.entity_id?.trim();
    let existing: { id: string } | undefined;

    if (entityId) {
      const r = await entities.query().where(`id = ${sqlStr(entityId)}`).limit(1).toArray();
      existing = r[0] as { id: string } | undefined;
      if (!existing) {
        entityId = undefined;
      }
    }
    if (!existing) {
      const bySlug = await entities.query().where(`slug = ${sqlStr(slug)}`).limit(1).toArray();
      existing = bySlug[0] as { id: string } | undefined;
      if (existing) {
        entityId = existing.id;
      }
    }
    if (!entityId) {
      entityId = randomUUID();
    }

    if (input.body === undefined || input.body === "") {
      if (!existing) {
        throw new Error("body is required when creating a new UI entity");
      }
      await entities.update({
        where: `id = ${sqlStr(entityId)}`,
        values: { title, slug, status, kind, domain, updated_at: now },
      });
      return { entity_id: entityId, version_id: "", version: 0, chunked: false };
    }

    const body = input.body;
    const summary = (input.change_summary ?? "").trim();

    const priorVersions = await versions.query().where(`entity_id = ${sqlStr(entityId)}`).toArray();
    const nextVersion =
      priorVersions.length === 0
        ? 1
        : Math.max(...priorVersions.map((v) => (v as { version: number }).version)) + 1;

    if (priorVersions.length > 0) {
      await versions.update({
        where: `entity_id = ${sqlStr(entityId)} AND is_current = true`,
        values: { is_current: false },
      });
    }

    const versionId = randomUUID();
    await versions.add([
      {
        id: versionId,
        entity_id: entityId,
        version: nextVersion,
        body,
        effective_from: now,
        created_at: now,
        is_current: true,
        change_summary: summary,
      },
    ]);

    if (existing) {
      await entities.update({
        where: `id = ${sqlStr(entityId)}`,
        values: { title, slug, status, kind, domain, updated_at: now },
      });
    } else {
      await entities.add([
        {
          id: entityId,
          slug,
          title,
          kind,
          domain,
          status,
          created_at: now,
          updated_at: now,
        },
      ]);
    }

    await chunks.update({
      where: `entity_id = ${sqlStr(entityId)} AND is_current_version = true`,
      values: { is_current_version: false },
    });

    const pieces = chunkText(body);
    const texts = pieces.length > 0 ? pieces : [body];
    const ef = await getUiEmbedder();
    const vectors = await ef.computeSourceEmbeddings(texts);

    const chunkRows = texts.map((text, i) => ({
      id: randomUUID(),
      version_id: versionId,
      entity_id: entityId,
      chunk_index: i,
      text,
      is_current_version: true,
      vector: Float32Array.from(vectors[i]!),
    }));

    await chunks.add(chunkRows);

    return { entity_id: entityId, version_id: versionId, version: nextVersion, chunked: true };
  }

  async searchUi(input: {
    query: string;
    limit?: number;
    current_only?: boolean;
  }): Promise<unknown[]> {
    const q = input.query.trim();
    if (!q) {
      return [];
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
    const currentOnly = input.current_only !== false;

    const ef = await getUiEmbedder();
    const vec = await ef.computeQueryEmbeddings(q);
    const floatVec = Float32Array.from(vec);

    const chunksTbl = await this.conn.openTable(T_CHUNKS);
    let vq = chunksTbl.vectorSearch(floatVec).limit(limit * 5);
    if (currentOnly) {
      vq = vq.where("is_current_version = true");
    }
    const hits = await vq.toArray();

    const versionsTbl = await this.conn.openTable(T_VERSIONS);
    const entitiesTbl = await this.conn.openTable(T_ENTITIES);

    const enriched: unknown[] = [];
    for (const h of hits.slice(0, limit)) {
      const row = h as {
        version_id: string;
        entity_id: string;
        chunk_index: number;
        text: string;
        _distance?: number;
      };
      const verRows = await versionsTbl
        .query()
        .where(`id = ${sqlStr(row.version_id)}`)
        .limit(1)
        .toArray();
      const entRows = await entitiesTbl.query().where(`id = ${sqlStr(row.entity_id)}`).limit(1).toArray();
      enriched.push({
        distance: row._distance,
        chunk_index: row.chunk_index,
        chunk_text: row.text,
        version: verRows[0],
        entity: entRows[0],
      });
    }
    return enriched;
  }

  async deleteEntity(options: { slug?: string; entity_id?: string }): Promise<boolean> {
    let entityId = options.entity_id?.trim();
    if (!entityId && options.slug?.trim()) {
      const entities = await this.conn.openTable(T_ENTITIES);
      const r = await entities
        .query()
        .where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`)
        .limit(1)
        .toArray();
      entityId = r[0] ? (r[0] as { id: string }).id : undefined;
    }
    if (!entityId) {
      return false;
    }
    const chunks = await this.conn.openTable(T_CHUNKS);
    const versions = await this.conn.openTable(T_VERSIONS);
    const entities = await this.conn.openTable(T_ENTITIES);
    await chunks.delete(`entity_id = ${sqlStr(entityId)}`);
    await versions.delete(`entity_id = ${sqlStr(entityId)}`);
    await entities.delete(`id = ${sqlStr(entityId)}`);
    return true;
  }

  async getSectionSpec(sectionType: string): Promise<unknown | null> {
    const slug = resolveSectionSlug(sectionType);
    if (!slug) {
      return null;
    }
    const row = await this.getEntity({ slug, include_history: false });
    if (!row?.current_version) {
      return null;
    }
    const body = (row.current_version as { body: string }).body;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return { raw: body };
    }
  }

  async getToken(name: string): Promise<{ path: string; value: unknown } | null> {
    const parsed = parseTokenName(name);
    if (!parsed) {
      return null;
    }
    const row = await this.getEntity({ slug: parsed.slug, include_history: false });
    if (!row?.current_version) {
      return null;
    }
    const body = (row.current_version as { body: string }).body;
    let root: unknown;
    try {
      root = JSON.parse(body) as unknown;
    } catch {
      return null;
    }
    const value = parsed.path.length ? getNested(root, parsed.path) : root;
    const pathStr = [parsed.slug.replace(/^tokens-/, ""), ...parsed.path].filter(Boolean).join(".");
    return { path: pathStr || parsed.slug, value };
  }

  /** Merge current fragments into the canonical guidelines object shape. */
  async exportMergedGuidelines(): Promise<Record<string, unknown>> {
    const entities = await this.conn.openTable(T_ENTITIES);
    const versions = await this.conn.openTable(T_VERSIONS);
    const allEntities = await entities.query().toArray();
    const bodies = new Map<string, string>();
    for (const e of allEntities) {
      const ent = e as { id: string; slug: string };
      const cur = await versions
        .query()
        .where(`entity_id = ${sqlStr(ent.id)} AND is_current = true`)
        .limit(1)
        .toArray();
      if (cur[0]) {
        bodies.set(ent.slug, (cur[0] as { body: string }).body);
      }
    }
    const parse = (slug: string): unknown => {
      const s = bodies.get(slug);
      if (!s) {
        return undefined;
      }
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return s;
      }
    };

    const meta = parse("spec-meta");
    
    // Reconstruct tokens object
    const tokens: Record<string, any> = {};
    const tokenSlugs = [
      "tokens-colors", "tokens-effects", "tokens-typography", 
      "tokens-spacing", "tokens-borders", "tokens-shadows", 
      "tokens-transitions", "tokens-zindex"
    ];
    
    for (const slug of tokenSlugs) {
      const val = parse(slug);
      if (val && typeof val === "object") {
        Object.assign(tokens, val);
      }
    }

    // Reconstruct components object
    const components: Record<string, any> = {};
    for (const slug of bodies.keys()) {
      if (slug.startsWith("component-")) {
        const key = slug.slice("component-".length);
        const v = parse(slug);
        if (v !== undefined) {
          components[key] = v;
        }
      }
    }

    const out: Record<string, any> = {
      meta: meta || {},
      tokens: Object.keys(tokens).length ? tokens : undefined,
      layout: parse("layout-general") || parse("layout"),
      components: Object.keys(components).length ? components : undefined,
      writingStyle: parse("writing-style"),
      // Legacy fields for backward compatibility
      version: (meta as any)?.version ?? "1.0.0",
      designSystem: {
        name: (meta as any)?.name ?? "Bufab Design System",
        ...tokens
      },
      componentRules: components
    };

    // Surface ui_rules.* fragments so consumers (e.g. the UserPromptSubmit
    // hook) that follow the canonical guideline shape can find their data.
    const uiRules: Record<string, unknown> = {};
    const strictConstraints = parse("ui-rules-strict-constraints");
    if (Array.isArray(strictConstraints)) {
      uiRules.strict_constraints = strictConstraints;
    }
    const finalCheck = parse("ui-rules-final-check");
    if (Array.isArray(finalCheck)) {
      uiRules.final_check = finalCheck;
    }
    if (Object.keys(uiRules).length) {
      out.ui_rules = uiRules;
    }

    return out;
  }

  async exportMarkdownGuidelines(): Promise<string> {
    const doc = await this.exportMergedGuidelines();
    const lines: string[] = [];
    lines.push("# Bufab UI Guidelines");
    lines.push("");
    lines.push(`**Version**: ${doc.version}`);
    lines.push("");

    const ds = doc.designSystem as Record<string, unknown> | undefined;
    if (ds) {
      lines.push("## Design System");
      lines.push(...renderMarkdownValue(ds));
      lines.push("");
    }

    const components = doc.componentRules as Record<string, unknown> | undefined;
    if (components && Object.keys(components).length) {
      lines.push("## Component Rules");
      for (const [key, spec] of Object.entries(components)) {
        lines.push(`### ${titleFromSlug(key)}`);
        lines.push(...renderMarkdownValue(spec));
        lines.push("");
      }
    }

    const rules = doc.crossApplicationRules as unknown[];
    if (rules && rules.length) {
      lines.push("## Cross-Application Rules");
      for (const r of rules) {
        if (typeof r === "object" && r !== null && "rule" in r) {
          lines.push(`- ${String((r as any).rule)}`);
        } else {
          lines.push(`- ${JSON.stringify(r)}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  }
}
