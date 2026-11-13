import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStory } from "../testing/fixtures.ts";
import type { TextLlm } from "../types.ts";
import { applyLlmAnswer, buildLlmPrompt, enhancePlansWithLlm, parseJsonLoose } from "./llm.ts";
import { planStory } from "./index.ts";
import { planVariants } from "./rules.ts";

const PRESETS = ["a", "b", "c"];

function fakeLlm(answer: string | Error, calls: { system: string; prompt: string }[] = []): TextLlm {
  return {
    async complete(req) {
      calls.push({ system: req.system, prompt: req.prompt });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("JSON достаётся и из обёртки ```json, и из текста вокруг", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Вот ответ: {"a":[1,2]} спасибо'), { a: [1, 2] });
  assert.throws(() => parseJsonLoose("нет json"), /нет JSON/);
});

test("промпт содержит расшифровку сцен и черновые схемы, без путей файлов", () => {
  const story = fakeStory();
  const { plans } = planVariants(story, { presets: PRESETS, count: 3 });
  const prompt = buildLlmPrompt(story, plans);
  assert.match(prompt, /Привет друзья сегодня/);
  assert.match(prompt, /вариант 2/);
  assert.ok(!prompt.includes("/fx/"));
});

test("корректный ответ применяется: хук, порядок переставляемых, подписи", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 3 });
  const answer = { variants: [{ index: 0, hook: "Кофе или прогулка?", order: [4, 3, 2], blocks: { "2": "Кофе", "3": "Работа", "4": "Улица" } }] };
  const res = applyLlmAnswer(plans, answer);
  const p = res.plans[0]!;
  assert.equal(p.hook.text, "Кофе или прогулка?");
  assert.deepEqual(p.scenes.map((s) => s.scene), [1, 4, 3, 2, 5], "хук и финал на местах");
  assert.deepEqual(p.blocks.map((b) => b.text).sort(), ["Кофе", "Работа", "Улица"]);
  for (const b of p.blocks) assert.equal(p.scenes[b.sceneIndex]?.role, "body");
  assert.equal(res.report.applied, 1);
  assert.equal(res.report.rejected, 0);
  assert.deepEqual(res.plans[1], plans[1], "остальные варианты не тронуты");
});

test("порядок не перестановка, хук-дубль, слишком длинный хук — отвергаются, остаётся от правил", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 3 });
  const answer = {
    variants: [
      { index: 0, order: [2, 3] },
      { index: 1, hook: plans[2]!.hook.text },
      { index: 2, hook: "х".repeat(80) },
    ],
  };
  const res = applyLlmAnswer(plans, answer);
  assert.deepEqual(res.plans, plans);
  assert.equal(res.report.rejected, 3);
  assert.equal(res.report.applied, 0);
});

test("порядок, затрагивающий хук или финал, отвергается", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 2 });
  const res = applyLlmAnswer(plans, { variants: [{ index: 0, order: [1, 2, 3, 4, 5] }] });
  assert.deepEqual(res.plans[0]?.scenes.map((s) => s.scene), plans[0]?.scenes.map((s) => s.scene));
  assert.equal(res.report.rejected, 1);
});

test("перестановка убирает нумерованные подписи, подписи словом едут со сценой", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 12 });
  const stepIdx = plans.findIndex((p) => p.blocks.some((b) => /^Шаг \d$/.test(b.text)));
  const wordIdx = plans.findIndex((p) => p.blocks.some((b) => b.text === "Кофе"));
  assert.ok(stepIdx >= 0 && wordIdx >= 0);
  const res = applyLlmAnswer(plans, {
    variants: [
      { index: stepIdx, order: [4, 3, 2] },
      { index: wordIdx, order: [4, 3, 2] },
    ],
  });
  assert.equal(res.plans[stepIdx]?.blocks.length, 0);
  const moved = res.plans[wordIdx]!;
  const coffee = moved.blocks.find((b) => b.text === "Кофе")!;
  assert.equal(moved.scenes[coffee.sceneIndex]?.scene, 2);
});

test("ответ без массива variants — все схемы на правилах, ошибка в отчёте", () => {
  const { plans } = planVariants(fakeStory(), { presets: PRESETS, count: 2 });
  const res = applyLlmAnswer(plans, { foo: 1 });
  assert.deepEqual(res.plans, plans);
  assert.match(res.report.error ?? "", /variants/);
});

test("сбой клиента не роняет планировщик: схемы правил возвращаются как есть", async () => {
  const story = fakeStory();
  const { plans } = planVariants(story, { presets: PRESETS, count: 3 });
  const res = await enhancePlansWithLlm(story, plans, fakeLlm(new Error("сеть")));
  assert.deepEqual(res.plans, plans);
  assert.equal(res.report.error, "сеть");
});

test("planStory: без флага модель не вызывается, с флагом и без клиента — правила и предупреждение", async () => {
  const story = fakeStory();
  const calls: { system: string; prompt: string }[] = [];
  const llm = fakeLlm('{"variants":[]}', calls);
  const off = await planStory(story, { presets: PRESETS, count: 3, llm, useLlm: false });
  assert.equal(calls.length, 0);
  assert.equal(off.plans.length, 3);
  const noClient = await planStory(story, { presets: PRESETS, count: 3, useLlm: true });
  assert.ok(noClient.warnings.some((w) => w.includes("клиент Claude не задан")));
  assert.deepEqual(noClient.plans, off.plans);
});

test("planStory с клиентом: хук от модели попадает в схему", async () => {
  const story = fakeStory();
  const calls: { system: string; prompt: string }[] = [];
  const llm = fakeLlm('```json\n{"variants":[{"index":1,"hook":"Утро, которое не забыть"}]}\n```', calls);
  const res = await planStory(story, { presets: PRESETS, count: 3, llm, useLlm: true });
  assert.equal(calls.length, 1);
  assert.equal(res.plans[1]?.hook.text, "Утро, которое не забыть");
  assert.equal(res.llm?.applied, 1);
});
