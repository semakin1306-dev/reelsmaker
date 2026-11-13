import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Clip, ClipRole, Story, StoryStatus, Variant, VariantStatus } from "./model.ts";

type Row = Record<string, unknown>;

export interface RepoOptions {
  /** Источник времени (для тестов). По умолчанию — текущее. */
  now?: () => Date;
}

const toJson = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const fromJson = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : null);
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);

const mapStory = (r: Row): Story => ({
  id: num(r["id"]),
  folder: str(r["folder"]),
  title: str(r["title"]),
  status: str(r["status"]) as StoryStatus,
  meta: fromJson(r["meta_json"]),
  createdAt: str(r["created_at"]),
  updatedAt: str(r["updated_at"]),
});

const mapClip = (r: Row): Clip => ({
  id: num(r["id"]),
  storyId: num(r["story_id"]),
  file: str(r["file"]),
  role: str(r["role"]) as ClipRole,
  position: num(r["position"]),
  take: strOrNull(r["take"]),
  durationMs: num(r["duration_ms"]),
  transcript: fromJson(r["transcript_json"]),
  createdAt: str(r["created_at"]),
});

const mapVariant = (r: Row): Variant => ({
  id: num(r["id"]),
  storyId: num(r["story_id"]),
  idx: num(r["idx"]),
  editPlan: fromJson(r["edit_plan_json"]),
  file: strOrNull(r["file"]),
  previewFile: strOrNull(r["preview_file"]),
  status: str(r["status"]) as VariantStatus,
  error: strOrNull(r["error"]),
  createdAt: str(r["created_at"]),
  updatedAt: str(r["updated_at"]),
});

/** Чтение и запись модели. Все функции синхронные (node:sqlite), время пишется в UTC. */
export function createRepo(db: DatabaseSync, options: RepoOptions = {}) {
  const now = (): string => (options.now ? options.now() : new Date()).toISOString();

  const insert = (sql: string, ...params: SQLInputValue[]): number =>
    Number(db.prepare(sql).run(...params).lastInsertRowid);
  const one = <T>(map: (r: Row) => T, sql: string, ...params: SQLInputValue[]): T | null => {
    const row = db.prepare(sql).get(...params);
    return row ? map(row) : null;
  };
  const many = <T>(map: (r: Row) => T, sql: string, ...params: SQLInputValue[]): T[] =>
    db
      .prepare(sql)
      .all(...params)
      .map((r) => map(r));
  const must = <T>(value: T | null, what: string): T => {
    if (value === null) throw new Error(`Не найдено: ${what}`);
    return value;
  };

  const getStory = (id: number) => one(mapStory, "SELECT * FROM story WHERE id = ?", id);
  const getClip = (id: number) => one(mapClip, "SELECT * FROM clip WHERE id = ?", id);
  const getVariant = (id: number) => one(mapVariant, "SELECT * FROM variant WHERE id = ?", id);

  return {
    // --- сюжет ---
    createStory(input: { folder: string; title: string; meta?: unknown }): Story {
      const t = now();
      const id = insert(
        "INSERT INTO story (folder, title, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        input.folder,
        input.title,
        toJson(input.meta),
        t,
        t,
      );
      return must(getStory(id), `сюжет ${id}`);
    },
    getStory,
    getStoryByFolder: (folder: string) => one(mapStory, "SELECT * FROM story WHERE folder = ?", folder),
    listStories: (status?: StoryStatus): Story[] =>
      status
        ? many(mapStory, "SELECT * FROM story WHERE status = ? ORDER BY id", status)
        : many(mapStory, "SELECT * FROM story ORDER BY id"),
    setStoryStatus(id: number, status: StoryStatus): void {
      db.prepare("UPDATE story SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    },
    /** Каскадом убирает сценки и варианты сюжета (файлы на диске не трогает). */
    deleteStory(id: number): void {
      db.prepare("DELETE FROM story WHERE id = ?").run(id);
    },

    // --- сценка ---
    addClip(input: {
      storyId: number;
      file: string;
      role: ClipRole;
      position: number;
      durationMs: number;
      take?: string | null;
      transcript?: unknown;
    }): Clip {
      const id = insert(
        `INSERT INTO clip (story_id, file, role, position, take, duration_ms, transcript_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.storyId,
        input.file,
        input.role,
        input.position,
        input.take ?? null,
        input.durationMs,
        toJson(input.transcript),
        now(),
      );
      return must(getClip(id), `сценка ${id}`);
    },
    listClips: (storyId: number): Clip[] =>
      many(mapClip, "SELECT * FROM clip WHERE story_id = ? ORDER BY position, id", storyId),
    setClipTranscript(id: number, transcript: unknown): void {
      db.prepare("UPDATE clip SET transcript_json = ? WHERE id = ?").run(toJson(transcript), id);
    },

    // --- вариант ---
    createVariant(input: { storyId: number; idx: number; editPlan: unknown }): Variant {
      const t = now();
      const id = insert(
        "INSERT INTO variant (story_id, idx, edit_plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        input.storyId,
        input.idx,
        JSON.stringify(input.editPlan),
        t,
        t,
      );
      return must(getVariant(id), `вариант ${id}`);
    },
    getVariant,
    listVariants: (storyId: number): Variant[] =>
      many(mapVariant, "SELECT * FROM variant WHERE story_id = ? ORDER BY idx", storyId),
    setVariantStatus(id: number, status: VariantStatus, error?: string | null): void {
      db.prepare("UPDATE variant SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(
        status,
        error ?? null,
        now(),
        id,
      );
    },
    setVariantRendered(id: number, files: { file: string; previewFile?: string | null }): void {
      db.prepare(
        "UPDATE variant SET status = 'rendered', file = ?, preview_file = ?, error = NULL, updated_at = ? WHERE id = ?",
      ).run(files.file, files.previewFile ?? null, now(), id);
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
