import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
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

function defaultGuidelinesJsonPath(fromDir: string): string {
  const pkg = packageRootDir(fromDir);
  return join(pkg, "..", "..", "allguidelines", "bufab_ui_guidelines.json");
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

/** Split canonical bufab_ui_guidelines.json into Lance rows (fragments only). */
export function splitGuidelinesToFragments(root: Record<string, unknown>): UiFragment[] {
  const out: UiFragment[] = [];
  if (root.meta && typeof root.meta === "object") {
    out.push({
      slug: "spec-meta",
      title: "Spec metadata",
      kind: "json_fragment",
      domain: "meta",
      body: JSON.stringify(root.meta),
    });
  }
  const ur = root.ui_rules as Record<string, unknown> | undefined;
  if (!ur) {
    return out;
  }
  if (ur.layout) {
    out.push({
      slug: "layout",
      title: "Page layout",
      kind: "json_fragment",
      domain: "layout",
      body: JSON.stringify(ur.layout),
    });
  }
  const comp = ur.components as Record<string, unknown> | undefined;
  if (comp) {
    if (comp.header) {
      out.push({
        slug: "component-header",
        title: "Header component",
        kind: "json_fragment",
        domain: "component",
        body: JSON.stringify(comp.header),
      });
    }
    if (comp.hero) {
      out.push({
        slug: "section-hero",
        title: "Hero section",
        kind: "json_fragment",
        domain: "section",
        body: JSON.stringify(comp.hero),
      });
    }
    if (comp.footer) {
      out.push({
        slug: "component-footer",
        title: "Footer component",
        kind: "json_fragment",
        domain: "component",
        body: JSON.stringify(comp.footer),
      });
    }
    const sections = comp.sections as Record<string, unknown> | undefined;
    const types = sections?.types as Record<string, unknown> | undefined;
    if (types) {
      for (const [key, val] of Object.entries(types)) {
        const slug = `section-${key}`;
        out.push({
          slug,
          title: `Section type: ${key}`,
          kind: "json_fragment",
          domain: "section",
          body: JSON.stringify(val),
        });
      }
    }
  }
  const style = ur.style as Record<string, unknown> | undefined;
  if (style) {
    if (style.colors) {
      out.push({
        slug: "tokens-colors",
        title: "Color tokens",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.colors),
      });
    }
    if (style.typography) {
      out.push({
        slug: "tokens-typography",
        title: "Typography",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.typography),
      });
    }
    if (style.spacing) {
      out.push({
        slug: "tokens-spacing",
        title: "Spacing",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.spacing),
      });
    }
    if (style.borders_and_radius) {
      out.push({
        slug: "tokens-borders",
        title: "Borders and radius",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.borders_and_radius),
      });
    }
    if (style.shadows) {
      out.push({
        slug: "tokens-shadows",
        title: "Shadows",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.shadows),
      });
    }
    if (style.buttons) {
      out.push({
        slug: "tokens-buttons",
        title: "Buttons",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify(style.buttons),
      });
    }
    if (style.visual_tone !== undefined || style.anti_tone !== undefined) {
      out.push({
        slug: "tokens-tone",
        title: "Visual tone",
        kind: "json_fragment",
        domain: "tokens",
        body: JSON.stringify({
          visual_tone: style.visual_tone,
          anti_tone: style.anti_tone,
        }),
      });
    }
  }
  if (ur.imagery) {
    out.push({
      slug: "imagery",
      title: "Imagery",
      kind: "json_fragment",
      domain: "content",
      body: JSON.stringify(ur.imagery),
    });
  }
  if (ur.strict_constraints) {
    out.push({
      slug: "constraints-strict",
      title: "Strict constraints",
      kind: "json_fragment",
      domain: "policy",
      body: JSON.stringify(ur.strict_constraints),
    });
  }
  if (ur.final_check) {
    out.push({
      slug: "checklist-final",
      title: "Final checklist",
      kind: "json_fragment",
      domain: "policy",
      body: JSON.stringify(ur.final_check),
    });
  }
  return out;
}

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
    const n = await store.countEntities();
    if (n === 0) {
      const jsonPath = process.env.BUFAB_UI_GUIDELINES_JSON ?? defaultGuidelinesJsonPath(baseDir);
      if (existsSync(jsonPath)) {
        const raw = readFileSync(jsonPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        await store.seedFromFragments(splitGuidelinesToFragments(parsed), "initial seed from JSON");
      }
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

  async seedFromFragments(fragments: UiFragment[], changeSummary: string): Promise<{ inserted: number }> {
    let n = 0;
    for (const f of fragments) {
      await this.upsertEntity({
        slug: f.slug,
        title: f.title,
        kind: f.kind,
        domain: f.domain,
        body: f.body,
        change_summary: changeSummary,
        status: "active",
      });
      n += 1;
    }
    return { inserted: n };
  }

  async seedFromFile(filePath: string, changeSummary?: string): Promise<{ inserted: number }> {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fragments = splitGuidelinesToFragments(parsed);
    return this.seedFromFragments(fragments, changeSummary ?? `seed from ${filePath}`);
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

  /** Merge current fragments into bufab_ui_guidelines.json shape. */
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

    const meta = parse("spec-meta") as Record<string, unknown> | undefined;
    const sectionTypes: Record<string, unknown> = {};
    for (const slug of bodies.keys()) {
      if (slug.startsWith("section-") && slug !== "section-hero") {
        const key = slug.slice("section-".length);
        const v = parse(slug);
        if (v !== undefined) {
          sectionTypes[key] = v;
        }
      }
    }

    const style: Record<string, unknown> = {};
    const c = parse("tokens-colors");
    if (c !== undefined) {
      style.colors = c;
    }
    const typ = parse("tokens-typography");
    if (typ !== undefined) {
      style.typography = typ;
    }
    const sp = parse("tokens-spacing");
    if (sp !== undefined) {
      style.spacing = sp;
    }
    const br = parse("tokens-borders");
    if (br !== undefined) {
      style.borders_and_radius = br;
    }
    const sh = parse("tokens-shadows");
    if (sh !== undefined) {
      style.shadows = sh;
    }
    const bt = parse("tokens-buttons");
    if (bt !== undefined) {
      style.buttons = bt;
    }
    const tone = parse("tokens-tone") as Record<string, unknown> | undefined;
    if (tone) {
      if (tone.visual_tone !== undefined) {
        style.visual_tone = tone.visual_tone;
      }
      if (tone.anti_tone !== undefined) {
        style.anti_tone = tone.anti_tone;
      }
    }

    const components: Record<string, unknown> = {};
    const header = parse("component-header");
    if (header !== undefined) {
      components.header = header;
    }
    const hero = parse("section-hero");
    if (hero !== undefined) {
      components.hero = hero;
    }
    if (Object.keys(sectionTypes).length) {
      components.sections = { types: sectionTypes };
    }
    const footer = parse("component-footer");
    if (footer !== undefined) {
      components.footer = footer;
    }

    const ui_rules: Record<string, unknown> = {};
    const layout = parse("layout");
    if (layout !== undefined) {
      ui_rules.layout = layout;
    }
    if (Object.keys(components).length) {
      ui_rules.components = components;
    }
    if (Object.keys(style).length) {
      ui_rules.style = style;
    }
    const imagery = parse("imagery");
    if (imagery !== undefined) {
      ui_rules.imagery = imagery;
    }
    const strict = parse("constraints-strict");
    if (strict !== undefined) {
      ui_rules.strict_constraints = strict;
    }
    const fin = parse("checklist-final");
    if (fin !== undefined) {
      ui_rules.final_check = fin;
    }

    const out: Record<string, unknown> = {};
    if (meta) {
      out.meta = meta;
    }
    if (Object.keys(ui_rules).length) {
      out.ui_rules = ui_rules;
    }
    return out;
  }

  async exportMarkdownGuidelines(): Promise<string> {
    const doc = await this.exportMergedGuidelines();
    const lines: string[] = [];
    lines.push("# Bufab UI Guidelines (from LanceDB)");
    lines.push("");

    const meta = doc.meta as Record<string, unknown> | undefined;
    if (meta) {
      lines.push("## Meta");
      lines.push(...renderMarkdownValue(meta));
      lines.push("");
    }

    const ui = doc.ui_rules as Record<string, unknown> | undefined;
    if (!ui) {
      return lines.join("\n").trim();
    }

    if (ui.layout !== undefined) {
      lines.push("## Layout");
      lines.push(...renderMarkdownValue(ui.layout));
      lines.push("");
    }

    const components = ui.components as Record<string, unknown> | undefined;
    if (components) {
      lines.push("## Components");
      const preferredOrder = [
        "header",
        "hero",
        "sections",
        "footer",
      ];
      const keys = [
        ...preferredOrder.filter((k) => Object.prototype.hasOwnProperty.call(components, k)),
        ...Object.keys(components).filter((k) => !preferredOrder.includes(k)),
      ];
      for (const key of keys) {
        if (key === "sections") {
          const sec = components.sections as Record<string, unknown> | undefined;
          const types = sec?.types as Record<string, unknown> | undefined;
          if (!types) {
            continue;
          }
          lines.push("### Section Types");
          for (const [sectionType, spec] of Object.entries(types)) {
            lines.push(`#### ${titleFromSlug(sectionType)}`);
            lines.push(...renderMarkdownValue(spec));
            lines.push("");
          }
          continue;
        }
        lines.push(`### ${titleFromSlug(key)}`);
        lines.push(...renderMarkdownValue(components[key]));
        lines.push("");
      }
    }

    if (ui.style !== undefined) {
      lines.push("## Style");
      lines.push(...renderMarkdownValue(ui.style));
      lines.push("");
    }
    if (ui.imagery !== undefined) {
      lines.push("## Imagery");
      lines.push(...renderMarkdownValue(ui.imagery));
      lines.push("");
    }
    if (ui.strict_constraints !== undefined) {
      lines.push("## Strict Constraints");
      lines.push(...renderMarkdownValue(ui.strict_constraints));
      lines.push("");
    }
    if (ui.final_check !== undefined) {
      lines.push("## Final Check");
      lines.push(...renderMarkdownValue(ui.final_check));
      lines.push("");
    }

    return lines.join("\n").trim();
  }
}
