import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCrop, fitSafe, editToPlans, splitReplicas, DEFAULT_SCREEN_BOX, type EditList, type MontageInput } from "./montage.ts";
import { buildFfmpegJob } from "./ffmpeg/graph.ts";
import { loadPresets, PRESETS_DIR } from "./presets.ts";
import type { Transcript } from "./types.ts";

const w = (text: string, start: number, end: number) => ({ text, start, end });
const TR: Transcript = {
  text: "",
  words: [
    w("Привет.", 0.5, 0.9), w("Сегодня", 1.1, 1.5), w("про", 1.5, 1.7), w("кофе.", 1.7, 2.1),
    w("Зёрна", 3.2, 3.6), w("свежие", 3.6, 4.0),
    w("помол", 5.0, 5.4), w("средний.", 5.4, 5.9),
    w("Подпишись!", 7.0, 7.6),
  ],
};

test("реплики: по концу предложения и паузам, с запасом, без наезда на соседей", () => {
  const reps = splitReplicas(TR, 9);
  assert.deepEqual(reps.map((r) => r.text), ["Привет.", "Сегодня про кофе.", "Зёрна свежие", "помол средний.", "Подпишись!"]);
  assert.deepEqual(reps.map((r) => r.id), ["r01", "r02", "r03", "r04", "r05"]);
  assert.equal(reps[0]!.start, 0.38);
  for (let i = 1; i < reps.length; i++) assert.ok(reps[i]!.start >= reps[i - 1]!.end, `${i}: пересечение`);
  assert.ok(reps.at(-1)!.end <= 9);
});

const presets = loadPresets(PRESETS_DIR);
const input = (over: Partial<MontageInput> = {}): MontageInput => ({
  storyId: "кофе",
  talk: { name: "голова.mp4", file: "C:/s/голова.mp4", duration: 9, transcript: TR },
  wide: { name: "общий.mp4", file: "C:/s/общий.mp4", duration: 20 },
  screen: { name: "экран.mp4", file: "C:/s/экран.mp4", duration: 60 },
  replicas: splitReplicas(TR, 9),
  presets: presets.map((p) => p.id),
  ...over,
});

test("лист → схемы: звук и субтитры с основы, перебивка дальним, вставка экрана в рамку", () => {
  const edit: EditList = {
    version: 1,
    layout: { wideScreenBox: { x: 60, y: 300, w: 950, h: 600 } },
    variants: [
      {
        id: "a",
        hook: "Ты варишь кофе неправильно",
        segments: [{ replica: "r02" }, { replica: "r03", view: "wide", screen: 12 }, { replica: "r04", screen: true }, { replica: "r05", view: "wide", wideAt: 18 }],
        blocks: [{ segment: 1, text: "Шаг 1" }],
      },
      { id: "b", segments: [{ replica: "r03" }, { start: 1.0, end: 2.2, cutStart: 0 }, { replica: "r05" }] },
    ],
  };
  const res = editToPlans(edit, input());
  assert.deepEqual(res.errors, []);
  const [a, b] = res.plans;
  assert.equal(a!.scenes.length, 4);
  for (const s of a!.scenes) assert.equal(s.file, "C:/s/голова.mp4", "звук всегда с основы");
  assert.equal(a!.scenes[0]!.picture, undefined);
  assert.deepEqual(a!.scenes[1]!.picture, { file: "C:/s/общий.мп4".replace("мп4", "mp4"), start: a!.scenes[1]!.trim.start });
  assert.deepEqual(a!.scenes[1]!.inset, { file: "C:/s/экран.mp4", start: 12, box: { x: 60, y: 300, w: 950, h: 600 } });
  assert.equal(a!.scenes[2]!.inset!.start, a!.scenes[2]!.trim.start, "screen: true — та же секунда, что звук");
  assert.deepEqual(a!.scenes[2]!.inset!.box, { x: 60, y: 300, w: 950, h: 600 }, "рамки крупного нет — берётся рамка дальнего");
  assert.ok(a!.scenes[3]!.picture!.start <= 20 - (a!.scenes[3]!.trim.end - a!.scenes[3]!.trim.start));
  assert.equal(a!.hook.text, "Ты варишь кофе неправильно");
  assert.deepEqual(a!.blocks.map((x) => [x.text, x.sceneIndex]), [["Шаг 1", 1]]);
  assert.equal(b!.hook.text, "Зёрна свежие", "хук без явного текста — из первой реплики");
  assert.deepEqual([a!.preset, b!.preset], ["default", "default"], "оформление одно на все варианты");
  assert.deepEqual([a!.speed, a!.pitch, b!.speed, b!.pitch], [1, 1, 1, 1], "темп и голос как сняты");
  assert.ok(a!.scenes.every((x) => x.zoom.factor === 1 && x.zoom.drift === 0), "без зума — кадр как выбран кропом");
  assert.equal(b!.scenes[1]!.trim.start, 1);
  assert.ok(res.clips.get("голова.mp4")?.transcript, "основа с расшифровкой — для субтитров");
});

test("лист: понятные ошибки по варианту и сегменту", () => {
  const edit: EditList = {
    version: 1,
    variants: [
      { id: "x", segments: [{ replica: "r99" }, { replica: "r01", view: "wide" }, { replica: "r02", screen: 500 }, {}] },
      { id: "x", segments: [{ replica: "r01" }], blocks: [{ segment: 5, text: "?" }] },
    ],
  };
  const res = editToPlans(edit, input({ wide: null }));
  const all = res.errors.join("\n");
  assert.match(all, /вариант x, сегмент 0: нет реплики r99/);
  assert.match(all, /сегмент 1: перебивка дальним планом, а дальнего плана в сюжете нет/);
  assert.match(all, /сегмент 2: screen 500 вне скринкаста/);
  assert.match(all, /сегмент 3: нужна replica или start\/end/);
  assert.match(all, /id повторяется/);
  assert.match(all, /сегмент 5, его нет/);
  assert.match(editToPlans({ version: 1, variants: [] }, input()).errors[0]!, /нет вариантов/);
});

test("лист: preset, speed, pitch больше не действуют — предупреждение, а не ошибка", () => {
  const res = editToPlans({ version: 1, variants: [{ id: "a", preset: "neon", speed: 1.05, segments: [{ replica: "r02" }] }] }, input());
  assert.deepEqual(res.errors, []);
  assert.equal(res.plans[0]!.preset, "default");
  assert.equal(res.plans[0]!.speed, 1);
  assert.match(res.warnings.join("\n"), /вариант a: preset, speed в листе не используются/);
});

test("лист: одинаковое начало у вариантов — предупреждение про дубли", () => {
  const seg = [{ replica: "r02" }, { replica: "r05" }];
  const res = editToPlans({ version: 1, variants: [{ id: "a", segments: seg }, { id: "b", segments: [...seg].reverse() }, { id: "c", segments: seg }] }, input());
  assert.ok(res.warnings.some((x) => /варианты 1, 3 начинаются одинаково/.test(x)));
});

test("граф: перебивка и вставка — отдельные входы, звук со входа основы, вставка поверх кадра", () => {
  const res = editToPlans(
    { version: 1, variants: [{ id: "a", segments: [{ replica: "r02" }, { replica: "r03", view: "wide", screen: 5 }] }] },
    input(),
  );
  const plan = res.plans[0]!;
  const job = buildFfmpegJob({ plan, preset: presets.find((p) => p.id === plan.preset)!, clips: res.clips, outFile: "out.mp4", presetsDir: PRESETS_DIR });
  const inputs = job.args.filter((_, i, a) => a[i - 1] === "-i");
  assert.deepEqual(inputs, ["C:/s/голова.mp4", "C:/s/голова.mp4", "C:/s/общий.mp4", "C:/s/экран.mp4"]);
  assert.match(job.filterGraph, /\[2:v\]trim=start=/, "картинка второй сцены — с дальнего плана");
  assert.match(job.filterGraph, /\[1:a\]atrim=/, "звук второй сцены — с основы");
  assert.match(job.filterGraph, /\[3:v\]trim=start=5:/, "вставка с 5-й секунды скринкаста");
  assert.match(job.filterGraph, new RegExp(`overlay=x=${DEFAULT_SCREEN_BOX.x}\\+`));
  assert.match(job.filterGraph, /tpad=stop_mode=clone/);
});

test("кроп: у каждого исходника свой, в схеме сцены и в фильтре ffmpeg до масштабирования; мусор отбрасывается", () => {
  const talkCrop = { x: 0.1, y: 0.2, w: 0.7, h: 0.6 };
  const wideCrop = { x: 0, y: 0.25, w: 1, h: 0.75 };
  const screenCrop = { x: 0.05, y: 0, w: 0.5, h: 1 };
  const inp = input();
  const res = editToPlans(
    { version: 1, variants: [{ id: "a", segments: [{ replica: "r02" }, { replica: "r03", view: "wide", screen: 5 }] }] },
    { ...inp, talk: { ...inp.talk, crop: talkCrop }, wide: { ...inp.wide!, crop: wideCrop }, screen: { ...inp.screen!, crop: screenCrop } },
  );
  const plan = res.plans[0]!;
  assert.deepEqual(plan.scenes[0]!.crop, talkCrop, "крупный — кроп основы");
  assert.deepEqual(plan.scenes[1]!.picture!.crop, wideCrop, "перебивка — кроп дальнего");
  assert.deepEqual(plan.scenes[1]!.inset!.crop, screenCrop, "вставка — кроп экрана");
  const g = buildFfmpegJob({ plan, preset: presets.find((p) => p.id === plan.preset)!, clips: res.clips, outFile: "out.mp4", presetsDir: PRESETS_DIR }).filterGraph;
  assert.match(g, /fps=30,crop=w='iw\*0\.7':h='ih\*0\.6':x='iw\*0\.1':y='ih\*0\.2',scale=/, "кроп основы — перед масштабированием в кадр");
  assert.match(g, /\[2:v\][^;]*crop=w='iw\*1':h='ih\*0\.75'/);
  assert.match(g, /\[3:v\][^;]*crop=w='iw\*0\.5'[^;]*scale=/);
  // без кропа — фильтра crop= перед масштабом нет
  const plain = editToPlans({ version: 1, variants: [{ id: "a", segments: [{ replica: "r02" }] }] }, input()).plans[0]!;
  assert.equal(plain.scenes[0]!.crop, undefined);

  assert.deepEqual(cleanCrop({ x: 0.9, y: -1, w: 0.5, h: 0.01 }), { x: 0.5, y: 0, w: 0.5, h: 0.1 }, "внутрь кадра и не меньше 10%");
  assert.equal(cleanCrop({ x: 0, y: 0, w: 1, h: 1 }), null, "весь кадр — без кропа");
  assert.equal(cleanCrop({ x: "a" }), null);
  assert.equal(cleanCrop(null), null);
});

test("охранная зона Reels: рамка экрана сдвигается внутрь 35…1045 × 220…1470, с предупреждением", () => {
  assert.deepEqual(fitSafe({ x: 60, y: 120, w: 960, h: 540 }), { x: 60, y: 220, w: 960, h: 540 });
  assert.deepEqual(fitSafe({ x: 0, y: 220, w: 1080, h: 600 }), { x: 35, y: 220, w: 1010, h: 600 }, "шире зоны — урезается");
  assert.deepEqual(fitSafe({ x: 100, y: 1200, w: 600, h: 400 }), { x: 100, y: 1070, w: 600, h: 400 }, "снизу — подвинуть вверх, размер тот же");
  assert.deepEqual(fitSafe({ x: 60, y: 300, w: 950, h: 600 }), { x: 60, y: 300, w: 950, h: 600 }, "внутри — без изменений");
  const res = editToPlans(
    { version: 1, layout: { wideScreenBox: { x: 60, y: 120, w: 960, h: 540 } }, variants: [{ id: "a", segments: [{ replica: "r02", view: "wide", screen: 3 }] }] },
    input(),
  );
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.plans[0]!.scenes[0]!.inset!.box, { x: 60, y: 220, w: 960, h: 540 });
  assert.match(res.warnings.join("\n"), /wideScreenBox .* выходит из охранной зоны/);
  const def = editToPlans({ version: 1, variants: [{ id: "a", segments: [{ replica: "r02", screen: 3 }] }] }, input());
  assert.deepEqual(def.plans[0]!.scenes[0]!.inset!.box, DEFAULT_SCREEN_BOX);
  assert.deepEqual(fitSafe(DEFAULT_SCREEN_BOX), DEFAULT_SCREEN_BOX, "рамка по умолчанию — в зоне");
});

test("несколько скринкастов: сегмент выбирает свой по screenFile (имя без расширения тоже), у каждого свой кроп", () => {
  const inp = input();
  const gh = { name: "экран — гитхаб.mp4", file: "C:/s/экран — гитхаб.mp4", duration: 30, crop: { x: 0, y: 0, w: 0.5, h: 1 } };
  const res = editToPlans(
    {
      version: 1,
      variants: [{ id: "a", segments: [{ replica: "r02", screen: 3, screenFile: "экран — гитхаб" }, { replica: "r03", view: "wide", screen: 4, screenFile: "экран.mp4" }, { replica: "r04", screen: 1 }] }],
    },
    { ...inp, screen: null, screens: [inp.screen!, gh] },
  );
  assert.deepEqual(res.errors, []);
  const [s0, s1, s2] = res.plans[0]!.scenes;
  assert.equal(s0!.inset!.file, gh.file);
  assert.deepEqual(s0!.inset!.crop, gh.crop, "кроп своего скринкаста");
  assert.equal(s1!.inset!.file, "C:/s/экран.mp4");
  assert.equal(s2!.inset!.file, "C:/s/экран.mp4", "без screenFile — первый");
  assert.match(res.warnings.join("\n"), /сегмент 2: скринкастов несколько, screenFile не указан/);

  const bad = editToPlans(
    { version: 1, variants: [{ id: "b", segments: [{ replica: "r02", screen: 3, screenFile: "нет" }, { replica: "r03", screenFile: "экран" }, { replica: "r04", screen: 40, screenFile: "экран — гитхаб.mp4" }] }] },
    { ...inp, screens: [inp.screen!, gh] },
  ).errors.join("\n");
  assert.match(bad, /сегмент 0: нет скринкаста «нет» \(есть: экран\.mp4, экран — гитхаб\.mp4\)/);
  assert.match(bad, /сегмент 1: screenFile без screen/);
  assert.match(bad, /сегмент 2: screen 40 вне скринкаста «экран — гитхаб\.mp4» \(0–30 с\)/);
});
