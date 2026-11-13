import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoverArgs, buildSheetArgs, coverTime, makePreviews } from "./preview.ts";
import type { RunFn } from "./runner.ts";

test("обложка: кадр около первой секунды, но не позже трети короткого ролика", () => {
  assert.equal(coverTime(20), 1);
  assert.equal(coverTime(1.8), 0.6);
  assert.deepEqual(buildCoverArgs("v.mp4", "c.jpg", 20).slice(3, 7), ["-ss", "1", "-i", "v.mp4"]);
});

test("контактный лист 3×2: fps подобран так, чтобы 6 кадров легли на всю длительность", () => {
  const args = buildSheetArgs("v.mp4", "s.jpg", 12);
  const vf = args[args.indexOf("-vf") + 1]!;
  assert.equal(vf, "fps=0.5,scale=360:-2,tile=3x2");
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.length - 1], "s.jpg");
});

test("превью: два запуска ffmpeg, ошибка — с пояснением", async () => {
  const calls: string[][] = [];
  const ok: RunFn = async (_cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  await makePreviews(ok, "ffmpeg", "v.mp4", { cover: "c.jpg", sheet: "s.jpg" }, 10);
  assert.equal(calls.length, 2);
  const bad: RunFn = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
  await assert.rejects(makePreviews(bad, "ffmpeg", "v.mp4", { cover: "c.jpg", sheet: "s.jpg" }, 10), /обложка не собрана/);
});
