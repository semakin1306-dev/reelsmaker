-- ReelsMaker занимается только монтажом, публикацию сняли (владелец, 12.11.2026). Миграция убирает её следы:
--   * таблицы channel, post, attempt, metric;
--   * статус сюжета 'done' («все посты опубликованы») → 'ready';
--   * статусы варианта 'approved' / 'rejected' (одобрение к публикации) → 'rendered';
--   * флаг автопилота публикации story.meta_json.autopilot.
--
-- Чтобы поменять CHECK, SQLite требует пересоздать таблицу. openDb включает внешние ключи, а внутри транзакции
-- их не выключить, поэтому DROP TABLE story каскадом удалил бы сценки и варианты. Порядок такой: новые таблицы
-- story_new / clip_new / variant_new ссылаются друг на друга → данные копируются с прежними id → старые таблицы
-- удаляются (дочерние первыми) → новые переименовываются (ссылки внешних ключей SQLite переписывает сам).

DROP TABLE metric;
DROP TABLE attempt;
DROP TABLE post;
DROP TABLE channel;

CREATE TABLE story_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder     TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'uploaded', 'planned', 'rendering', 'ready', 'failed')),
  meta_json  TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE clip_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id        INTEGER NOT NULL REFERENCES story_new (id) ON DELETE CASCADE,
  file            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'body' CHECK (role IN ('hook', 'body', 'final')),
  position        INTEGER NOT NULL,
  take            TEXT,
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0),
  transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
  created_at      TEXT NOT NULL,
  UNIQUE (story_id, file)
);

CREATE TABLE variant_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id       INTEGER NOT NULL REFERENCES story_new (id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL CHECK (idx >= 1),
  edit_plan_json TEXT NOT NULL CHECK (json_valid(edit_plan_json)),
  file           TEXT,
  preview_file   TEXT,
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned', 'rendering', 'rendered', 'failed')),
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (story_id, idx)
);

INSERT INTO story_new (id, folder, title, status, meta_json, created_at, updated_at)
SELECT id, folder, title,
       CASE status WHEN 'done' THEN 'ready' ELSE status END,
       CASE WHEN meta_json IS NULL THEN NULL ELSE json_remove(meta_json, '$.autopilot') END,
       created_at, updated_at
FROM story;

INSERT INTO clip_new (id, story_id, file, role, position, take, duration_ms, transcript_json, created_at)
SELECT id, story_id, file, role, position, take, duration_ms, transcript_json, created_at
FROM clip;

INSERT INTO variant_new (id, story_id, idx, edit_plan_json, file, preview_file, status, error, created_at, updated_at)
SELECT id, story_id, idx, edit_plan_json, file, preview_file,
       CASE WHEN status IN ('approved', 'rejected') THEN 'rendered' ELSE status END,
       error, created_at, updated_at
FROM variant;

-- Счётчики AUTOINCREMENT переносятся как были: id удалённых записей не выдаются повторно.
DELETE FROM sqlite_sequence WHERE name IN ('story_new', 'clip_new', 'variant_new');
INSERT INTO sqlite_sequence (name, seq)
SELECT name || '_new', seq FROM sqlite_sequence WHERE name IN ('story', 'clip', 'variant');

DROP TABLE variant;
DROP TABLE clip;
DROP TABLE story;

ALTER TABLE story_new RENAME TO story;
ALTER TABLE clip_new RENAME TO clip;
ALTER TABLE variant_new RENAME TO variant;

CREATE INDEX clip_story_idx ON clip (story_id, position);
