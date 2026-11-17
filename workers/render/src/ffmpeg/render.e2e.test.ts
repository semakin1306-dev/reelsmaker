// Прогон на настоящем ffmpeg: 2–3 сгенерированные сценки (testsrc2 + sine), два варианта разных пресетов.
// Нет ffmpeg в PATH (или RF_FFMPEG_PATH) — тест пропускается.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { editToPlans, splitReplicas } from "../montage.ts";
import { planVariants } from "../planner/rules.ts";
import { loadPresets } from "../presets.ts";
import { ensureFixtureStory } from "../testing/fixtures.ts";
import { renderVariant, RenderError } from "./render.ts";
import { defaultRun } from "./runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const presetsDir = join(here, "..", "..", "presets");
const fixturesDir = join(here, "..", "..", "fixtures", ".generated");
const ffmpegPath = process.env["RF_FFMPEG_PATH"] || "ffmpeg";
const ffprobePath = process.env["RF_FFPROBE_PATH"] || "ffprobe";
const hasFfmpeg = spawnSync(ffmpegPath, ["-version"]).status === 0 && spawnSync(ffprobePath, ["-version"]).status === 0;

async function probe(file: string, entries: string): Promise<string[]> {
  const res = await defaultRun(ffprobePath, ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", file]);
  return res.stdout.trim().split(/\r?\n/);
}

test("рендер двух вариантов на настоящем ffmpeg: 1080x1920, звук, длительность, превью, журнал", { skip: !hasFfmpeg && "нет ffmpeg", timeout: 240_000 }, async () => {
  const presets = loadPresets(presetsDir);
  const story = await ensureFixtureStory(fixturesDir, ffmpegPath);
  const clips = new Map(story.clips.map((c) => [c.id, c]));
  const { plans } = planVariants(story, { presets: presets.map((p) => p.id), count: 2 });
  const root = await mkdtemp(join(tmpdir(), "rf-render-"));
  try {
    const deps = { run: defaultRun, ffmpegPath, ffprobePath, presetsDir };
    const outputs = new Set<string>();
    for (const plan of plans) {
      const preset = presets.find((p) => p.id === plan.preset)!;
      const outDir = join(root, `v${plan.index}`);
      const res = await renderVariant(deps, { plan, preset, clips, outDir });
      assert.ok(res.duration !== null && Math.abs(res.duration - res.expectedDuration) < 0.5, `длительность ${res.duration} против ${res.expectedDuration}`);
      const streams = await probe(res.video, "stream=codec_type,codec_name,width,height");
      assert.ok(streams.some((s) => s === "h264,video,1080,1920" || s === "video,h264,1080,1920" || s.includes("1080,1920")), `видеопоток: ${streams.join(" | ")}`);
      assert.ok(streams.some((s) => s.includes("audio")), "есть звуковая дорожка");
      const sheet = await probe(res.sheet, "stream=width,height");
      assert.deepEqual(sheet, ["1080,1280"], "контактный лист 3×2 из плиток 360×640");
      assert.ok(existsSync(res.cover) && existsSync(res.log));
      assert.match(readFileSync(res.log, "utf8"), /filter_complex/);
      assert.ok(!existsSync(join(outDir, "work")), "рабочий каталог убран после успеха");
      assert.ok(existsSync(join(outDir, "plan.json")));
      outputs.add(readFileSync(res.cover).toString("base64"));
    }
    assert.equal(outputs.size, 2, "обложки вариантов различаются");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("рендер: битый вход даёт RenderError с путём к журналу", { skip: !hasFfmpeg && "нет ffmpeg", timeout: 60_000 }, async () => {
  const presets = loadPresets(presetsDir);
  const story = await ensureFixtureStory(fixturesDir, ffmpegPath);
  const clips = new Map(story.clips.map((c) => [c.id, c]));
  const plan = planVariants(story, { presets: ["default"], count: 1 }).plans[0]!;
  plan.scenes[1]!.file = join(fixturesDir, "нет-такого-файла.mp4");
  const root = await mkdtemp(join(tmpdir(), "rf-render-bad-"));
  try {
    await assert.rejects(
      renderVariant({ run: defaultRun, ffmpegPath, ffprobePath, presetsDir }, { plan, preset: presets.find((p) => p.id === "default")!, clips, outDir: join(root, "v") }),
      (e: unknown) => e instanceof RenderError && /код/.test(e.message) && existsSync(e.log),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("рендер с озвучкой: основа без звука + отдельный wav → звук из файла, видеоряд по листу", { skip: !hasFfmpeg && "нет ffmpeg", timeout: 240_000 }, async () => {
  const presets = loadPresets(presetsDir);
  const root = await mkdtemp(join(tmpdir(), "rf-render-voice-"));
  try {
    const gen = async (args: string[]) => {
      const r = await defaultRun(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
      assert.equal(r.code, 0, r.stderr);
    };
    const talk = join(root, "челси.mp4");
    const wide = join(root, "дальний.mp4");
    const voice = join(root, "озвучка.wav");
    // основа и дальний — без звука; озвучка — только звук, 7 секунд
    await gen(["-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=12", "-an", "-pix_fmt", "yuv420p", talk]);
    await gen(["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-an", "-pix_fmt", "yuv420p", wide]);
    await gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-ac", "1", "-ar", "48000", voice]);
    const transcript = {
      text: "",
      words: [
        { text: "Новый", start: 0.3, end: 0.7 }, { text: "голос.", start: 0.7, end: 1.2 },
        { text: "Второй", start: 2.6, end: 3.0 }, { text: "кусок.", start: 3.0, end: 3.6 },
        { text: "Финал.", start: 5.2, end: 5.9 },
      ],
    };
    const voiceReplicas = splitReplicas(transcript, 7, { prefix: "a" });
    assert.equal(voiceReplicas.length, 3);
    const res = editToPlans(
      { version: 1, variants: [{ id: "a", segments: [{ voice: "a01", at: 4 }, { voice: "a02", view: "wide", wideAt: 2 }, { voice: "a03", at: 8 }] }] },
      {
        storyId: "челси",
        talk: { name: "челси.mp4", file: talk, duration: 12, transcript: null },
        wide: { name: "дальний.mp4", file: wide, duration: 12 },
        voices: [{ name: "озвучка.wav", file: voice, duration: 7, transcript }],
        voiceReplicas: voiceReplicas.map((r) => ({ ...r, source: "озвучка.wav" })),
        replicas: [],
        presets: presets.map((x) => x.id),
      },
    );
    assert.deepEqual(res.errors, []);
    const plan = res.plans[0]!;
    const out = await renderVariant(
      { run: defaultRun, ffmpegPath, ffprobePath, presetsDir },
      { plan, preset: presets.find((x) => x.id === plan.preset)!, clips: res.clips, outDir: join(root, "v") },
    );
    const total = plan.scenes.reduce((sum, sc) => sum + sc.trim.end - sc.trim.start, 0);
    assert.ok(out.duration !== null && Math.abs(out.duration - total) < 0.5, `длительность ${out.duration} против ${total}`);
    const streams = await probe(out.video, "stream=codec_type,width,height");
    assert.ok(streams.some((x) => x.includes("1080,1920")), `видеопоток: ${streams.join(" | ")}`);
    assert.ok(streams.some((x) => x.includes("audio")), "звук из озвучки есть, хотя у видео его нет");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
