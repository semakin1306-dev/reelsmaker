import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadPresets, PRESETS_DIR, type RenderVariantParams } from "@reels-factory/render";
import { scanMontage } from "@reels-factory/pc-agent";
import { editToPlans, splitReplicas } from "@reels-factory/render";
import { buildStory, listRuns, runIdFor, type BuildEnv } from "./build.ts";
import { montageInput, montageScenes } from "./montage.ts";
import { createJobQueue } from "./jobs.ts";
import { createHub, safeJoin } from "./server.ts";

const presets = loadPresets(PRESETS_DIR);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ответы API в тестах читаются как есть
const json = async (r: Promise<Response>): Promise<any> => (await r).json();
const probe = async (_p: string, file: string) => ({ duration: 3, hasAudio: !file.includes("тихо"), width: 720, height: 1280 });

/** Рендер-заглушка: пишет «видео», вариант с index из failOn падает. */
function fakeRender(failOn: number[] = []) {
  const calls: RenderVariantParams[] = [];
  const fn = async (p: RenderVariantParams) => {
    calls.push(p);
    if (failOn.includes(p.plan.index)) throw new Error("ffmpeg: код 1");
    await mkdir(p.outDir, { recursive: true });
    const video = join(p.outDir, "video.mp4");
    await writeFile(video, `видео ${p.plan.index}`);
    for (const f of ["cover.jpg", "sheet.jpg", "ffmpeg.log"]) await writeFile(join(p.outDir, f), f);
    return { video, cover: join(p.outDir, "cover.jpg"), sheet: join(p.outDir, "sheet.jpg"), log: join(p.outDir, "ffmpeg.log"), duration: 12.5, expectedDuration: 12.5 };
  };
  return { fn, calls };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rf-hub-"));
  const env: BuildEnv = {
    inboxDir: join(root, "inbox"),
    outputDir: join(root, "out"),
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    presetsDir: PRESETS_DIR,
    presets,
    stt: null,
  };
  const dir = join(env.inboxDir, "кофе");
  mkdirSync(dir, { recursive: true });
  for (const f of ["01_хук_кофе.mp4", "02a_зёрна.mp4", "02b_зёрна.mp4", "03_помол.mp4", "04_финал.mp4"]) writeFileSync(join(dir, f), "x");
  writeFileSync(join(dir, "01_хук_кофе.transcript.json"), JSON.stringify({ text: "Ты варишь кофе неправильно", words: [{ text: "Ты", start: 0, end: 0.2 }] }));
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("сборка: N вариантов в <вывод>/<сюжет>/<прогон>/vNN, ролик одним файлом в корне прогона, run.json", async () => {
  const { env, cleanup } = setup();
  try {
    const render = fakeRender([2]);
    const progress: number[] = [];
    const run = await buildStory("кофе", { count: 6, presets: ["default", "нет-такого"], hw: "nvenc", concurrency: 2 }, env, {
      renderVariant: render.fn,
      probe,
      progress: (d) => progress.push(d),
      now: () => new Date(2026, 10, 12, 14, 5, 9),
    });
    assert.equal(run.id, "2026-11-12_14-05-09");
    assert.equal(run.count, 6);
    assert.deepEqual(run.presets, ["default"], "неизвестный пресет отброшен");
    assert.ok(render.calls.every((c) => c.opts?.hw === "nvenc"));
    assert.ok(render.calls.every((c) => c.preset.id === "default"));
    assert.equal(new Set(render.calls.map((c) => c.plan.hook.text)).size > 1, true, "хуки различаются");

    const failed = run.variants.filter((v) => v.status === "failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0]!.error!, /код 1/);
    const ready = run.variants.filter((v) => v.status === "ready");
    assert.equal(ready.length, 5);
    const runDir = join(env.outputDir, "кофе", run.id);
    for (const v of ready) {
      assert.equal(v.file, `кофе_${v.dir}.mp4`);
      assert.equal(readFileSync(join(runDir, v.file!), "utf8"), `видео ${v.index}`);
      assert.match(v.order, /^01 → .* → 04$/, "хук первым, финал последним");
    }
    assert.ok(run.finishedAt);
    assert.equal(progress.at(-1), 6);
    assert.ok(run.warnings.some((w) => /расшифровка не настроена/.test(w)), "без модели — предупреждение, а не отказ");

    const saved = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    assert.deepEqual(saved, run);
    assert.deepEqual((await listRuns(env.outputDir, "кофе")).map((r) => r.id), [run.id]);
    assert.deepEqual(await listRuns(env.outputDir, "нет"), []);
  } finally {
    cleanup();
  }
});

test("сборка дорасшифровывает сценки без расшифровки; сбой расшифровки не валит сборку", async () => {
  const { env, cleanup } = setup();
  try {
    const asked: string[] = [];
    const run = await buildStory("кофе", { count: 2, presets: [], hw: "cpu", concurrency: 1 }, { ...env, stt: { python: "p", model: "m" } }, {
      renderVariant: fakeRender().fn,
      probe,
      transcribe: async (dir, id) => {
        asked.push(id);
        throw new Error("CUDA out of memory");
      },
    });
    assert.deepEqual(asked, ["кофе"]);
    assert.ok(run.warnings.some((w) => /out of memory/.test(w)));
    assert.equal(run.variants.filter((v) => v.status === "ready").length, 2);
  } finally {
    cleanup();
  }
});

test("номер прогона — локальное время, сортируется как строка", () => {
  assert.equal(runIdFor(new Date(2026, 0, 2, 3, 4, 5)), "2026-01-02_03-04-05");
});

test("очередь задач: строго по одной, ошибка задачи не останавливает следующую", async () => {
  const q = createJobQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = q.add("build", "s", async (ctx) => {
    order.push("a+");
    ctx.progress(1, 2);
    await gate;
    order.push("a-");
  });
  const b = q.add("transcribe", "s", async () => {
    order.push("b");
    throw new Error("сбой");
  });
  const c = q.add("build", "t", async (ctx) => {
    order.push("c");
    ctx.setRun("r1");
  });
  assert.equal(a.status, "running");
  assert.equal(b.status, "queued");
  assert.deepEqual(q.activeFor("s").map((j) => j.id), [a.id, b.id]);
  release();
  while (c.status !== "done") await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["a+", "a-", "b", "c"]);
  assert.equal(b.status, "failed");
  assert.equal(b.error, "сбой");
  assert.equal(c.runId, "r1");
  assert.deepEqual(a.progress, { done: 1, total: 2 });
});

test("safeJoin: путь только внутри базы", () => {
  const base = join(tmpdir(), "base");
  assert.equal(safeJoin(base, ["a", "b.mp4"]), join(base, "a", "b.mp4"));
  for (const bad of [["..", "x"], ["a/../../x"], ["a\\..\\x"], []]) assert.throws(() => safeJoin(base, bad), /неверный путь/);
});

test("HTTP: список сюжетов, сюжет, сборка задачей, отдача ролика с Range, открытие папки, чужие пути — 400/404", async () => {
  const { env, cleanup } = setup();
  const opened: string[] = [];
  const { server } = createHub({ ...env, hw: "cpu", concurrency: 2, hooks: { renderVariant: fakeRender().fn, probe }, openFolder: (p) => opened.push(p) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = encodeURIComponent("кофе");
  try {
    const page = await fetch(base + "/");
    assert.match(await page.text(), /<title>ReelsMaker<\/title>/);

    const state = await json(fetch(base + "/api/state"));
    assert.equal(state.stt, false);
    assert.deepEqual(state.presets.map((p: { id: string }) => p.id), ["default"], "одно оформление на все варианты");

    const list = await json(fetch(base + "/api/stories"));
    assert.deepEqual(list, [{ id: "кофе", kind: "scenes", clips: 5, transcripts: 1, agentBusy: false, lastRun: null }]);

    const story = await json(fetch(`${base}/api/stories/${id}`));
    assert.equal(story.scan.clips.length, 5);
    assert.deepEqual(story.runs, []);

    const tr = await fetch(`${base}/api/stories/${id}/transcribe`, { method: "POST", body: "{}" });
    assert.equal(tr.status, 409, "без настроенной модели — понятный отказ");

    const stamp0 = await json(fetch(`${base}/api/stories/${id}/stamp`));
    assert.deepEqual(stamp0.jobs, []);
    const job = await json(fetch(`${base}/api/stories/${id}/build`, { method: "POST", body: JSON.stringify({ count: 3, presets: [] }) }));
    let j = job;
    while (j.status === "queued" || j.status === "running") {
      await new Promise((r) => setTimeout(r, 10));
      j = await json(fetch(`${base}/api/jobs/${job.id}`));
    }
    assert.equal(j.status, "done", j.log.join("\n"));
    assert.ok(j.runId);

    const stamp1 = await json(fetch(`${base}/api/stories/${id}/stamp`));
    assert.notEqual(stamp1.stamp, stamp0.stamp, "новый прогон меняет отпечаток — страница перерисует сюжет");
    assert.match(stamp1.stamp, /run\//);
    const runs = await json(fetch(`${base}/api/stories/${id}/runs`));
    assert.equal(runs[0].variants.filter((v: { status: string }) => v.status === "ready").length, 3);

    const video = await fetch(`${base}/out/${id}/${runs[0].id}/v00/video.mp4`, { headers: { range: "bytes=0-4" } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    const full = Buffer.from("видео 0", "utf8");
    assert.equal(video.headers.get("content-range"), `bytes 0-4/${full.length}`);
    assert.deepEqual(Buffer.from(await video.arrayBuffer()), full.subarray(0, 5));

    const open = await json(fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify({ story: "кофе", run: runs[0].id }) }));
    assert.equal(open.path, join(env.outputDir, "кофе", runs[0].id));
    assert.deepEqual(opened, [open.path]);
    assert.equal((await fetch(`${base}/api/open`, { method: "POST", body: JSON.stringify({ story: "кофе", run: ".." }) })).status, 400);

    assert.equal((await fetch(`${base}/out/${id}/..%2F..%2Fsecret.txt`)).status, 400);
    assert.equal((await fetch(`${base}/out/${id}/нет/v00/video.mp4`)).status, 404);
    assert.equal((await fetch(`${base}/api/stories/${encodeURIComponent("..")}`)).status, 404);
    assert.equal((await fetch(`${base}/api/stories/нет-такого/build`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/stories/${id}/build`, { method: "POST", body: "не json" })).status, 400);
    assert.ok(existsSync(join(env.outputDir, "кофе")));
  } finally {
    server.close();
    cleanup();
  }
});

test("HTTP, сюжет из исходников: роли, монтаж, проверка листа и сборка по листу с перебивками и вставками", async () => {
  const { env, cleanup } = setup();
  const dir = join(env.inboxDir, "бот");
  mkdirSync(dir, { recursive: true });
  for (const f of ["голова.mp4", "дальний.mp4", "экран.mp4"]) writeFileSync(join(dir, f), "x");
  const words = ["Привет.", "Сегодня", "про", "бота.", "Открываем", "панель.", "Подпишись!"];
  writeFileSync(join(dir, "голова.transcript.json"), JSON.stringify({ text: "", words: words.map((text, i) => ({ text, start: i * 1.2, end: i * 1.2 + 0.8 })) }));
  const render = fakeRender();
  const { server } = createHub({ ...env, hw: "cpu", concurrency: 2, hooks: { renderVariant: render.fn, probe: async () => ({ duration: 20, hasAudio: true, width: 1080, height: 1920 }) }, openFolder: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stories/${encodeURIComponent("бот")}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  try {
    const story = await json(fetch(base));
    assert.equal(story.kind, "montage");
    assert.deepEqual(story.montage.roles, { talk: "голова.mp4", wide: "дальний.mp4", screen: "экран.mp4" });
    assert.ok(story.montage.replicas.length >= 3);

    assert.equal((await post("/check", {})).status, 404, "листа ещё нет");
    const rep = story.montage.replicas.map((r: { id: string }) => r.id);
    const edit = {
      version: 1,
      variants: [
        { id: "a", hook: "Бот за 5 минут", segments: [{ replica: rep[1] }, { replica: rep[2], view: "wide", screen: 3 }, { replica: rep.at(-1) }] },
        { id: "b", segments: [{ replica: rep[0], view: "wide" }, { replica: rep[2], screen: true }, { replica: rep.at(-1) }] },
      ],
    };
    const bad = await json(post("/check", { edit: { version: 1, variants: [{ id: "x", segments: [{ replica: "r99" }] }] } }));
    assert.match(bad.errors[0], /нет реплики r99/);
    writeFileSync(join(dir, "edit.json"), JSON.stringify(edit));
    const ok = await json(post("/check", {}));
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.variants.map((v: { id: string }) => v.id), ["a", "b"]);
    assert.match(ok.variants[0].label, /дальний\+экран/);

    assert.equal((await post("/roles", { wide: "нет.mp4" })).status, 400);
    assert.deepEqual((await json(post("/roles", { screen: "экран.mp4" }))).roles, { screen: "экран.mp4" });

    // число вариантов: хранится в story.json, проверка листа подсказывает дописать
    assert.equal((await post("/settings", { count: 99 })).status, 400);
    assert.deepEqual(await json(post("/settings", { count: 4 })), { count: 4 });
    assert.equal((await json(fetch(base + "/montage"))).count, 4);
    assert.match((await json(post("/check", {}))).warnings.join("\n"), /в листе 2 вариантов, владелец просит 4 — допишите лист/);
    assert.deepEqual(await json(post("/settings", { count: null })), { count: null });

    // кроп: по роли или файлу, хранится в story.json по имени файла, смена ролей его не теряет
    assert.deepEqual((await json(post("/crop", { source: "talk", crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.7 } }))).crop, { x: 0.1, y: 0.1, w: 0.8, h: 0.7 });
    assert.equal((await post("/crop", { source: "нет.mp4", crop: null })).status, 404);
    assert.equal((await post("/crop", { source: "talk", crop: { x: "?" } })).status, 400);
    await json(post("/roles", { screen: "экран.mp4" }));
    // несколько скринкастов — массивом; один — строкой
    writeFileSync(join(dir, "экран — гитхаб.mp4"), "x");
    assert.deepEqual((await json(post("/roles", { screen: ["экран.mp4", "экран — гитхаб.mp4"] }))).roles.screen, ["экран.mp4", "экран — гитхаб.mp4"]);
    assert.deepEqual((await json(fetch(base + "/montage"))).screens, ["экран.mp4", "экран — гитхаб.mp4"]);
    assert.equal((await post("/roles", { screen: ["экран.mp4", "нет.mp4"] })).status, 400);
    await json(post("/roles", { screen: "экран.mp4" }));
    const meta = JSON.parse(readFileSync(join(dir, "story.json"), "utf8"));
    assert.deepEqual(meta.crops, { "голова.mp4": { x: 0.1, y: 0.1, w: 0.8, h: 0.7 } });
    assert.deepEqual((await json(fetch(base + "/montage"))).sources.find((x: { name: string }) => x.name === "голова.mp4").crop, { x: 0.1, y: 0.1, w: 0.8, h: 0.7 });

    let j = await json(post("/build-edit", { variants: ["b"] }));
    while (j.status === "queued" || j.status === "running") {
      await new Promise((r) => setTimeout(r, 10));
      j = await json(fetch(base.replace(/\/stories\/.*$/, "/jobs/") + j.id));
    }
    assert.equal(j.status, "done", j.log.join("\n"));
    assert.equal(render.calls.length, 1, "только вариант b");
    const sc = render.calls[0]!.plan.scenes;
    assert.ok(sc.every((x) => x.file.endsWith("голова.mp4")), "звук с основы");
    assert.ok(sc[0]!.picture?.file.endsWith("дальний.mp4"));
    assert.ok(sc[1]!.inset?.file.endsWith("экран.mp4"));
    assert.deepEqual(sc[1]!.crop, { x: 0.1, y: 0.1, w: 0.8, h: 0.7 }, "сборка берёт кроп основы");
    // сброс кропа: весь кадр
    assert.equal((await json(post("/crop", { source: "голова.mp4", crop: { x: 0, y: 0, w: 1, h: 1 } }))).crop, null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).crops, {});
    const runs = await json(fetch(base + "/runs"));
    assert.equal(runs[0].variants[0].name, "b");
    assert.ok(runs[0].dir.endsWith(runs[0].id));

    const agent = await json(fetch(base + "/agent"));
    assert.equal(agent.alive, false);
    assert.equal((await post("/agent/send", { text: "" })).status, 400);
    assert.equal((await post("/agent/perm", { reqId: "нет", allow: true })).status, 409);
  } finally {
    server.close();
    cleanup();
  }
});

test("HTTP: оформление из интерфейса — шрифт, размер, цвет; свой шрифт загружается в папку данных и попадает в пресет", async () => {
  const { env, cleanup } = setup();
  const dataDir = mkdtempSync(join(tmpdir(), "rf-style-"));
  const presets = loadPresets(PRESETS_DIR);
  const { server } = createHub({ ...env, presets, hw: "cpu", concurrency: 1, dataDir, openFolder: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  try {
    let st = await json(fetch(base + "/api/style"));
    assert.equal(st.enabled, true);
    assert.equal(st.layers.hook.family, "Home Video");
    assert.deepEqual(st.fonts.map((f: { family: string }) => f.family), ["Home Video", "Montserrat"]);

    // свой шрифт: проверка, что это шрифт; сохраняется в <данные>/fonts
    assert.equal((await fetch(base + "/api/fonts?name=x.otf", { method: "POST", body: "не шрифт" })).status, 400);
    assert.equal((await fetch(base + "/api/fonts?name=x.exe", { method: "POST", body: "x" })).status, 400);
    const otf = readFileSync(join(PRESETS_DIR, "fonts", "HomeVideo-Bold.otf"));
    assert.deepEqual(await json(fetch(base + "/api/fonts?name=" + encodeURIComponent("Мой.otf"), { method: "POST", body: otf })), { file: "Мой.otf", family: "Home Video", source: "user" });
    assert.ok(existsSync(join(dataDir, "fonts", "Мой.otf")));
    assert.equal((await fetch(base + "/fonts/" + encodeURIComponent("Мой.otf"))).headers.get("content-type"), "font/otf");

    assert.equal((await post("/api/style", { caption: { fontFile: "нет.otf" } })).status, 400);
    assert.equal((await post("/api/style", { caption: { color: "белый" } })).status, 400);
    st = await json(post("/api/style", { caption: { fontFile: "Мой.otf", size: 90, color: "#ffffff", outline: 7 } }));
    assert.deepEqual(st.layers.caption, { fontFile: "Мой.otf", family: "Home Video", size: 90, color: "#FFFFFF", outlineColor: "#000000", outline: 7, marginV: 460, alignment: 2 });
    // сборка берёт пресет с оформлением: свой шрифт — полным путём
    assert.equal(presets[0]!.caption.fontFile, join(dataDir, "fonts", "Мой.otf"));
    assert.equal(presets[0]!.caption.size, 90);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "style.json"), "utf8")).caption.size, 90);

    // после перезапуска оформление читается из style.json
    const again = loadPresets(PRESETS_DIR);
    const h2 = createHub({ ...env, presets: again, hw: "cpu", concurrency: 1, dataDir, openFolder: () => {} });
    await new Promise<void>((r) => h2.server.listen(0, "127.0.0.1", r));
    await fetch(`http://127.0.0.1:${(h2.server.address() as AddressInfo).port}/api/style`);
    assert.equal(again[0]!.caption.size, 90);
    h2.server.close();

    st = await json(post("/api/style", { reset: true }));
    assert.equal(st.layers.caption.family, "Montserrat");
    assert.equal(presets[0]!.caption.fontFile, "Montserrat-Bold.ttf");
  } finally {
    server.close();
    cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTP, озвучка с микрофона: записи копятся (каждая — новый файл и новая озвучка), аудио без кадров и кропа, слова по файлу", async () => {
  const { env, cleanup } = setup();
  const dir = join(env.inboxDir, "челси");
  mkdirSync(dir, { recursive: true });
  for (const f of ["голова.mp4", "дальний.mp4"]) writeFileSync(join(dir, f), "x");
  const converted: string[] = [];
  const { server } = createHub({
    ...env,
    hw: "cpu",
    concurrency: 1,
    hooks: { probe: async (_p: string, file: string) => ({ duration: 8, hasAudio: !file.endsWith("голова.mp4"), width: file.endsWith(".wav") ? null : 1080, height: file.endsWith(".wav") ? null : 1920 }) },
    // вместо ffmpeg: «перекодированный» файл — те же байты записи
    // очистка без настоящего ffmpeg: «тишина» на входе, «чистый звук» на выходе
    cleanDeps: {
      decode: async () => ({ samples: new Float32Array(16000 * 4), rate: 16000 }),
      run: async (_c: string, args: string[]) => {
        writeFileSync(args[args.length - 1]!, "чистый звук");
        return { ok: true, stderr: "" };
      },
    },
    convertAudio: async (src, dst) => {
      // ffmpeg не умеет писать поверх своего входа: запись, пришедшая уже в wav, перекодируется в другой файл
      assert.notEqual(src, dst);
      converted.push(src.split(/[\\/]/).pop()!);
      writeFileSync(dst, readFileSync(src));
    },
    openFolder: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${root}/api/stories/${encodeURIComponent("челси")}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  const upload = (bytes: number, ext = "webm") => fetch(`${base}/voice?ext=${ext}`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.alloc(bytes, 7) });
  const names = (m: { voices: { name: string }[] }) => m.voices.map((v) => v.name);
  try {
    let m = await json(fetch(base + "/montage"));
    assert.deepEqual(m.voices, []);
    assert.equal(m.sound, "none", "у основы нет звука, озвучки нет — ролики без звука");
    assert.match(m.problems.join("\n"), /у основы нет звука — ролики соберутся без звука/);

    assert.equal((await upload(100)).status, 400, "пустая запись");
    assert.equal((await upload(4096, "../x")).status, 400, "расширение — только буквы и цифры");
    assert.deepEqual(await json(upload(4096)), { name: "озвучка.wav", clean: true, cleanMode: "profile" });
    assert.deepEqual(converted, ["voice-upload.webm"]);
    assert.ok(existsSync(join(dir, "озвучка.wav")));
    assert.deepEqual(await readdirNames(join(dir, ".rm")), ["clean"], "временных файлов нет, осталась только папка чистых копий");
    assert.deepEqual((await readdirNames(join(dir, ".rm", "clean"))).sort(), ["озвучка.json", "озвучка.wav"], "в ней нет временных файлов");
    m = await json(fetch(base + "/montage"));
    assert.deepEqual(names(m), ["озвучка.wav"]);
    assert.equal(m.voices[0].letter, "a");
    assert.equal(m.sound, "voice");
    assert.equal(m.roles.voice, "озвучка.wav");
    assert.equal(m.voices[0].transcribed, false);
    assert.doesNotMatch(m.problems.join("\n"), /у основы нет звука/);
    assert.match(m.problems.join("\n"), /озвучка «озвучка\.wav» ещё не расшифрована/);

    // вторая запись не затирает первую: обе остаются озвучками, буквы стабильны
    assert.deepEqual(await json(upload(2048)), { name: "озвучка 2.wav", clean: true, cleanMode: "profile" });
    assert.deepEqual(await json(upload(2048, "wav")), { name: "озвучка 3.wav", clean: true, cleanMode: "profile" }, "запись в wav (так шлёт страница) — тоже");
    assert.ok(existsSync(join(dir, "озвучка.wav")) && existsSync(join(dir, "озвучка 2.wav")));
    m = await json(fetch(base + "/montage"));
    assert.deepEqual(names(m), ["озвучка.wav", "озвучка 2.wav", "озвучка 3.wav"]);
    assert.deepEqual(m.voices.map((v: { letter: string }) => v.letter), ["a", "b", "c"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).sources.voice, ["озвучка.wav", "озвучка 2.wav", "озвучка 3.wav"]);

    // метка микрофона записи (её шлёт страница) хранится в story.json по имени файла: по ней очистка находит образец шума микрофона
    const withMic = await json(fetch(`${base}/voice?ext=wav&mic=${encodeURIComponent("Микрофон (2- C-1U)")}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: Buffer.alloc(2048, 3) }));
    assert.equal(withMic.name, "озвучка 4.wav");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).voiceMic, { "озвучка 4.wav": "Микрофон (2- C-1U)" });
    await json(post("/voice/delete", { name: "озвучка 4.wav" }));
    // очистка: у каждой записи есть чистая копия в .rm/clean, оригинал не тронут, в ролик пойдёт чистая
    assert.ok(existsSync(join(dir, ".rm", "clean", "озвучка.wav")) && existsSync(join(dir, ".rm", "clean", "озвучка.json")));
    assert.equal(readFileSync(join(dir, "озвучка.wav")).length, 4096, "оригинал не изменён");
    assert.deepEqual(m.voices.map((v: { clean: string }) => v.clean), ["ready", "ready", "ready"]);
    assert.equal(m.voiceClean, true);
    const scanned = await scanMontage(dir, "челси", { ffprobePath: "ffprobe", probe: async () => ({ duration: 8, hasAudio: true, width: null, height: null }) });
    assert.match(montageInput(scanned, []).voices![0]!.file.replace(/\\/g, "/"), /\/\.rm\/clean\/озвучка\.wav$/, "звук роликов — из чистой копии");
    assert.equal((await fetch(`${root}/in/${encodeURIComponent("челси")}/.rm/clean/${encodeURIComponent("озвучка.wav")}`)).status, 200, "чистую копию можно прослушать");
    assert.equal((await fetch(`${root}/in/${encodeURIComponent("челси")}/.rm/clean/${encodeURIComponent("озвучка.json")}`)).status, 404, "отдаётся только аудио");
    // изменили оригинал — копия устарела и пересчитывается
    writeFileSync(join(dir, "озвучка 3.wav"), Buffer.alloc(3000, 9));
    assert.equal((await json(fetch(base + "/montage"))).voices[2].clean, "stale");
    assert.deepEqual((await json(post("/voice/clean", {}))).done, ["озвучка 3.wav"], "пересчитана только устаревшая");
    assert.deepEqual((await json(post("/voice/clean", { force: true }))).done.length, 3, "force — все");
    // выключили очистку: звук роликов — оригиналы
    assert.deepEqual(await json(post("/settings", { voiceClean: false })), { count: null, voiceClean: false });
    m = await json(fetch(base + "/montage"));
    assert.deepEqual(m.voices.map((v: { clean: string }) => v.clean), ["off", "off", "off"]);
    assert.equal((await post("/voice/clean", {})).status, 409);
    const off = await scanMontage(dir, "челси", { ffprobePath: "ffprobe", probe: async () => ({ duration: 8, hasAudio: true, width: null, height: null }) });
    assert.match(montageInput(off, []).voices![0]!.file.replace(/\\/g, "/"), /челси\/озвучка\.wav$/, "без очистки — оригинал");
    assert.equal((await post("/settings", { voiceClean: "да" })).status, 400);
    assert.deepEqual(await json(post("/settings", { voiceClean: true })), { count: null, voiceClean: true });
    assert.equal(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).voiceClean, undefined);

    // прослушивание на странице; только аудио
    const got = await fetch(`${root}/in/${encodeURIComponent("челси")}/${encodeURIComponent("озвучка.wav")}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "audio/wav");
    assert.equal((await fetch(`${root}/in/${encodeURIComponent("челси")}/${encodeURIComponent("story.json")}`)).status, 404);

    // у аудио нет кадров и кропа; в основу, дальний и экран аудиофайл не назначить
    assert.equal((await post("/frames", { source: "voice", grid: 2 })).status, 400);
    assert.equal((await post("/crop", { source: "озвучка.wav", crop: null })).status, 400);
    assert.equal((await post("/roles", { talk: "озвучка.wav" })).status, 400);

    // слова: озвучек несколько — нужен файл; озвучка не расшифрована — 409
    assert.equal((await fetch(base + "/words?from=0&to=5")).status, 400);
    assert.equal((await fetch(base + "/words?from=0&to=5&file=" + encodeURIComponent("озвучка 2"))).status, 409);
    writeFileSync(join(dir, "озвучка 2.transcript.json"), JSON.stringify({ text: "", words: [{ text: "Привет.", start: 0.3, end: 0.8 }, { text: "Пока.", start: 2, end: 2.5 }] }));
    m = await json(fetch(base + "/montage"));
    assert.deepEqual(m.voiceReplicas.map((r: { id: string; source: string }) => [r.id, r.source]), [["b01", "озвучка 2.wav"], ["b02", "озвучка 2.wav"]]);
    const w = await json(fetch(base + "/words?from=0&to=1&file=" + encodeURIComponent("озвучка 2.wav")));
    assert.equal(w.file, "озвучка 2.wav");
    assert.deepEqual(w.words.map((x: { text: string }) => x.text), ["Привет."]);

    // лист по репликам озвучки (файл — по букве реплики); «replica» при озвучке — ошибка
    writeFileSync(join(dir, "edit.json"), JSON.stringify({ version: 1, variants: [{ id: "a", segments: [{ voice: "b01", note: "приветствие, вид из окна" }, { voice: "b02", view: "wide", wideAt: 1 }] }] }));
    const ok = await json(post("/check", {}));
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.variants[0].label, "b01 → b02 дальний");
    // план по сценам для страницы: время в ролике, реплика, картинка, подпись монтажёра или текст реплики
    const [sc1, sc2] = ok.variants[0].scenes;
    assert.deepEqual([sc1.id, sc1.visual, sc1.note, sc1.text, sc1.from], ["b01", "вид", "приветствие, вид из окна", "Привет.", 0]);
    assert.deepEqual([sc2.id, sc2.visual, sc2.note, sc2.text], ["b02", "дальний", "", "Пока."]);
    assert.ok(Math.abs(sc2.from - sc1.to) < 0.11 && sc2.to > sc2.from);
    const bad = await json(post("/check", { edit: { version: 1, variants: [{ id: "x", segments: [{ replica: "r01" }] }] } }));
    assert.match(bad.errors[0], /укажите "voice"/);

    // роли: озвучки массивом; «—» — отказ, звук снова не с озвучек
    assert.deepEqual((await json(post("/roles", { voice: ["озвучка 3.wav", "озвучка.wav"] }))).roles.voice, ["озвучка 3.wav", "озвучка.wav"]);
    assert.deepEqual(names(await json(fetch(base + "/montage"))), ["озвучка 3.wav", "озвучка.wav"], "порядок задаёт владелец");
    assert.equal((await post("/roles", { voice: ["нет.wav"] })).status, 400);
    assert.equal((await json(post("/roles", { voice: "" }))).roles.voice, "");
    m = await json(fetch(base + "/montage"));
    assert.deepEqual(m.voices, []);
    assert.equal(m.sound, "none");

    // звук видео: настройка хранится в story.json
    assert.equal((await post("/settings", { muteVideo: "да" })).status, 400);
    assert.deepEqual(await json(post("/settings", { muteVideo: true })), { count: null, muteVideo: true });
    assert.equal((await json(fetch(base + "/montage"))).mute, true);
    assert.equal(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).muteVideo, true);
    assert.deepEqual(await json(post("/settings", { muteVideo: false })), { count: null, muteVideo: false });
    assert.equal(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).muteVideo, undefined);
  } finally {
    server.close();
    cleanup();
  }
});

test("HTTP, удаление озвучки: файл уходит в .rm/trash, буквы остальных не сдвигаются и не выдаются заново, видео не удаляется", async () => {
  const { env, cleanup } = setup();
  const dir = join(env.inboxDir, "челси");
  mkdirSync(dir, { recursive: true });
  for (const f of ["голова.mp4", "дальний.mp4", "диктофон.mp4"]) writeFileSync(join(dir, f), "x");
  const { server } = createHub({
    ...env,
    hw: "cpu",
    concurrency: 1,
    hooks: { probe: async (_p: string, file: string) => ({ duration: 8, hasAudio: !file.endsWith("голова.mp4"), width: file.endsWith(".wav") ? null : 1080, height: file.endsWith(".wav") ? null : 1920 }) },
    // очистка без настоящего ffmpeg: «тишина» на входе, «чистый звук» на выходе
    cleanDeps: {
      decode: async () => ({ samples: new Float32Array(16000 * 4), rate: 16000 }),
      run: async (_c: string, args: string[]) => {
        writeFileSync(args[args.length - 1]!, "чистый звук");
        return { ok: true, stderr: "" };
      },
    },
    convertAudio: async (src, dst) => writeFileSync(dst, readFileSync(src)),
    openFolder: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stories/${encodeURIComponent("челси")}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  const upload = () => json(fetch(`${base}/voice?ext=wav`, { method: "POST", headers: { "content-type": "audio/wav" }, body: Buffer.alloc(4096, 5) }));
  const letters = async () => Object.fromEntries((await json(fetch(base + "/montage"))).voices.map((v: { name: string; letter: string }) => [v.name, v.letter]));
  try {
    for (let i = 0; i < 3; i++) await upload();
    writeFileSync(join(dir, "озвучка 2.transcript.json"), JSON.stringify({ text: "", words: [{ text: "Кривой", start: 0.2, end: 0.6 }] }));
    assert.deepEqual(await letters(), { "озвучка.wav": "a", "озвучка 2.wav": "b", "озвучка 3.wav": "c" });

    // нельзя: нет такой озвучки; не озвучка (видео основы); видео, назначенное озвучкой
    assert.equal((await post("/voice/delete", { name: "нет.wav" })).status, 404);
    assert.equal((await post("/voice/delete", { name: "голова.mp4" })).status, 404, "основа — не озвучка");
    await json(post("/roles", { voice: ["озвучка.wav", "озвучка 2.wav", "озвучка 3.wav", "диктофон.mp4"] }));
    const vid = await post("/voice/delete", { name: "диктофон.mp4" });
    assert.equal(vid.status, 400);
    assert.match(((await vid.json()) as { error: string }).error, /не аудиофайл/);
    assert.ok(existsSync(join(dir, "диктофон.mp4")), "видео на месте");
    await json(post("/roles", { voice: ["озвучка.wav", "озвучка 2.wav", "озвучка 3.wav"] }));

    // удаляем средний дубль (b): файл и расшифровка — в корзину, не стираются
    const del = await json(post("/voice/delete", { name: "озвучка 2.wav" }));
    assert.deepEqual([del.deleted, del.letter, del.left], ["озвучка 2.wav", "b", ["озвучка.wav", "озвучка 3.wav"]]);
    assert.ok(!existsSync(join(dir, "озвучка 2.wav")) && !existsSync(join(dir, "озвучка 2.transcript.json")));
    const trash = await readdirNames(join(dir, ".rm", "trash"));
    assert.equal(trash.length, 4, "запись, расшифровка, чистая копия и её описание");
    assert.ok(trash.some((f) => f.endsWith("_озвучка 2.wav")) && trash.some((f) => f.endsWith("_озвучка 2.transcript.json")));
    assert.ok(trash.some((f) => f.endsWith("_чистая_озвучка 2.wav")) && trash.some((f) => f.endsWith("_чистая_озвучка 2.json")));
    assert.ok(!existsSync(join(dir, ".rm", "clean", "озвучка 2.wav")), "чистая копия ушла вместе с записью");
    assert.deepEqual(await letters(), { "озвучка.wav": "a", "озвучка 3.wav": "c" }, "c остаётся c — ссылки в листе не едут");

    // новая запись не наследует ни имя, ни букву удалённой
    assert.deepEqual(await upload(), { name: "озвучка 4.wav", clean: true, cleanMode: "profile" });
    assert.deepEqual(await letters(), { "озвучка.wav": "a", "озвучка 3.wav": "c", "озвучка 4.wav": "d" });
    const meta = JSON.parse(readFileSync(join(dir, "story.json"), "utf8"));
    assert.equal(meta.voiceLetters["озвучка 2.wav"], "b", "буква удалённой остаётся занятой");

    // удалили все — озвучек нет, звук роликов снова по правилам основы
    for (const n of ["озвучка.wav", "озвучка 3.wav", "озвучка 4.wav"]) assert.equal((await post("/voice/delete", { name: n })).status, 200);
    const m = await json(fetch(base + "/montage"));
    assert.deepEqual(m.voices, []);
    assert.equal(m.sound, "none");
    assert.equal(JSON.parse(readFileSync(join(dir, "story.json"), "utf8")).sources.voice, undefined);
    assert.equal((await readdirNames(join(dir, ".rm", "trash"))).filter((f) => f.endsWith(".wav") && !f.includes("_чистая_")).length, 4, "все четыре записи целы в корзине");
  } finally {
    server.close();
    cleanup();
  }
});

test("HTTP, озвучка: сюжет из сценок NN_… записи не принимает", async () => {
  const { env, cleanup } = setup();
  const { server } = createHub({ ...env, hw: "cpu", concurrency: 1, hooks: { probe }, convertAudio: async () => {}, openFolder: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stories/${encodeURIComponent("кофе")}/voice?ext=webm`, { method: "POST", body: Buffer.alloc(4096, 1) });
    assert.equal(r.status, 409);
  } finally {
    server.close();
    cleanup();
  }
});

async function readdirNames(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

test("план по сценам: сегмент start/end получает id и текст перекрытых реплик озвучки", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  const tr = { text: "", words: [w("Первая.", 0.5, 1.2), w("Вторая", 3, 3.5), w("фраза.", 3.5, 4.2), w("Третья.", 6, 6.8)] };
  const voiceReplicas = splitReplicas(tr, 9, { prefix: "k" }).map((r) => ({ ...r, source: "озвучка.wav" }));
  assert.equal(voiceReplicas.length, 3);
  const input = {
    storyId: "s",
    talk: { name: "голова.mp4", file: "C:/s/голова.mp4", duration: 30, transcript: null },
    replicas: [],
    voices: [{ name: "озвучка.wav", file: "C:/s/.rm/clean/озвучка.wav", duration: 9, transcript: tr }],
    voiceReplicas,
    presets: ["default"],
  };
  const edit = { version: 1 as const, variants: [{ id: "a", segments: [{ start: 0.3, end: 4.4, note: "k01 + k02" }, { start: 5.9, end: 7, view: "wide" as const }] }] };
  const res = editToPlans(edit, { ...input, wide: { name: "дальний.mp4", file: "C:/s/дальний.mp4", duration: 20 } });
  assert.deepEqual(res.errors, []);
  const [a, b] = montageScenes(res.plans[0]!, edit.variants[0]!, voiceReplicas, "C:/s/голова.mp4");
  assert.deepEqual([a!.id, a!.text, a!.note, a!.visual], ["k01 + k02", "Первая. Вторая фраза.", "k01 + k02", "вид"], "реплики по перекрытию, подпись монтажёра — отдельно");
  assert.deepEqual([b!.id, b!.text, b!.visual], ["k03", "Третья.", "дальний"]);
});
