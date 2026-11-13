-- RF0: модель данных. Время — UTC, строка ISO 8601 (2026-11-10T12:00:00.000Z).
-- JSON-поля — TEXT с проверкой json_valid. Внешние ключи включает openDb (PRAGMA foreign_keys=ON).

-- Сюжет: папка со сценками.
CREATE TABLE story (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder     TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'uploaded', 'planned', 'rendering', 'ready', 'done', 'failed')),
  meta_json  TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Сценка: один файл сюжета.
CREATE TABLE clip (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id        INTEGER NOT NULL REFERENCES story (id) ON DELETE CASCADE,
  file            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'body' CHECK (role IN ('hook', 'body', 'final')),
  position        INTEGER NOT NULL,
  take            TEXT,
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0),
  transcript_json TEXT CHECK (transcript_json IS NULL OR json_valid(transcript_json)),
  created_at      TEXT NOT NULL,
  UNIQUE (story_id, file)
);
CREATE INDEX clip_story_idx ON clip (story_id, position);

-- Вариант: ролик-перемонтаж сюжета.
CREATE TABLE variant (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id       INTEGER NOT NULL REFERENCES story (id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL CHECK (idx >= 1),
  edit_plan_json TEXT NOT NULL CHECK (json_valid(edit_plan_json)),
  file           TEXT,
  preview_file   TEXT,
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned', 'rendering', 'rendered', 'approved', 'rejected', 'failed')),
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (story_id, idx)
);

-- Канал публикации. Сам токен в базе не хранится: secret_ref — имя записи в .env/хранилище секретов.
CREATE TABLE channel (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('instagram', 'youtube', 'vk', 'telegram')),
  account    TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (kind, account)
);

-- Публикация варианта в канал. Один вариант в один канал — только раз.
CREATE TABLE post (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id   INTEGER NOT NULL REFERENCES variant (id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channel (id) ON DELETE RESTRICT,
  scheduled_at TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  external_id  TEXT,
  url          TEXT,
  error        TEXT,
  published_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (variant_id, channel_id)
);
CREATE INDEX post_due_idx ON post (status, scheduled_at);

-- Журнал попыток публикации (и повторов при сетевых сбоях).
CREATE TABLE attempt (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES post (id) ON DELETE CASCADE,
  ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error        TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at   TEXT NOT NULL
);
CREATE INDEX attempt_post_idx ON attempt (post_id, id);

-- Статистика по посту: срезы во времени.
CREATE TABLE metric (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES post (id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  likes        INTEGER NOT NULL DEFAULT 0,
  comments     INTEGER NOT NULL DEFAULT 0,
  shares       INTEGER NOT NULL DEFAULT 0,
  extra_json   TEXT CHECK (extra_json IS NULL OR json_valid(extra_json))
);
CREATE INDEX metric_post_idx ON metric (post_id, id);
