import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Connection, connect } from "@lancedb/lancedb";
import { TransformersEmbeddingFunction } from "@lancedb/lancedb/embedding/transformers";
import { Field, FixedSizeList, Float32, Int32, Bool, Utf8, Schema } from "apache-arrow";
import { chunkText } from "./chunkText.js";

export const ARCH_CHUNK_EMBED_DIM = 384;

const T_PROFILES = "arch_profiles";
const T_VERSIONS = "arch_versions";
const T_CHUNKS = "arch_chunks";

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function packageRootDir(fromDir: string): string {
  return join(fromDir, "..");
}

function defaultDbPath(fromDir: string): string {
  return join(packageRootDir(fromDir), ".lancedb-arch");
}

let archEmbedder: TransformersEmbeddingFunction | null = null;
/** Ensures only one init runs and all concurrent callers await it (avoids "embedding function not initialized"). */
let archEmbedderReady: Promise<TransformersEmbeddingFunction> | null = null;

async function getArchEmbedder(): Promise<TransformersEmbeddingFunction> {
  if (archEmbedder) return archEmbedder;
  archEmbedderReady ??= (async () => {
    const ef = new TransformersEmbeddingFunction({
      model: process.env.BUFAB_ARCH_EMBEDDING_MODEL ?? process.env.BUFAB_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2",
      ndims: ARCH_CHUNK_EMBED_DIM,
    });
    await ef.init();
    archEmbedder = ef;
    return ef;
  })();
  return archEmbedderReady;
}

const profilesSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("slug", new Utf8(), false),
  new Field("title", new Utf8(), false),
  new Field("status", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("updated_at", new Utf8(), false),
]);

const versionsSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("arch_id", new Utf8(), false),
  new Field("version", new Int32(), false),
  new Field("requirements_json", new Utf8(), false),
  new Field("effective_from", new Utf8(), false),
  new Field("created_at", new Utf8(), false),
  new Field("is_current", new Bool(), false),
  new Field("change_summary", new Utf8(), false),
]);

const chunksSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field("version_id", new Utf8(), false),
  new Field("arch_id", new Utf8(), false),
  new Field("chunk_index", new Int32(), false),
  new Field("text", new Utf8(), false),
  new Field("is_current_version", new Bool(), false),
  new Field(
    "vector",
    new FixedSizeList(ARCH_CHUNK_EMBED_DIM, new Field("item", new Float32(), true)),
    false,
  ),
]);

export class ArchitectureStore {
  private readonly conn: Connection;

  private constructor(conn: Connection) {
    this.conn = conn;
  }

  static async open(baseDir: string): Promise<ArchitectureStore> {
    const path = process.env.BUFAB_ARCH_DB_PATH ?? defaultDbPath(baseDir);
    await mkdir(dirname(path), { recursive: true });
    const conn = await connect(path);
    const names = await conn.tableNames();
    if (!names.includes(T_PROFILES)) {
      await conn.createEmptyTable(T_PROFILES, profilesSchema, { mode: "create" });
    }
    if (!names.includes(T_VERSIONS)) {
      await conn.createEmptyTable(T_VERSIONS, versionsSchema, { mode: "create" });
    }
    if (!names.includes(T_CHUNKS)) {
      await conn.createEmptyTable(T_CHUNKS, chunksSchema, { mode: "create" });
    }
    return new ArchitectureStore(conn);
  }

  async listProfiles(status?: string): Promise<unknown[]> {
    const t = await this.conn.openTable(T_PROFILES);
    const q = t.query();
    if (status?.trim()) {
      q.where(`status = ${sqlStr(status.trim())}`);
    }
    return q.toArray();
  }

  async getProfile(options: {
    slug?: string;
    arch_id?: string;
    include_history?: boolean;
  }): Promise<{ profile: unknown; current_version?: unknown; versions?: unknown[] } | null> {
    const t = await this.conn.openTable(T_PROFILES);
    let rows: unknown[];
    if (options.arch_id?.trim()) {
      rows = await t.query().where(`id = ${sqlStr(options.arch_id.trim())}`).limit(1).toArray();
    } else if (options.slug?.trim()) {
      rows = await t.query().where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`).limit(1).toArray();
    } else {
      return null;
    }
    if (!rows.length) {
      return null;
    }

    const profile = rows[0] as { id: string };
    const vt = await this.conn.openTable(T_VERSIONS);
    const current = await vt
      .query()
      .where(`arch_id = ${sqlStr(profile.id)} AND is_current = true`)
      .limit(1)
      .toArray();

    if (!options.include_history) {
      return { profile, current_version: current[0] };
    }

    const all = await vt.query().where(`arch_id = ${sqlStr(profile.id)}`).toArray();
    all.sort((a, b) => (b as { version: number }).version - (a as { version: number }).version);
    return { profile, current_version: current[0], versions: all };
  }

  async upsertProfile(input: {
    slug: string;
    title: string;
    requirements_json?: string;
    change_summary?: string;
    status?: string;
    arch_id?: string;
  }): Promise<{ arch_id: string; version_id: string; version: number; chunked: boolean }> {
    const slug = input.slug.trim().toLowerCase();
    if (!slug) {
      throw new Error("slug is required");
    }
    const title = input.title.trim();
    const status = (input.status ?? "active").trim();
    const now = new Date().toISOString();

    const profiles = await this.conn.openTable(T_PROFILES);
    const versions = await this.conn.openTable(T_VERSIONS);
    const chunks = await this.conn.openTable(T_CHUNKS);

    let archId = input.arch_id?.trim();
    let existing: { id: string } | undefined;

    if (archId) {
      const r = await profiles.query().where(`id = ${sqlStr(archId)}`).limit(1).toArray();
      existing = r[0] as { id: string } | undefined;
      if (!existing) {
        archId = undefined;
      }
    }
    if (!existing) {
      const bySlug = await profiles.query().where(`slug = ${sqlStr(slug)}`).limit(1).toArray();
      existing = bySlug[0] as { id: string } | undefined;
      if (existing) {
        archId = existing.id;
      }
    }
    if (!archId) {
      archId = randomUUID();
    }

    if (input.requirements_json === undefined || input.requirements_json === "") {
      if (!existing) {
        throw new Error("requirements_json is required when creating a new architecture profile");
      }
      await profiles.update({
        where: `id = ${sqlStr(archId)}`,
        values: { title, status, updated_at: now },
      });
      return { arch_id: archId, version_id: "", version: 0, chunked: false };
    }

    const requirementsJson = input.requirements_json;
    const summary = (input.change_summary ?? "").trim();

    const priorVersions = await versions.query().where(`arch_id = ${sqlStr(archId)}`).toArray();
    const nextVersion =
      priorVersions.length === 0
        ? 1
        : Math.max(...priorVersions.map((v) => (v as { version: number }).version)) + 1;

    if (priorVersions.length > 0) {
      await versions.update({
        where: `arch_id = ${sqlStr(archId)} AND is_current = true`,
        values: { is_current: false },
      });
    }

    const versionId = randomUUID();
    await versions.add([
      {
        id: versionId,
        arch_id: archId,
        version: nextVersion,
        requirements_json: requirementsJson,
        effective_from: now,
        created_at: now,
        is_current: true,
        change_summary: summary,
      },
    ]);

    if (existing) {
      await profiles.update({
        where: `id = ${sqlStr(archId)}`,
        values: { title, slug, status, updated_at: now },
      });
    } else {
      await profiles.add([
        {
          id: archId,
          slug,
          title,
          status,
          created_at: now,
          updated_at: now,
        },
      ]);
    }

    await chunks.update({
      where: `arch_id = ${sqlStr(archId)} AND is_current_version = true`,
      values: { is_current_version: false },
    });

    const pieces = chunkText(requirementsJson);
    const texts = pieces.length > 0 ? pieces : [requirementsJson];
    const ef = await getArchEmbedder();
    const vectors = await ef.computeSourceEmbeddings(texts);

    const chunkRows = texts.map((text, i) => ({
      id: randomUUID(),
      version_id: versionId,
      arch_id: archId,
      chunk_index: i,
      text,
      is_current_version: true,
      vector: Float32Array.from(vectors[i]!),
    }));

    await chunks.add(chunkRows);

    return { arch_id: archId, version_id: versionId, version: nextVersion, chunked: true };
  }

  async searchProfiles(input: {
    query: string;
    limit?: number;
    current_only?: boolean;
  }): Promise<unknown[]> {
    const q = input.query.trim();
    if (!q) return [];

    const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
    const currentOnly = input.current_only !== false;

    const ef = await getArchEmbedder();
    const vec = await ef.computeQueryEmbeddings(q);
    const floatVec = Float32Array.from(vec);

    const chunksTbl = await this.conn.openTable(T_CHUNKS);
    let vq = chunksTbl.vectorSearch(floatVec).limit(limit * 5);
    if (currentOnly) {
      vq = vq.where("is_current_version = true");
    }
    const hits = await vq.toArray();

    const versionsTbl = await this.conn.openTable(T_VERSIONS);
    const profilesTbl = await this.conn.openTable(T_PROFILES);

    const enriched: unknown[] = [];
    for (const h of hits.slice(0, limit)) {
      const row = h as {
        version_id: string;
        arch_id: string;
        chunk_index: number;
        text: string;
        _distance?: number;
      };
      const verRows = await versionsTbl.query().where(`id = ${sqlStr(row.version_id)}`).limit(1).toArray();
      const profRows = await profilesTbl.query().where(`id = ${sqlStr(row.arch_id)}`).limit(1).toArray();
      enriched.push({
        distance: row._distance,
        chunk_index: row.chunk_index,
        chunk_text: row.text,
        version: verRows[0],
        profile: profRows[0],
      });
    }
    return enriched;
  }

  async deleteProfile(options: { slug?: string; arch_id?: string }): Promise<boolean> {
    let archId = options.arch_id?.trim();
    if (!archId && options.slug?.trim()) {
      const profiles = await this.conn.openTable(T_PROFILES);
      const r = await profiles
        .query()
        .where(`slug = ${sqlStr(options.slug.trim().toLowerCase())}`)
        .limit(1)
        .toArray();
      archId = r[0] ? (r[0] as { id: string }).id : undefined;
    }
    if (!archId) {
      return false;
    }
    const chunks = await this.conn.openTable(T_CHUNKS);
    const versions = await this.conn.openTable(T_VERSIONS);
    const profiles = await this.conn.openTable(T_PROFILES);
    await chunks.delete(`arch_id = ${sqlStr(archId)}`);
    await versions.delete(`arch_id = ${sqlStr(archId)}`);
    await profiles.delete(`id = ${sqlStr(archId)}`);
    return true;
  }
}

