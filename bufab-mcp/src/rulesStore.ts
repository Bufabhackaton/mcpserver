import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Connection, connect } from "@lancedb/lancedb";
import { TransformersEmbeddingFunction } from "@lancedb/lancedb/embedding/transformers";
import { Field, FixedSizeList, Float32, Int32, Bool, Utf8, Schema } from "apache-arrow";
import { chunkText } from "./chunkText.js";

export const CHUNK_EMBED_DIM = 384;

const T_RULES = "rules";
const T_VERSIONS = "rule_versions";
const T_CHUNKS = "rule_chunks";

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function packageRootDir(fromDir: string): string {
  return join(fromDir, "..");
}

function defaultDbPath(fromDir: string): string {
  return join(packageRootDir(fromDir), ".lancedb");
}

let embedder: TransformersEmbeddingFunction | null = null;
let embedderReady: Promise<TransformersEmbeddingFunction> | null = null;

async function getEmbedder(): Promise<TransformersEmbeddingFunction> {
  if (embedder) return embedder;
  embedderReady ??= (async () => {
    const ef = new TransformersEmbeddingFunction({
      model: process.env.BUFAB_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
      ndims: CHUNK_EMBED_DIM,
    });
    await ef.init();
    embedder = ef;
    return ef;
  })();
  return embedderReady;
}

const rulesSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("slug", new Utf8(), false),
  new Field("title", new Utf8(), false),
  new Field("status", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("updated_at", new Utf8(), false),
]);

const versionsSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("rule_id", new Utf8(), false),
  new Field("version", new Int32(), false),
  new Field("body", new Utf8(), false),
  new Field("effective_from", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("is_current", new Bool(), false),
  new Field("change_summary", new Utf8(), false),
]);

const chunksSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("rule_version_id", new Utf8(), false),
  new Field("rule_id", new Utf8(), false),
  new Field("chunk_index", new Int32(), false),
  new Field("text", new Utf8(), false),
  new Field("is_current_version", new Bool(), false),
  new Field(
    "vector",
    new FixedSizeList(CHUNK_EMBED_DIM, new Field("item", new Float32(), true)),
    false,
  ),
]);

export class RulesStore {
  private readonly conn: Connection;

  private constructor(conn: Connection) {
    this.conn = conn;
  }

  static async open(baseDir: string): Promise<RulesStore> {
    const path = process.env.BUFAB_RULES_DB_PATH ?? defaultDbPath(baseDir);
    await mkdir(dirname(path), { recursive: true });
    const conn = await connect(path);
    const names = await conn.tableNames();
    if (!names.includes(T_RULES)) {
      await conn.createEmptyTable(T_RULES, rulesSchema, { mode: "create" });
    }
    if (!names.includes(T_VERSIONS)) {
      await conn.createEmptyTable(T_VERSIONS, versionsSchema, { mode: "create" });
    }
    if (!names.includes(T_CHUNKS)) {
      await conn.createEmptyTable(T_CHUNKS, chunksSchema, { mode: "create" });
    }
    return new RulesStore(conn);
  }

  async listRules(status?: string): Promise<unknown[]> {
    const t = await this.conn.openTable(T_RULES);
    const q = t.query();
    if (status?.trim()) {
      q.where(`status = ${sqlStr(status.trim())}`);
    }
    return q.toArray();
  }

  async getRule(options: {
    slug?: string;
    rule_id?: string;
    include_history?: boolean;
  }): Promise<{ rule: unknown; current_version?: unknown; versions?: unknown[] } | null> {
    const t = await this.conn.openTable(T_RULES);
    let rows: unknown[];
    if (options.rule_id?.trim()) {
      rows = await t.query().where(`id = ${sqlStr(options.rule_id.trim())}`).limit(1).toArray();
    } else if (options.slug?.trim()) {
      rows = await t.query().where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`).limit(1).toArray();
    } else {
      return null;
    }
    if (!rows.length) {
      return null;
    }
    const rule = rows[0] as { id: string };
    const vt = await this.conn.openTable(T_VERSIONS);
    const current = await vt
      .query()
      .where(`rule_id = ${sqlStr(rule.id)} AND is_current = true`)
      .limit(1)
      .toArray();
    if (!options.include_history) {
      return { rule, current_version: current[0] };
    }
    const all = await vt.query().where(`rule_id = ${sqlStr(rule.id)}`).toArray();
    all.sort((a, b) => (b as { version: number }).version - (a as { version: number }).version);
    return { rule, current_version: current[0], versions: all };
  }

  async upsertRule(input: {
    slug: string;
    title: string;
    body?: string;
    change_summary?: string;
    status?: string;
    rule_id?: string;
  }): Promise<{ rule_id: string; version_id: string; version: number; chunked: boolean }> {
    const slug = input.slug.trim().toLowerCase();
    if (!slug) {
      throw new Error("slug is required");
    }
    const title = input.title.trim();
    const status = (input.status ?? "active").trim();
    const now = new Date().toISOString();
    const rules = await this.conn.openTable(T_RULES);
    const versions = await this.conn.openTable(T_VERSIONS);
    const chunks = await this.conn.openTable(T_CHUNKS);

    let ruleId = input.rule_id?.trim();
    let existing: { id: string } | undefined;

    if (ruleId) {
      const r = await rules.query().where(`id = ${sqlStr(ruleId)}`).limit(1).toArray();
      existing = r[0] as { id: string } | undefined;
      if (!existing) {
        ruleId = undefined;
      }
    }
    if (!existing) {
      const bySlug = await rules.query().where(`slug = ${sqlStr(slug)}`).limit(1).toArray();
      existing = bySlug[0] as { id: string } | undefined;
      if (existing) {
        ruleId = existing.id;
      }
    }
    if (!ruleId) {
      ruleId = randomUUID();
    }

    if (input.body === undefined || input.body === "") {
      if (!existing) {
        throw new Error("body is required when creating a new rule");
      }
      await rules.update({
        where: `id = ${sqlStr(ruleId)}`,
        values: { title, status, updated_at: now },
      });
      return { rule_id: ruleId, version_id: "", version: 0, chunked: false };
    }

    const body = input.body;
    const summary = (input.change_summary ?? "").trim();

    const priorVersions = await versions.query().where(`rule_id = ${sqlStr(ruleId)}`).toArray();
    const nextVersion =
      priorVersions.length === 0
        ? 1
        : Math.max(...priorVersions.map((v) => (v as { version: number }).version)) + 1;

    if (priorVersions.length > 0) {
      await versions.update({
        where: `rule_id = ${sqlStr(ruleId)} AND is_current = true`,
        values: { is_current: false },
      });
    }

    const versionId = randomUUID();
    await versions.add([
      {
        id: versionId,
        rule_id: ruleId,
        version: nextVersion,
        body,
        effective_from: now,
        created_at: now,
        is_current: true,
        change_summary: summary,
      },
    ]);

    if (existing) {
      await rules.update({
        where: `id = ${sqlStr(ruleId)}`,
        values: { title, slug, status, updated_at: now },
      });
    } else {
      await rules.add([
        {
          id: ruleId,
          slug,
          title,
          status,
          created_at: now,
          updated_at: now,
        },
      ]);
    }

    await chunks.update({
      where: `rule_id = ${sqlStr(ruleId)} AND is_current_version = true`,
      values: { is_current_version: false },
    });

    const pieces = chunkText(body);
    const texts = pieces.length > 0 ? pieces : [body];
    const ef = await getEmbedder();
    const vectors = await ef.computeSourceEmbeddings(texts);

    const chunkRows = texts.map((text, i) => ({
      id: randomUUID(),
      rule_version_id: versionId,
      rule_id: ruleId,
      chunk_index: i,
      text,
      is_current_version: true,
      vector: Float32Array.from(vectors[i]!),
    }));

    await chunks.add(chunkRows);

    return { rule_id: ruleId, version_id: versionId, version: nextVersion, chunked: true };
  }

  async searchRules(input: {
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

    const ef = await getEmbedder();
    const vec = await ef.computeQueryEmbeddings(q);
    const floatVec = Float32Array.from(vec);

    const chunksTbl = await this.conn.openTable(T_CHUNKS);
    let vq = chunksTbl.vectorSearch(floatVec).limit(limit * 5);
    if (currentOnly) {
      vq = vq.where("is_current_version = true");
    }
    const hits = await vq.toArray();

    const versionsTbl = await this.conn.openTable(T_VERSIONS);
    const rulesTbl = await this.conn.openTable(T_RULES);

    const enriched: unknown[] = [];
    for (const h of hits.slice(0, limit)) {
      const row = h as {
        rule_version_id: string;
        rule_id: string;
        chunk_index: number;
        text: string;
        _distance?: number;
      };
      const verRows = await versionsTbl
        .query()
        .where(`id = ${sqlStr(row.rule_version_id)}`)
        .limit(1)
        .toArray();
      const ruleRows = await rulesTbl.query().where(`id = ${sqlStr(row.rule_id)}`).limit(1).toArray();
      enriched.push({
        distance: row._distance,
        chunk_index: row.chunk_index,
        chunk_text: row.text,
        version: verRows[0],
        rule: ruleRows[0],
      });
    }
    return enriched;
  }

  async deleteRule(options: { slug?: string; rule_id?: string }): Promise<boolean> {
    let ruleId = options.rule_id?.trim();
    if (!ruleId && options.slug?.trim()) {
      const rules = await this.conn.openTable(T_RULES);
      const r = await rules
        .query()
        .where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`)
        .limit(1)
        .toArray();
      ruleId = r[0] ? (r[0] as { id: string }).id : undefined;
    }
    if (!ruleId) {
      return false;
    }
    const chunks = await this.conn.openTable(T_CHUNKS);
    const versions = await this.conn.openTable(T_VERSIONS);
    const rules = await this.conn.openTable(T_RULES);
    await chunks.delete(`rule_id = ${sqlStr(ruleId)}`);
    await versions.delete(`rule_id = ${sqlStr(ruleId)}`);
    await rules.delete(`id = ${sqlStr(ruleId)}`);
    return true;
  }
}
