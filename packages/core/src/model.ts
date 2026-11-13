// Типы модели данных (см. migrations/: 001_init.sql, 002_drop_publishing.sql). Время — UTC, строка ISO 8601.
// JSON-поля возвращаются уже разобранными (unknown): форму задают части, которые их пишут.
// Публикации в ReelsMaker нет: только сюжет, сценки и собранные варианты.

export const STORY_STATUSES = ["new", "uploaded", "planned", "rendering", "ready", "failed"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export const CLIP_ROLES = ["hook", "body", "final"] as const;
export type ClipRole = (typeof CLIP_ROLES)[number];

export const VARIANT_STATUSES = ["planned", "rendering", "rendered", "failed"] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

export interface Story {
  id: number;
  folder: string;
  title: string;
  status: StoryStatus;
  meta: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface Clip {
  id: number;
  storyId: number;
  file: string;
  role: ClipRole;
  position: number;
  /** Буква дубля (NNa/NNb) или null. */
  take: string | null;
  durationMs: number;
  transcript: unknown | null;
  createdAt: string;
}

export interface Variant {
  id: number;
  storyId: number;
  idx: number;
  editPlan: unknown;
  file: string | null;
  previewFile: string | null;
  status: VariantStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
