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

// ─────────────────────────────── озвучка (отдельный аудиофайл) ───────────────────────────────

const VOICE_TR: Transcript = {
  text: "",
  words: [w("Новый", 0.4, 0.8), w("голос.", 0.8, 1.3), w("Второй", 3.0, 3.4), w("кусок", 3.4, 3.9), w("финал.", 6.0, 6.6)],
};
const voiceInput = (over: Partial<MontageInput> = {}): MontageInput =>
  input({
    talk: { name: "челси.mp4", file: "C:/s/челси.mp4", duration: 30, transcript: null },
    replicas: [],
    voices: [{ name: "озвучка.wav", file: "C:/s/озвучка.wav", duration: 8, transcript: VOICE_TR }],
    voiceReplicas: splitReplicas(VOICE_TR, 8, { prefix: "a" }).map((r) => ({ ...r, source: "озвучка.wav" })),
    ...over,
  });

test("реплики озвучки: свой префикс a01, a02…", () => {
  assert.deepEqual(splitReplicas(VOICE_TR, 8, { prefix: "a" }).map((r) => r.id), ["a01", "a02", "a03"]);
});

test("озвучка: звук и субтитры с аудиофайла, картинка — крупный (основа), дальний, экран", () => {
  const edit: EditList = {
    version: 1,
    variants: [
      { id: "a", segments: [{ voice: "a01" }, { voice: "a02", at: 12.5 }, { voice: "a03", view: "wide", wideAt: 4, screen: 7 }, { start: 0.4, end: 1.3, at: 2 }] },
    ],
  };
  const res = editToPlans(edit, voiceInput());
  assert.deepEqual(res.errors, []);
  const plan = res.plans[0]!;
  for (const s of plan.scenes) {
    assert.equal(s.file, "C:/s/озвучка.wav", "звук всегда с озвучки");
    assert.equal(s.clipId, "озвучка.wav");
    assert.equal(s.hasAudio, true);
  }
  assert.deepEqual(plan.scenes[0]!.picture, { file: "C:/s/челси.mp4", start: plan.scenes[0]!.trim.start }, "крупный: та же секунда основы, что у звука");
  assert.equal(plan.scenes[1]!.picture!.start, 12.5, "at — секунда основы");
  assert.equal(plan.scenes[2]!.picture!.file, "C:/s/общий.mp4");
  assert.equal(plan.scenes[2]!.picture!.start, 4);
  assert.equal(plan.scenes[2]!.inset!.start, 7);
  assert.equal(plan.scenes[3]!.picture!.start, 2);
  assert.deepEqual([plan.scenes[3]!.trim.start, plan.scenes[3]!.trim.end], [0.4, 1.3], "start/end — секунды озвучки");
  assert.match(plan.hook.text, /Новый голос/, "хук — из первой реплики озвучки");
  assert.ok(res.clips.get("озвучка.wav")?.transcript, "субтитры — из расшифровки озвучки");
  assert.equal(res.clips.has("челси.mp4"), false);

  const job = buildFfmpegJob({ plan, preset: presets.find((p) => p.id === plan.preset)!, clips: res.clips, outFile: "out.mp4", presetsDir: PRESETS_DIR });
  const inputs = job.args.filter((_, i, a) => a[i - 1] === "-i");
  assert.deepEqual(inputs.slice(0, 5), ["C:/s/озвучка.wav", "C:/s/челси.mp4", "C:/s/озвучка.wav", "C:/s/челси.mp4", "C:/s/озвучка.wav"]);
  assert.match(job.filterGraph, /\[0:a\]atrim=/, "звук первой сцены — с озвучки");
  assert.match(job.filterGraph, /\[1:v\]trim=start=/, "картинка первой сцены — с основы");
  assert.match(job.filterGraph, /tpad=stop_mode=clone/, "картинка короче звука держит последний кадр");
  const ass = job.staged.find((f) => f.name === "captions.ass")!.content!;
  assert.match(ass, /новый/i, "субтитры из слов озвучки");
});

test("озвучка: replica при озвучке и voice без озвучки — понятные ошибки; сдвиг основы; основа короче", () => {
  const bad = editToPlans({ version: 1, variants: [{ id: "x", segments: [{ replica: "r01" }, { voice: "a99" }, {}] }] }, voiceInput());
  const all = bad.errors.join("\n");
  assert.match(all, /сегмент 0: в сюжете есть озвучка — звук берётся из неё, укажите "voice"/);
  assert.match(all, /сегмент 1: нет реплики a99/);
  assert.match(all, /сегмент 2: нужна voice или start\/end/);
  const none = editToPlans({ version: 1, variants: [{ id: "x", segments: [{ voice: "a01" }] }] }, input());
  assert.match(none.errors.join("\n"), /voice «a01», а озвучки в сюжете нет/);
  const warn = editToPlans({ version: 1, variants: [{ id: "x", segments: [{ replica: "r02", at: 3 }] }] }, input());
  assert.match(warn.warnings.join("\n"), /at работает только при озвучке/);

  const off = editToPlans({ version: 1, layout: { talkOffset: 1.5 }, variants: [{ id: "a", segments: [{ voice: "a03" }] }] }, voiceInput());
  assert.equal(off.plans[0]!.scenes[0]!.picture!.start, round(off.plans[0]!.scenes[0]!.trim.start + 1.5));
  // основа короче нужного: начало сдвигается так, чтобы картинка поместилась
  const short = editToPlans({ version: 1, variants: [{ id: "a", segments: [{ voice: "a03", at: 29.95 }] }] }, voiceInput({ talk: { name: "челси.mp4", file: "C:/s/челси.mp4", duration: 30, transcript: null } }));
  assert.ok(short.plans[0]!.scenes[0]!.picture!.start <= 30 - (short.plans[0]!.scenes[0]!.trim.end - short.plans[0]!.scenes[0]!.trim.start));
  assert.match(short.warnings.join("\n"), /основа длиной 30 с/);
});

const round = (n: number) => Math.round(n * 1000) / 1000;

// ─────────────────────────────── несколько озвучек (дубли) и режим «без звука» ───────────────────────────────

const TAKE2: Transcript = { text: "", words: [w("Хороший", 0.5, 1.0), w("дубль.", 1.0, 1.6), w("Ещё", 3.0, 3.3), w("раз.", 3.3, 3.8)] };
const twoTakes = (): MontageInput =>
  voiceInput({
    voices: [
      { name: "озвучка.wav", file: "C:/s/озвучка.wav", duration: 8, transcript: VOICE_TR },
      { name: "озвучка 2.wav", file: "C:/s/озвучка 2.wav", duration: 5, transcript: TAKE2 },
    ],
    voiceReplicas: [
      ...splitReplicas(VOICE_TR, 8, { prefix: "a" }).map((r) => ({ ...r, source: "озвучка.wav" })),
      ...splitReplicas(TAKE2, 5, { prefix: "b" }).map((r) => ({ ...r, source: "озвучка 2.wav" })),
    ],
  });

test("несколько озвучек: файл берётся из реплики (a01, b02…), звук и субтитры — с нужного дубля", () => {
  const res = editToPlans(
    { version: 1, variants: [{ id: "a", segments: [{ voice: "b01" }, { voice: "a02", at: 3 }, { voice: "b02", view: "wide" }] }] },
    twoTakes(),
  );
  assert.deepEqual(res.errors, []);
  const sc = res.plans[0]!.scenes;
  assert.deepEqual(sc.map((x) => x.file), ["C:/s/озвучка 2.wav", "C:/s/озвучка.wav", "C:/s/озвучка 2.wav"], "каждая сцена — со своего файла");
  assert.deepEqual(sc.map((x) => x.clipId), ["озвучка 2.wav", "озвучка.wav", "озвучка 2.wav"]);
  assert.deepEqual(sc.map((x) => x.duration), [5, 8, 5]);
  assert.ok(res.clips.get("озвучка 2.wav")?.transcript && res.clips.get("озвучка.wav")?.transcript, "субтитры — из расшифровки каждого дубля");
  assert.match(res.plans[0]!.hook.text, /Хороший дубль/, "хук — из первой реплики (дубль b)");
  // граф: звук сцен — со входов разных файлов
  const plan = res.plans[0]!;
  const job = buildFfmpegJob({ plan, preset: presets.find((p) => p.id === plan.preset)!, clips: res.clips, outFile: "out.mp4", presetsDir: PRESETS_DIR });
  const inputs = job.args.filter((_, i, a) => a[i - 1] === "-i");
  assert.equal(inputs[0], "C:/s/озвучка 2.wav");
  assert.equal(inputs[2], "C:/s/озвучка.wav");
});

test("несколько озвучек: start/end требуют voiceFile; ошибки называют, какие файлы есть", () => {
  const res = editToPlans(
    { version: 1, variants: [{ id: "x", segments: [{ start: 0.4, end: 1.3 }, { start: 0.4, end: 1.3, voiceFile: "нет" }, { start: 0.5, end: 1.4, voiceFile: "озвучка 2" }] }] },
    twoTakes(),
  );
  const all = res.errors.join("\n");
  assert.match(all, /сегмент 0: озвучек несколько — укажите voiceFile \(есть: озвучка\.wav, озвучка 2\.wav\)/);
  assert.match(all, /сегмент 1: нет озвучки «нет»/);
  const ok = editToPlans({ version: 1, variants: [{ id: "y", segments: [{ start: 0.5, end: 1.4, voiceFile: "озвучка 2" }] }] }, twoTakes());
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.plans[0]!.scenes[0]!.file, "C:/s/озвучка 2.wav", "voiceFile — без расширения");
  // единственная озвучка: voiceFile не нужен
  assert.deepEqual(editToPlans({ version: 1, variants: [{ id: "z", segments: [{ start: 0.5, end: 1.4 }] }] }, voiceInput()).errors, []);
});

test("звук видео отключён (mute): сцены без звука и без субтитров, картинка по start/end, предупреждение", () => {
  const edit: EditList = { version: 1, variants: [{ id: "a", hook: "Хук", segments: [{ start: 2, end: 6 }, { start: 6, end: 10, screen: 3, view: "wide" }] }] };
  const res = editToPlans(edit, input({ mute: true }));
  assert.deepEqual(res.errors, []);
  const plan = res.plans[0]!;
  assert.ok(plan.scenes.every((x) => x.hasAudio === false), "звук основы в ролик не попадает");
  assert.equal(res.clips.get("голова.mp4")?.transcript, undefined, "субтитров нет");
  assert.equal(res.clips.get("голова.mp4")?.hasAudio, false);
  assert.match(res.warnings.join("\n"), /звук видео отключён, озвучки нет — ролики соберутся без звука/);
  const job = buildFfmpegJob({ plan, preset: presets.find((p) => p.id === plan.preset)!, clips: res.clips, outFile: "out.mp4", presetsDir: PRESETS_DIR });
  assert.match(job.filterGraph, /anullsrc=/, "вместо звука основы — тишина");
  assert.doesNotMatch(job.filterGraph, /\[\d+:a\]/, "звуковая дорожка видео не читается");
  // озвучка важнее mute: звук идёт с неё
  const withVoice = editToPlans({ version: 1, variants: [{ id: "v", segments: [{ voice: "a01" }] }] }, voiceInput({ mute: true }));
  assert.deepEqual(withVoice.errors, []);
  assert.equal(withVoice.plans[0]!.scenes[0]!.hasAudio, true);
  assert.doesNotMatch(withVoice.warnings.join("\n"), /отключён/);
  // без mute звук идёт с основы, как раньше
  assert.equal(editToPlans(edit, input()).plans[0]!.scenes[0]!.hasAudio, true);
});

// ─────────────────────────────── «кадры не скачут»: кадр держится не меньше 2,5 с ───────────────────────────────

test("кадры: вырезанная пауза посреди одного кадра его не рвёт; короткий кадр после скачка — предупреждение", () => {
  const warn = (segments: EditList["variants"][number]["segments"]) => editToPlans({ version: 1, variants: [{ id: "a", segments }] }, voiceInput()).warnings.filter((x) => /кадр держится/.test(x));
  // фон идёт непрерывно (at по умолчанию = секунда звука): две сцены по 3 с — один кадр на 6 с
  assert.deepEqual(warn([{ start: 0, end: 3 }, { start: 3, end: 6 }]), []);
  // вторая сцена — скачок фона и всего 1,2 с
  assert.match(warn([{ start: 0, end: 3, at: 0 }, { start: 3, end: 4.2, at: 10 }])[0]!, /^вариант a: кадр держится 1,2 с \(сцена 2\) — короче 2,5 с, картинка будет скакать/);
  // скринкаст продолжается с того же места (5 + 3 = 8): один кадр; пауза в звуке его не рвёт
  assert.deepEqual(warn([{ start: 0, end: 3, screen: 5, screenFile: "экран" }, { start: 3, end: 6, screen: 8, screenFile: "экран" }]), []);
  // а если скринкаст прыгнул назад-вперёд — это новые кадры, и они достаточно длинные (по 3 с)
  assert.deepEqual(warn([{ start: 0, end: 3, screen: 5 }, { start: 3, end: 6, screen: 30 }]), []);
  // экран на 1 с посреди видео — мелькание
  assert.match(warn([{ start: 0, end: 3 }, { start: 3, end: 4, screen: 5 }])[0]!, /сцена 2/);
  // два коротких подряд, но разных: оба названы
  assert.equal(warn([{ start: 0, end: 3 }, { start: 3, end: 4, screen: 5 }, { start: 4, end: 5.2 , at: 20 }]).length, 2);
  // открывающий кадр 2,5 с — допустим
  assert.deepEqual(warn([{ start: 0, end: 2.5 }, { start: 2.5, end: 8, screen: 5 }]), []);
});

test("подпись сцены note принимается и на сборку не влияет", () => {
  const edit: EditList = { version: 1, variants: [{ id: "a", segments: [{ voice: "a01", note: "a01: приветствие, вид" }, { voice: "a02", note: "a02: экран" }] }] };
  const res = editToPlans(edit, voiceInput());
  assert.deepEqual(res.errors, []);
  assert.equal(res.plans[0]!.scenes.length, 2);
  const plain = editToPlans({ version: 1, variants: [{ id: "a", segments: [{ voice: "a01" }, { voice: "a02" }] }] }, voiceInput());
  assert.deepEqual(res.plans[0]!.scenes, plain.plans[0]!.scenes, "сцены те же — note в схему не попадает");
});
