import { test } from "node:test";
import assert from "node:assert/strict";
import { groupScenes, parseClipName } from "./names.ts";

test("имя сценки: роль хук, финал и обычная сцена", () => {
  assert.deepEqual(parseClipName("C:/in/01_хук_привет.mp4"), { scene: 1, take: "", role: "hook", word: "привет" });
  assert.deepEqual(parseClipName("09_финал_пока.mp4"), { scene: 9, take: "", role: "final", word: "пока" });
  assert.deepEqual(parseClipName("02_кофе.mp4"), { scene: 2, take: "", role: "body", word: "кофе" });
  assert.deepEqual(parseClipName("D:\\in\\03_долгая_прогулка.MP4"), { scene: 3, take: "", role: "body", word: "долгая прогулка" });
});

test("имя сценки: дубли NNa/NNb", () => {
  assert.deepEqual(parseClipName("02a_кофе.mp4"), { scene: 2, take: "a", role: "body", word: "кофе" });
  assert.deepEqual(parseClipName("01B_hook_hi.mp4"), { scene: 1, take: "b", role: "hook", word: "hi" });
});

test("имя без номера не принимается", () => {
  assert.equal(parseClipName("кофе.mp4"), null);
  assert.equal(parseClipName("final_01.mp4"), null);
});

test("группировка: дубли в одной сцене, сцены по номерам, мусор отдельно", () => {
  const mk = (file: string) => ({ id: file, file, duration: 2 });
  const res = groupScenes([mk("03_c.mp4"), mk("01b_хук_x.mp4"), mk("01a_хук_x.mp4"), mk("02_b.mp4"), mk("notes.mp4")]);
  assert.deepEqual(res.scenes.map((s) => [s.number, s.role, s.takes.map((t) => t.take)]), [
    [1, "hook", ["a", "b"]],
    [2, "body", [""]],
    [3, "body", [""]],
  ]);
  assert.deepEqual(res.skipped, ["notes.mp4"]);
});
