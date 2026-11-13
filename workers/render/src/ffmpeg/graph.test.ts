import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planVariants } from "../planner/rules.ts";
import { loadPresets, validatePreset, type Preset } from "../presets.ts";
import { fakeStory } from "../testing/fixtures.ts";
import type { VariantPlan } from "../types.ts";
import { buildFfmpegJob } from "./graph.ts";

const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "presets");
const presets = loadPresets(presetsDir);
/** Пресет с полным цветокором — проверить, что движок его умеет (в репо сейчас один чистый пресет). */
const GRADED = validatePreset({
  id: "graded",
  grade: { eq: { contrast: 1.1, gamma: 0.97 }, curves: "strong_contrast", lut: "warm.cube", vignette: true, grain: 6, sharpen: true },
  hook: { font: "Montserrat", fontFile: "Montserrat-Bold.ttf", size: 80 },
  caption: { font: "Montserrat", fontFile: "Montserrat-Bold.ttf", size: 70 },
  block: { font: "Montserrat", fontFile: "Montserrat-Bold.ttf", size: 50 },
});
const byId = (id: string): Preset => (id === "graded" ? GRADED : presets.find((p) => p.id === id)!);

function build(planIndex = 0, presetId?: string, opts?: Parameters<typeof buildFfmpegJob>[0]["opts"], fonts?: { caption?: string }) {
  const story = fakeStory();
  const plan: VariantPlan = planVariants(story, { presets: presets.map((p) => p.id), count: 10 }).plans[planIndex]!;
  if (presetId) plan.preset = presetId;
  const clips = new Map(story.clips.map((c) => [c.id, c]));
  let preset = byId(plan.preset);
  if (fonts?.caption) preset = { ...preset, caption: { ...preset.caption, fontFile: fonts.caption } };
  return { plan, job: buildFfmpegJob({ plan, preset, clips, outFile: "/out/video.mp4", presetsDir, opts }) };
}

test("граф: на сцену — нарезка, кадр 1080x1920, кроп с зумом; склейка всех сцен", () => {
  const { plan, job } = build();
  const g = job.filterGraph;
  assert.equal(plan.scenes.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.match(g, new RegExp(`\\[${i}:v\\]trim=start=0:end=[\\d.]+,setpts=PTS-STARTPTS,fps=30,scale=\\d+:\\d+:force_original_aspect_ratio=increase,crop=1080:1920:x='`));
    assert.match(g, new RegExp(`\\[v${i}\\]`));
  }
  assert.match(g, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]\[v3\]\[a3\]\[v4\]\[a4\]concat=n=5:v=1:a=1\[vcat\]\[acat\]/);
  // зум: размер до кропа больше кадра на factor
  const f = plan.scenes[0]!.zoom.factor;
  assert.ok(g.includes(`scale=${Math.ceil((1080 * f) / 2) * 2}:${Math.ceil((1920 * f) / 2) * 2}:`));
});

test("граф: скорость ±3–5% — setpts и atempo с одним коэффициентом, высота звука правится asetrate", () => {
  const { plan, job } = build();
  const g = job.filterGraph;
  assert.ok(g.includes(`setpts=PTS/${plan.speed}`));
  assert.ok(plan.pitch !== 1);
  assert.match(g, /asetrate=\d+(\.\d+)?,aresample=48000,atempo=[\d.]+\[aout\]/);
  const m = /asetrate=([\d.]+),aresample=48000,atempo=([\d.]+)/.exec(g)!;
  const tempo = (Number(m[1]) / 48000) * Number(m[2]);
  assert.ok(Math.abs(tempo - plan.speed) < 1e-3, `итоговый темп ${tempo} против ${plan.speed}`);
  // без сдвига высоты — только atempo
  const flat = build(0);
  flat.plan.pitch = 1;
  const j2 = buildFfmpegJob({ plan: flat.plan, preset: byId(flat.plan.preset), clips: new Map(fakeStory().clips.map((c) => [c.id, c])), outFile: "o.mp4", presetsDir });
  assert.match(j2.filterGraph, new RegExp(`\\[acat\\]atempo=${flat.plan.speed}\\[aout\\]`));
  assert.ok(!j2.filterGraph.includes("asetrate"));
});

test("граф: сцена без звука получает тишину нужной длины", () => {
  const { plan, job } = build();
  const silent = plan.scenes.findIndex((s) => !s.hasAudio);
  assert.ok(silent >= 0);
  assert.match(job.filterGraph, new RegExp(`anullsrc=r=48000:cl=stereo,atrim=duration=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.015,afade=t=out:st=2.985:d=0.015\\[a${silent}\\]`));
  assert.ok(!job.filterGraph.includes(`[${silent}:a]`));
});

test("граф: чистый пресет — никакого цветокора, сразу субтитры; одинаково у всех вариантов", () => {
  const graphs = [0, 1, 2].map((i) => build(i, "default").job.filterGraph);
  for (const g of graphs) {
    assert.match(g, /\[vcat\]setpts=PTS\/[\d.]+,fps=30,ass=filename=captions\.ass:fontsdir=fonts,format=yuv420p\[vout\]/);
    assert.ok(!/eq=|lut3d|curves=|vignette|noise=|unsharp/.test(g), "без фильтров цвета");
  }
});

test("граф: цветокор пресета (если владелец включит) — eq без «дрожания», curves, LUT, виньетка, зерно, резкость; ASS последним", () => {
  const g = build(0, "graded").job.filterGraph;
  assert.match(g, /eq=contrast=1\.1:gamma=0\.97,/, "ровно значения пресета — одинаково у всех вариантов");
  assert.equal(build(1, "graded").job.filterGraph.match(/eq=[^,]+/)![0], g.match(/eq=[^,]+/)![0]);
  assert.match(g, /curves=preset=strong_contrast/);
  assert.match(g, /lut3d=file=warm\.cube/);
  assert.match(g, /vignette/);
  assert.match(g, /noise=alls=6:allf=t/);
  assert.match(g, /unsharp=/);
  assert.match(g, /ass=filename=captions\.ass:fontsdir=fonts,format=yuv420p\[vout\]/);
  assert.ok(g.indexOf("eq=") < g.indexOf("lut3d") && g.indexOf("lut3d") < g.indexOf("ass="), "порядок: eq → LUT → субтитры");
});

test("в рабочий каталог кладутся ASS, шрифты и LUT пресета; пути в графе относительные", () => {
  const { job } = build(0, "graded");
  const names = job.staged.map((s) => s.name).sort();
  assert.ok(names.includes("captions.ass"));
  assert.ok(names.includes("warm.cube"));
  assert.ok(names.includes("fonts/Montserrat-Bold.ttf"));
  assert.deepEqual(build(0, "default").job.staged.map((x) => x.name).sort(), ["captions.ass", "fonts/HomeVideo-Bold.otf", "fonts/Montserrat-Bold.ttf"]);
  // свой шрифт — по полному пути из папки данных
  const own = build(0, "default", undefined, { caption: "C:/data/fonts/My Font.otf" }).job.staged.find((x) => x.name === "fonts/My Font.otf")!;
  assert.equal(own.copyFrom, "C:/data/fonts/My Font.otf");
  const ass = job.staged.find((s) => s.name === "captions.ass")!;
  assert.ok(ass.content?.includes("[Events]"));
  const lut = job.staged.find((s) => s.name === "warm.cube")!;
  assert.ok(lut.copyFrom?.endsWith(join("luts", "warm.cube")));
  assert.ok(!/[A-Za-z]:[\\/]/.test(job.filterGraph), "в графе нет абсолютных путей (двоеточие диска ломает фильтры)");
});

test("кодек: libx264 veryfast на сервере, h264_nvenc на ПК; 2 потока по умолчанию", () => {
  const cpu = build().job.args;
  assert.deepEqual(cpu.slice(cpu.indexOf("-c:v"), cpu.indexOf("-c:v") + 4), ["-c:v", "libx264", "-preset", "veryfast"]);
  assert.equal(cpu[cpu.indexOf("-threads") + 1], "2");
  assert.equal(cpu[cpu.indexOf("-filter_complex_threads") + 1], "2");
  const gpu = build(0, undefined, { hw: "nvenc", threads: 4 }).job.args;
  assert.equal(gpu[gpu.indexOf("-c:v") + 1], "h264_nvenc");
  assert.ok(!gpu.includes("libx264"));
  assert.equal(gpu[gpu.indexOf("-filter_complex_threads") + 1], "4");
});

test("аргументы: входы по порядку сцен, отображение vout/aout, выход последним, метаданные сброшены", () => {
  const { plan, job } = build();
  const inputs = job.args.flatMap((a, i) => (a === "-i" ? [job.args[i + 1]] : []));
  assert.deepEqual(inputs, plan.scenes.map((s) => s.file));
  assert.deepEqual(job.args.slice(job.args.indexOf("-map"), job.args.indexOf("-map") + 4), ["-map", "[vout]", "-map", "[aout]"]);
  assert.equal(job.args[job.args.length - 1], "/out/video.mp4");
  assert.ok(job.args.includes("-map_metadata"));
  assert.ok(job.args.includes("+faststart"));
  assert.ok(job.args.every((a) => typeof a === "string"));
});

test("ожидаемая длительность = сумма отрезков / скорость", () => {
  const { plan, job } = build();
  const sum = plan.scenes.reduce((s, x) => s + x.trim.end - x.trim.start, 0);
  assert.ok(Math.abs(job.expectedDuration - sum / plan.speed) < 1e-9);
});

test("схема без сцен и скорость вне диапазона atempo — ошибка", () => {
  const { plan } = build();
  const clips = new Map(fakeStory().clips.map((c) => [c.id, c]));
  assert.throws(() => buildFfmpegJob({ plan: { ...plan, scenes: [] }, preset: byId(plan.preset), clips, outFile: "o", presetsDir }), /без сцен/);
  assert.throws(() => buildFfmpegJob({ plan: { ...plan, speed: 3 }, preset: byId(plan.preset), clips, outFile: "o", presetsDir }), /atempo/);
});
