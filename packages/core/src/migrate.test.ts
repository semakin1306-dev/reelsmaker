import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { migrate, loadMigrations, latestVersion, appliedVersions, MIGRATIONS_DIR } from "./migrate.ts";
import { createRepo } from "./repo.ts";

const TABLES = ["story", "clip", "variant"];
const PUBLISHING_TABLES = ["channel", "post", "attempt", "metric"];

const tableNames = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => String(r["name"]));

test("openDb поднимает пустую базу до последней версии; таблиц публикации нет", () => {
  const db = openDb(":memory:");
  const tables = tableNames(db);
  for (const t of TABLES) assert.ok(tables.includes(t), `нет таблицы ${t}`);
  for (const t of PUBLISHING_TABLES) assert.ok(!tables.includes(t), `осталась таблица публикации ${t}`);
  assert.ok(tables.includes("schema_migrations"));
  const versions = appliedVersions(db);
  assert.equal(versions.at(-1), latestVersion());
  assert.ok(latestVersion() >= 1);
  db.close();
});

test("повторная миграция не падает и ничего не дублирует", () => {
  const db = openDb(":memory:");
  const before = appliedVersions(db);
  assert.doesNotThrow(() => migrate(db));
  assert.doesNotThrow(() => migrate(db));
  assert.deepEqual(appliedVersions(db), before);
  db.close();
});

test("повторное открытие файла базы не падает", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-db-"));
  try {
    const file = join(dir, "rf.sqlite");
    openDb(file).close();
    const again = openDb(file);
    assert.equal(appliedVersions(again).at(-1), latestVersion());
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("номера миграций идут подряд с 1, без дыр и повторов", () => {
  const list = loadMigrations();
  assert.deepEqual(
    list.map((m) => m.version),
    list.map((_, i) => i + 1),
  );
});

test("упавшая миграция откатывается целиком и версия не записывается", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-mig-"));
  try {
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeFileSync(
      join(dir, "002_bad.sql"),
      "CREATE TABLE b (id INTEGER PRIMARY KEY); INSERT INTO нет_такой_таблицы VALUES (1);",
    );
    const db = new DatabaseSync(":memory:");
    assert.throws(() => migrate(db, dir), /002_bad/);
    assert.deepEqual(appliedVersions(db), [1]);
    const b = db.prepare("SELECT name FROM sqlite_master WHERE name='b'").get();
    assert.equal(b, undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("002: база с публикацией (версия 001) переходит без потери сюжетов, сценок и вариантов", () => {
  const v1 = mkdtempSync(join(tmpdir(), "rf-mig-v1-"));
  try {
    copyFileSync(join(MIGRATIONS_DIR, "001_init.sql"), join(v1, "001_init.sql"));
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON"); // как в openDb: пересборка таблиц не должна каскадом снести данные
    migrate(db, v1);
    assert.deepEqual(appliedVersions(db), [1]);

    const T = "2026-11-10T12:00:00.000Z";
    db.exec(`
      INSERT INTO story (id, folder, title, status, meta_json, created_at, updated_at) VALUES
        (1, 'C:/in/кофе', 'Кофе', 'done', '{"autopilot":true,"theme":"кофе"}', '${T}', '${T}'),
        (2, 'C:/in/чай', 'Чай', 'rendering', NULL, '${T}', '${T}'),
        (3, 'C:/in/удалён', 'Удалён', 'new', NULL, '${T}', '${T}');
      DELETE FROM story WHERE id = 3;
      INSERT INTO clip (id, story_id, file, role, position, take, duration_ms, transcript_json, created_at) VALUES
        (10, 1, '01_хук_кофе.mp4', 'hook', 1, NULL, 2500, '{"words":[{"w":"кофе","t0":0,"t1":0.4}]}', '${T}'),
        (11, 1, '02a_сцена.mp4', 'body', 2, 'a', 4000, NULL, '${T}'),
        (12, 2, '01_хук_чай.mp4', 'hook', 1, NULL, 3000, NULL, '${T}');
      INSERT INTO variant (id, story_id, idx, edit_plan_json, file, preview_file, status, error, created_at, updated_at) VALUES
        (20, 1, 1, '{"order":[10,11]}', 'out/v01/video.mp4', 'out/v01/cover.jpg', 'approved', NULL, '${T}', '${T}'),
        (21, 1, 2, '{}', 'out/v02/video.mp4', NULL, 'rejected', NULL, '${T}', '${T}'),
        (22, 1, 3, '{}', 'out/v03/video.mp4', NULL, 'rendered', NULL, '${T}', '${T}'),
        (23, 1, 4, '{}', NULL, NULL, 'failed', 'ffmpeg: код 1', '${T}', '${T}'),
        (24, 2, 1, '{}', NULL, NULL, 'planned', NULL, '${T}', '${T}');
      INSERT INTO channel (id, kind, account, secret_ref, created_at) VALUES (1, 'instagram', 'acc', 'IG_TOKEN', '${T}');
      INSERT INTO post (id, variant_id, channel_id, status, created_at, updated_at) VALUES (1, 20, 1, 'published', '${T}', '${T}');
      INSERT INTO attempt (post_id, ok, created_at) VALUES (1, 1, '${T}');
      INSERT INTO metric (post_id, collected_at, views) VALUES (1, '${T}', 100);
    `);

    assert.deepEqual(migrate(db), [2]);
    assert.deepEqual(appliedVersions(db), [1, 2]);

    const tables = tableNames(db);
    for (const t of PUBLISHING_TABLES) assert.ok(!tables.includes(t), `осталась таблица ${t}`);
    for (const t of TABLES) assert.ok(tables.includes(t), `пропала таблица ${t}`);
    const leftovers = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%\\_new%' ESCAPE '\\'").all();
    assert.deepEqual(leftovers, [], "в схеме не должно остаться ссылок на временные таблицы *_new");

    const repo = createRepo(db, { now: () => new Date(T) });
    const coffee = repo.getStory(1);
    assert.equal(coffee?.status, "ready", "«done» (всё опубликовано) → «ready»");
    assert.deepEqual(coffee?.meta, { theme: "кофе" }, "флаг autopilot убран, остальное в meta цело");
    assert.equal(repo.getStory(2)?.status, "rendering");
    assert.equal(repo.getStory(2)?.meta, null);

    assert.deepEqual(
      repo.listClips(1).map((c) => [c.id, c.file, c.take, c.durationMs]),
      [
        [10, "01_хук_кофе.mp4", null, 2500],
        [11, "02a_сцена.mp4", "a", 4000],
      ],
    );
    assert.deepEqual(repo.listClips(1)[0]?.transcript, { words: [{ w: "кофе", t0: 0, t1: 0.4 }] });

    const variants = repo.listVariants(1);
    assert.deepEqual(
      variants.map((v) => [v.id, v.status]),
      [
        [20, "rendered"],
        [21, "rendered"],
        [22, "rendered"],
        [23, "failed"],
      ],
    );
    assert.equal(variants[0]?.file, "out/v01/video.mp4");
    assert.equal(variants[0]?.previewFile, "out/v01/cover.jpg");
    assert.deepEqual(variants[0]?.editPlan, { order: [10, 11] });
    assert.equal(variants[3]?.error, "ffmpeg: код 1");
    assert.equal(repo.listVariants(2)[0]?.status, "planned");

    // внешние ключи целы и смотрят на story, индекс сценок на месте
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const t of ["clip", "variant"]) {
      const fk = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
      assert.deepEqual(
        fk.map((r) => [r["table"], r["on_delete"]]),
        [["story", "CASCADE"]],
        t,
      );
    }
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='clip_story_idx'").get());

    // счётчик id не откатился: удалённый сюжет 3 не получит двойника
    assert.equal(repo.createStory({ folder: "C:/in/новый", title: "Новый" }).id, 4);

    // каскад работает по-прежнему
    repo.deleteStory(1);
    assert.equal(repo.listClips(1).length, 0);
    assert.equal(repo.listVariants(1).length, 0);
    assert.equal(repo.listClips(2).length, 1);
    assert.equal(repo.listVariants(2).length, 1);
    db.close();
  } finally {
    rmSync(v1, { recursive: true, force: true });
  }
});

test("дыра в нумерации миграций — понятная ошибка", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-mig-"));
  try {
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "003_c.sql"), "SELECT 1;");
    assert.throws(() => loadMigrations(dir), /003/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
