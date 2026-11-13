import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { createRepo } from "./repo.ts";
import { STORY_STATUSES, VARIANT_STATUSES } from "./model.ts";

const NOW = "2026-11-10T12:00:00.000Z";

function fixture() {
  const db = openDb(":memory:");
  const repo = createRepo(db, { now: () => new Date(NOW) });
  const story = repo.createStory({ folder: "C:/in/сюжет-1", title: "Сюжет 1" });
  const variant = repo.createVariant({ storyId: story.id, idx: 1, editPlan: { scenes: [1, 2, 3] } });
  return { db, repo, story, variant };
}

test("сюжет: создание, чтение, смена статуса, уникальность папки", () => {
  const { repo, story } = fixture();
  assert.equal(story.status, "new");
  assert.equal(story.createdAt, NOW);
  assert.equal(repo.getStoryByFolder("C:/in/сюжет-1")?.id, story.id);
  repo.setStoryStatus(story.id, "uploaded");
  assert.equal(repo.getStory(story.id)?.status, "uploaded");
  assert.deepEqual(repo.listStories("uploaded").map((s) => s.id), [story.id]);
  assert.throws(() => repo.createStory({ folder: "C:/in/сюжет-1", title: "дубль" }), /UNIQUE/);
});

test("статусы из model.ts совпадают с CHECK базы; статусов публикации база не принимает", () => {
  const { db, repo, story, variant } = fixture();
  for (const s of STORY_STATUSES) assert.doesNotThrow(() => repo.setStoryStatus(story.id, s), s);
  for (const s of VARIANT_STATUSES) assert.doesNotThrow(() => repo.setVariantStatus(variant.id, s), s);
  for (const s of ["done", "непонятно"]) {
    assert.throws(() => db.prepare("UPDATE story SET status = ? WHERE id = ?").run(s, story.id), /CHECK/, s);
  }
  for (const s of ["approved", "rejected", "ready"]) {
    assert.throws(() => db.prepare("UPDATE variant SET status = ? WHERE id = ?").run(s, variant.id), /CHECK/, s);
  }
});

test("сценки: порядок, роль, расшифровка JSON возвращается объектом", () => {
  const { repo, story } = fixture();
  repo.addClip({
    storyId: story.id,
    file: "02_сцена.mp4",
    role: "body",
    position: 2,
    durationMs: 4200,
    transcript: { words: [{ w: "привет", t0: 0, t1: 0.4 }] },
  });
  const hook = repo.addClip({ storyId: story.id, file: "01_хук.mp4", role: "hook", position: 1, durationMs: 3000 });
  const clips = repo.listClips(story.id);
  assert.deepEqual(
    clips.map((c) => c.file),
    ["01_хук.mp4", "02_сцена.mp4"],
  );
  assert.deepEqual(clips[1]?.transcript, { words: [{ w: "привет", t0: 0, t1: 0.4 }] });
  assert.equal(clips[0]?.transcript, null);
  repo.setClipTranscript(hook.id, { words: [] });
  assert.deepEqual(repo.listClips(story.id)[0]?.transcript, { words: [] });
});

test("варианты: схема монтажа JSON, уникальный номер в сюжете, статус", () => {
  const { repo, story, variant } = fixture();
  assert.deepEqual(variant.editPlan, { scenes: [1, 2, 3] });
  assert.equal(variant.status, "planned");
  assert.throws(() => repo.createVariant({ storyId: story.id, idx: 1, editPlan: {} }), /UNIQUE/);
  repo.setVariantStatus(variant.id, "failed", "ffmpeg: код 1");
  assert.equal(repo.getVariant(variant.id)?.error, "ffmpeg: код 1");
  repo.setVariantRendered(variant.id, { file: "out/v1.mp4", previewFile: "out/v1.jpg" });
  const v = repo.getVariant(variant.id);
  assert.equal(v?.status, "rendered");
  assert.equal(v?.file, "out/v1.mp4");
  assert.equal(v?.error, null);
  assert.equal(repo.listVariants(story.id).length, 1);
});

test("удаление сюжета каскадом убирает сценки и варианты, другие сюжеты не трогает", () => {
  const { db, repo, story } = fixture();
  repo.addClip({ storyId: story.id, file: "01.mp4", role: "hook", position: 1, durationMs: 1000 });
  const other = repo.createStory({ folder: "C:/in/сюжет-2", title: "Сюжет 2" });
  repo.addClip({ storyId: other.id, file: "01.mp4", role: "hook", position: 1, durationMs: 1000 });
  repo.deleteStory(story.id);
  for (const t of ["clip", "variant"]) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE story_id = ?`).get(story.id);
    assert.equal(n?.["n"], 0, t);
  }
  assert.equal(repo.listClips(other.id).length, 1);
});

test("в репозитории нет методов публикации", () => {
  const { repo } = fixture();
  const names = Object.keys(repo);
  for (const n of names) assert.doesNotMatch(n, /channel|post|attempt|metric|publish|approve|reject/i, n);
});
