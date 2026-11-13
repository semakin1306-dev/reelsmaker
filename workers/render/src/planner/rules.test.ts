import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStory } from "../testing/fixtures.ts";
import { openingKey, pickOrders, planVariants } from "./rules.ts";

const PRESETS = ["a", "b", "c", "d", "e", "f"];

test("планировщик даёт N схем (по умолчанию 10) с разными хуками в первых секундах", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS });
  assert.equal(plans.length, 10);
  assert.equal(new Set(plans.map((p) => p.hook.text)).size, 10, "тексты хуков не повторяются");
  assert.equal(new Set(plans.map(openingKey)).size, 10, "первые секунды не повторяются");
  assert.deepEqual(plans.map((p) => p.index), [...Array(10).keys()]);
  for (const p of plans) {
    assert.ok(p.hook.text.length >= 3 && p.hook.text.length <= 60);
    assert.ok(p.hook.duration >= 1.5 && p.hook.duration <= 3);
  }
});

test("хук первым, финал последним, переставляемые переставлены", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 6 });
  const bodyOrders = new Set<string>();
  for (const p of plans) {
    assert.equal(p.scenes[0]?.role, "hook");
    assert.equal(p.scenes[0]?.scene, 1);
    assert.equal(p.scenes[p.scenes.length - 1]?.role, "final");
    assert.equal(p.scenes[p.scenes.length - 1]?.scene, 5);
    const body = p.scenes.filter((s) => s.role === "body").map((s) => s.scene);
    assert.deepEqual([...body].sort(), [2, 3, 4], "в схеме все переставляемые сцены по одному разу");
    bodyOrders.add(body.join(","));
  }
  assert.equal(bodyOrders.size, 6, "3 переставляемые сцены дают 6 разных порядков на 6 вариантов");
  assert.deepEqual(plans[0]?.scenes.map((s) => s.scene), [1, 2, 3, 4, 5], "нулевой вариант — исходный порядок");
});

test("дубли хука чередуются между вариантами", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 6 });
  const takes = plans.map((p) => p.scenes[0]?.take);
  assert.deepEqual(takes, ["a", "b", "a", "b", "a", "b"]);
});

test("схема детерминирована: тот же сюжет — те же схемы", () => {
  const a = planVariants(fakeStory(), { presets: PRESETS });
  const b = planVariants(fakeStory(), { presets: PRESETS });
  assert.deepEqual(a.plans, b.plans);
});

test("пресеты назначаются по кругу, скорость в пределах ±5%, высота звука ±2%", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS });
  assert.ok(new Set(plans.slice(0, 6).map((p) => p.preset)).size === 6);
  for (const p of plans) {
    assert.ok(p.speed >= 0.95 && p.speed <= 1.05, `speed ${p.speed}`);
    assert.ok(p.pitch >= 0.98 && p.pitch <= 1.02, `pitch ${p.pitch}`);
    assert.ok(p.speed !== 1);
  }
});

test("хвост тишины обрезается только у переставляемых сцен, хук и финал целиком", () => {
  const story = fakeStory();
  // у сцены 2 длинный хвост после последнего слова, у хука и финала — тоже
  for (const c of story.clips) {
    c.duration = 8;
    if (c.transcript) for (const w of c.transcript.words) { w.start = Math.min(w.start, 1.5); w.end = Math.min(w.end, 1.8); }
  }
  const { plans } = planVariants(story, { presets: PRESETS, count: 2 });
  const p = plans[0]!;
  const hook = p.scenes[0]!;
  const fin = p.scenes[p.scenes.length - 1]!;
  assert.deepEqual(hook.trim, { start: 0, end: 8 });
  assert.deepEqual(fin.trim, { start: 0, end: 8 });
  const withWords = p.scenes.find((s) => s.scene === 2)!;
  assert.ok(withWords.trim.end < 3, `хвост обрезан: ${withWords.trim.end}`);
  for (const s of p.scenes) assert.ok(s.trim.end > s.trim.start && s.trim.end <= s.duration);
});

test("хук-текст «естественный» берётся из расшифровки хук-сцены, при заданной теме — шаблоны с темой", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS });
  assert.equal(plans[0]?.hook.text, "Привет друзья сегодня покажу кое-что");
  assert.ok(plans.some((p) => p.hook.text.includes("утро выходного дня")));
});

test("перестановок меньше вариантов: порядок+дубль не повторяются подряд, есть предупреждение при нехватке хуков", () => {
  const orders = pickOrders(["x", "y"], 5, 7);
  assert.equal(orders.length, 5);
  assert.deepEqual(orders[0], ["x", "y"]);
  assert.deepEqual(orders[1], ["y", "x"]);
  const story = fakeStory();
  const { warnings } = planVariants(story, { presets: PRESETS, count: 40 });
  assert.ok(warnings.some((w) => w.includes("хуков в пуле")));
});

test("сюжет без хука и финала: первая сцена остаётся первой, предупреждение", () => {
  const story = fakeStory();
  story.clips = story.clips.filter((c) => !c.file.includes("хук") && !c.file.includes("финал"));
  const { plans, warnings } = planVariants(story, { presets: PRESETS, count: 3 });
  assert.ok(warnings.some((w) => w.includes("нет сцены «хук»")));
  assert.ok(plans.every((p) => p.scenes[0]?.scene === 2));
});

test("пустой сюжет и пустые пресеты — понятная ошибка", () => {
  assert.throws(() => planVariants({ id: "s", clips: [] }, { presets: PRESETS }), /нет ни одной сцены/);
  assert.throws(() => planVariants(fakeStory(), { presets: [] }), /не заданы пресеты/);
  assert.throws(() => planVariants(fakeStory(), { presets: PRESETS, count: 0 }), /count/);
});
