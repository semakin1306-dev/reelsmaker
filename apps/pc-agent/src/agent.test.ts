import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProbe, probeClip } from "./probe.ts";
import { parseSttOutput, transcribeFiles, transcriptPath, isTranscriptFresh, SttError, STT_SCRIPT, type SttRun } from "./stt.ts";
import { listStoryDirs, needsTranscript, readTheme, scanStory, toStoryInput, isSafeName } from "./story.ts";
import { transcribeStory } from "./index.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test("ffprobe: длительность, звук и размер кадра; без видео или длительности — null", () => {
  const ok = parseProbe(
    JSON.stringify({ format: { duration: "3.84" }, streams: [{ codec_type: "video", width: 720, height: 1280 }, { codec_type: "audio" }] }),
  );
  assert.deepEqual(ok, { duration: 3.84, hasAudio: true, width: 720, height: 1280 });
  assert.equal(parseProbe(JSON.stringify({ format: { duration: "2" }, streams: [{ codec_type: "video" }] }))?.hasAudio, false);
  assert.equal(parseProbe(JSON.stringify({ format: {}, streams: [{ codec_type: "video" }] })), null);
  assert.equal(parseProbe(JSON.stringify({ format: { duration: "2" }, streams: [{ codec_type: "audio" }] })), null);
  assert.equal(parseProbe("не json"), null);
  // видео с iPhone: 1920×1080 с поворотом −90° — это вертикальный кадр 1080×1920
  const phone = (side: unknown) =>
    parseProbe(JSON.stringify({ format: { duration: "5" }, streams: [{ codec_type: "video", width: 1920, height: 1080, ...(side as object) }] }));
  assert.deepEqual([phone({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })?.width, phone({ tags: { rotate: "90" } })?.height], [1080, 1920]);
  assert.equal(phone({ side_data_list: [{ rotation: 180 }] })?.width, 1920, "переворот на 180° размер не меняет");
});

test("probeClip: аргументы ffprobe массивом, ошибка программы — null", async () => {
  const calls: string[][] = [];
  const bad = await probeClip("ffprobe", "x.mp4", async (_c, args) => {
    calls.push(args);
    return { ok: false, stdout: "", stderr: "Invalid data" };
  });
  assert.equal(bad, null);
  assert.equal(calls[0]?.at(-1), "x.mp4");
  assert.ok(calls[0]?.includes("json"));
});

test("расшифровка: строки JSON по файлам, файл без ответа — ошибка, мусор в выводе пропускается", () => {
  const out = [
    "предупреждение какое-то",
    JSON.stringify({ file: "a.mp4", ok: true, transcript: { text: "привет мир", language: "ru", words: [{ text: "привет", start: 0, end: 0.4 }] } }),
    JSON.stringify({ file: "b.mp4", ok: false, error: "битый звук" }),
    JSON.stringify({ file: "d.mp4", ok: true, transcript: { text: "x" } }),
  ].join("\r\n");
  const res = parseSttOutput(out, ["a.mp4", "b.mp4", "c.mp4", "d.mp4"]);
  assert.equal(res[0]?.ok, true);
  assert.deepEqual(res[0]?.ok && res[0].transcript.words[0], { text: "привет", start: 0, end: 0.4 });
  assert.deepEqual(res[1], { file: "b.mp4", ok: false, error: "битый звук" });
  assert.deepEqual(res[2], { file: "c.mp4", ok: false, error: "нет ответа от расшифровки" });
  assert.equal(res[3]?.ok, false, "расшифровка без words не принимается");
});

test("расшифровка запускает Python службы со скриптом, моделью и офлайн-режимом; модель не поднялась — SttError", async () => {
  let seen: { cmd: string; args: string[]; env: Record<string, string> } | null = null;
  const run: SttRun = async (cmd, args, opts) => {
    seen = { cmd, args, env: opts.env };
    return { code: 0, timedOut: false, stderr: "", stdout: JSON.stringify({ file: "a.mp4", ok: true, transcript: { text: "", words: [] } }) };
  };
  const res = await transcribeFiles(["a.mp4"], { python: "G:/py.exe", model: "G:/model" }, run);
  assert.equal(res[0]?.ok, true);
  assert.equal(seen!.cmd, "G:/py.exe");
  assert.equal(seen!.args[0], STT_SCRIPT);
  assert.deepEqual(seen!.args.slice(1, 9), ["--model", "G:/model", "--language", "ru", "--device", "cuda", "--compute", "int8_float16"]);
  assert.equal(seen!.env["HF_HUB_OFFLINE"], "1", "модель не скачивается");

  const fail: SttRun = async () => ({ code: 2, timedOut: false, stdout: "", stderr: "модель не загрузилась: CUDA out of memory" });
  await assert.rejects(() => transcribeFiles(["a.mp4"], { python: "p", model: "m" }, fail), (e: unknown) => e instanceof SttError && /out of memory/.test((e as Error).message));
  assert.deepEqual(await transcribeFiles([], { python: "p", model: "m" }, fail), []);
});

test("расшифровка рядом со сценкой и свежесть по времени файлов", async () => {
  const dir = tmp("rf-tr-");
  try {
    assert.equal(transcriptPath(join(dir, "01_хук.mp4")), join(dir, "01_хук.transcript.json"));
    const clip = join(dir, "01_хук.mp4");
    writeFileSync(clip, "v");
    assert.equal(await isTranscriptFresh(clip), false);
    writeFileSync(transcriptPath(clip), "{}");
    const old = new Date(Date.now() - 60_000);
    utimesSync(transcriptPath(clip), old, old);
    assert.equal(await isTranscriptFresh(clip), false, "сценку переписали после расшифровки");
    utimesSync(clip, new Date(old.getTime() - 60_000), new Date(old.getTime() - 60_000));
    assert.equal(await isTranscriptFresh(clip), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("папка входа и сюжет: имена, ffprobe, тема, проблемы, вход планировщика", async () => {
  const inbox = tmp("rf-in-");
  try {
    const dir = join(inbox, "кофе");
    for (const d of ["кофе", "_черновик", ".скрытое"]) mkdirSync(join(inbox, d));
    for (const f of ["01_хук_кофе.mp4", "02a_зёрна.mp4", "02b_зёрна.mp4", "03_тихо.mp4", "без_номера.mp4", "04_битый.mp4", "05_финал.mov", "заметки.txt"]) {
      writeFileSync(join(dir, f), "x");
    }
    writeFileSync(join(dir, "тема.txt"), "\n# кофе по утрам\nвторая строка");
    writeFileSync(join(dir, "01_хук_кофе.transcript.json"), JSON.stringify({ text: "кофе", words: [] }));

    assert.deepEqual(await listStoryDirs(inbox), ["кофе"]);
    assert.deepEqual(await listStoryDirs(join(inbox, "нет")), []);
    assert.equal(await readTheme(dir), "кофе по утрам");

    const fakeProbe = async (_p: string, file: string) =>
      file.includes("битый") ? null : { duration: 3, hasAudio: !file.includes("тихо"), width: 720, height: 1280 };
    const scan = await scanStory(dir, "кофе", { ffprobePath: "ffprobe", probe: fakeProbe });
    assert.equal(scan.clips.length, 7, "только видео");
    assert.ok(scan.problems.some((p) => p.startsWith("без_номера.mp4")));
    assert.ok(scan.problems.some((p) => p.startsWith("04_битый.mp4")));
    assert.ok(scan.problems.some((p) => p.startsWith("03_тихо.mp4") && /нет звук/.test(p)));
    assert.equal(scan.clips.find((c) => c.name === "01_хук_кофе.mp4")?.transcript?.text, "кофе");

    const input = toStoryInput(scan);
    assert.deepEqual(input.clips.map((c) => c.id), ["01_хук_кофе.mp4", "02a_зёрна.mp4", "02b_зёрна.mp4", "03_тихо.mp4", "05_финал.mov"]);
    assert.equal(input.theme, "кофе по утрам");
    assert.equal(input.clips.find((c) => c.id === "03_тихо.mp4")?.hasAudio, false);
    // без звука расшифровывать нечего; у хука расшифровка есть (файлы созданы в один момент — свежая)
    assert.deepEqual(needsTranscript(scan).map((c) => c.name).sort(), ["02a_зёрна.mp4", "02b_зёрна.mp4", "05_финал.mov"]);
  } finally {
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("transcribeStory: расшифровывает только нужное и кладёт transcript.json рядом", async () => {
  const dir = tmp("rf-story-");
  try {
    for (const f of ["01_хук.mp4", "02_сцена.mp4"]) writeFileSync(join(dir, f), "x");
    const probe = async () => ({ duration: 2, hasAudio: true, width: 1, height: 1 });
    const asked: string[][] = [];
    const run: SttRun = async (_cmd, args) => {
      const files = args.slice(9);
      asked.push(files);
      return {
        code: 0,
        timedOut: false,
        stderr: "",
        stdout: files
          .map((f) => (f.endsWith("02_сцена.mp4") ? JSON.stringify({ file: f, ok: false, error: "сбой" }) : JSON.stringify({ file: f, ok: true, transcript: { text: "раз", words: [{ text: "раз", start: 0, end: 0.3 }] } })))
          .join("\n"),
      };
    };
    const r = await transcribeStory(dir, "s", { ffprobePath: "ffprobe", probe, stt: { python: "p", model: "m" }, run });
    assert.deepEqual(asked[0]?.map((f) => f.split(/[\\/]/).pop()), ["01_хук.mp4", "02_сцена.mp4"]);
    assert.deepEqual(r.done, ["01_хук.mp4"]);
    assert.deepEqual(r.failed, [{ name: "02_сцена.mp4", error: "сбой" }]);
    assert.equal(r.scan.clips[0]?.transcript?.text, "раз");
    const again = await transcribeStory(dir, "s", { ffprobePath: "ffprobe", probe, stt: { python: "p", model: "m" }, run });
    assert.deepEqual(asked[1]?.map((f) => f.split(/[\\/]/).pop()), ["02_сцена.mp4"], "свежая расшифровка не повторяется");
    assert.deepEqual(again.done, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("имя сюжета для адреса: без разделителей и «..»", () => {
  assert.ok(isSafeName("пример-кофе"));
  for (const bad of ["", ".", "..", "a/b", "a\\b", "c:x"]) assert.equal(isSafeName(bad), false, bad);
});


test("исходники: роли по именам и из story.json, реплики из расшифровки основы, лист и его ошибка чтения", async () => {
  const { guessRole, isMontageStory, scanMontage, writeMeta } = await import("./montage.ts");
  assert.equal(guessRole("голова.mp4"), "talk");
  assert.equal(guessRole("Крупный план.MOV"), "talk");
  assert.equal(guessRole("дальний.mp4"), "wide");
  assert.equal(guessRole("общий_план.mp4"), "wide");
  assert.equal(guessRole("экран.mp4"), "screen");
  assert.equal(guessRole("скринкаст 2.mp4"), "screen");
  assert.equal(guessRole("01_хук.mp4"), null);
  assert.equal(isMontageStory(["01_хук.mp4", "02_сцена.mp4"], {}), false);
  assert.equal(isMontageStory(["голова.mp4", "дальний.mp4"], {}), true);
  assert.equal(isMontageStory(["a.mp4"], { sources: { talk: "a.mp4" } }), true);

  const dir = tmp("rf-mont-");
  try {
    for (const f of ["голова.mp4", "дальний.mp4", "запись.mp4"]) writeFileSync(join(dir, f), "x");
    writeFileSync(
      join(dir, "голова.transcript.json"),
      JSON.stringify({ text: "", words: [{ text: "Привет.", start: 0.2, end: 0.6 }, { text: "Это", start: 1.5, end: 1.7 }, { text: "кофе.", start: 1.7, end: 2.1 }] }),
    );
    const probe = async (_p: string, file: string) => ({ duration: 10, hasAudio: !file.includes("запись"), width: 1080, height: 1920 });
    let m = await scanMontage(dir, "s", { ffprobePath: "ffprobe", probe });
    assert.equal(m.roles.talk?.name, "голова.mp4");
    assert.equal(m.roles.wide?.name, "дальний.mp4");
    assert.equal(m.roles.screen, undefined, "«запись.mp4» по имени не узнаётся");
    assert.ok(m.problems.some((p) => /нет скринкаста/.test(p)));
    assert.deepEqual(m.replicas.map((r) => r.text), ["Привет.", "Это кофе."]);
    assert.equal(m.edit, null);

    await writeMeta(dir, { sources: { screen: "запись.mp4", wide: "нет.mp4" } });
    writeFileSync(join(dir, "edit.json"), "{ не json");
    m = await scanMontage(dir, "s", { ffprobePath: "ffprobe", probe });
    assert.equal(m.roles.screen?.name, "запись.mp4", "роль из story.json");
    assert.equal(m.roles.wide?.name, "дальний.mp4", "заданный в story.json файл не найден — роль по имени");
    assert.ok(m.problems.some((p) => /нет\.mp4/.test(p)));
    assert.match(m.editError ?? "", /edit\.json/);

    // несколько скринкастов: все узнанные по имени или все заданные в story.json; число вариантов
    for (const f of ["экран — гитхаб.mp4", "экран — панель.mp4"]) writeFileSync(join(dir, f), "x");
    await writeMeta(dir, {});
    m = await scanMontage(dir, "s", { ffprobePath: "ffprobe", probe });
    assert.deepEqual(m.screens.map((x) => x.name), ["экран — гитхаб.mp4", "экран — панель.mp4"]);
    assert.equal(m.roles.screen?.name, "экран — гитхаб.mp4");
    assert.equal(m.count, null);
    await writeMeta(dir, { sources: { screen: ["запись.mp4", "экран — панель.mp4"] }, count: 8 });
    m = await scanMontage(dir, "s", { ffprobePath: "ffprobe", probe });
    assert.deepEqual(m.screens.map((x) => x.name), ["запись.mp4", "экран — панель.mp4"], "заданные — только они");
    assert.equal(m.sources.find((x) => x.name === "экран — гитхаб.mp4")?.role, null);
    assert.equal(m.count, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
