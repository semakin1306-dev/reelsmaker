import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AFFTDN_DELAY,
  analyzeNoise,
  buildCleanChain,
  buildStoredGraph,
  defaultNoiseDir,
  micSlug,
  readNoiseSample,
  CLEAN_VERSION,
  cleanedPath,
  cleanVoice,
  COMB_KHZ,
  ensureClean,
  gateThreshold,
  isCleanFresh,
  noiseProfile,
  readCleanInfo,
  type CleanDeps,
} from "./voice-clean.ts";
import { scanMontage, writeMeta } from "./montage.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Детерминированный «шум»: линейный конгруэнтный генератор, равномерный −1…1. */
function noise(n: number, amp: number, seed = 12345): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

/** n секунд «речи»: гармоники 150 Гц с огибающей. */
function speech(sec: number, rate: number, amp: number): Float32Array {
  const out = new Float32Array(Math.round(sec * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * 150 * h * t) / h;
    out[i] = amp * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
  }
  return out;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

test("анализ шума: уровень пола и самый длинный тихий кусок; нет тишины — null; пустой файл не падает", () => {
  const rate = 16000;
  const lead = noise(Math.round(0.9 * rate), 0.0017); // ≈ −60 dBFS (RMS = A/√3)
  const a = analyzeNoise(concat(lead, speech(2, rate, 0.05)), rate);
  assert.ok(a.floorDb < -55 && a.floorDb > -66, `пол шума ${a.floorDb}`);
  assert.ok(a.quiet !== null && a.quiet.start <= 0.05 && Math.abs(a.quiet.end - 0.9) <= 0.1, `тишина ${JSON.stringify(a.quiet)}`);
  // речь с первой секунды: тишины нет
  assert.equal(analyzeNoise(concat(speech(2, rate, 0.05), noise(Math.round(0.5 * rate), 0.0017)), rate).quiet, null);
  // слишком короткая тишина (0,3 с) образцом не годится: после запаса перед речью не остаётся 0,3 с; а 0,45 с, как на записи владельца, — годится
  assert.equal(analyzeNoise(concat(noise(Math.round(0.3 * rate), 0.0017), speech(2, rate, 0.05)), rate).quiet, null);
  const q45 = analyzeNoise(concat(noise(Math.round(0.45 * rate), 0.0017), speech(2, rate, 0.05)), rate);
  assert.deepEqual(noiseProfile(q45), { start: 0.05, end: 0.35 }, "0,45 с тишины → образец 0,3 с");
  assert.deepEqual(analyzeNoise(new Float32Array(0), rate), { floorDb: -120, quiet: null });
});

test("щелчок от кнопки записи в начале тишину не ломает: берётся самый длинный тихий кусок после него", () => {
  const rate = 16000;
  // как на записи владельца: 0,15 с тишины, щелчок 0,1 с (≈ −50 dBFS, выше порога тишины), 0,7 с тишины, затем речь
  const click = noise(Math.round(0.1 * rate), 0.004);
  const x = concat(noise(Math.round(0.15 * rate), 0.0017), click, noise(Math.round(0.7 * rate), 0.0017, 777), speech(2, rate, 0.05));
  const a = analyzeNoise(x, rate);
  assert.ok(a.quiet !== null, "тихий кусок найден");
  assert.ok(Math.abs(a.quiet!.start - 0.25) <= 0.06 && Math.abs(a.quiet!.end - 0.95) <= 0.06, `тихий кусок ${JSON.stringify(a.quiet)}`);
  const p = noiseProfile(a)!;
  assert.ok(p.start >= 0.2 && p.end <= 0.9 && p.end - p.start >= 0.3, `образец ${JSON.stringify(p)}: без щелчка и с запасом перед речью`);
  // тишина «после щелчка» короче 0,4 с — образца нет, и это честно: запасной режим
  const short = concat(noise(Math.round(0.15 * rate), 0.0017), click, noise(Math.round(0.3 * rate), 0.0017, 5), speech(2, rate, 0.05));
  assert.equal(noiseProfile(analyzeNoise(short, rate)), null);
});

test("порог гейта — от шума записи, в пределах −60…−36 dBFS; образец шума — без запаса перед речью, не длиннее 2 с", () => {
  assert.equal(gateThreshold(-58.5), 0.00355, "−58,5 dBFS + 9,5 дБ ≈ −49 dBFS");
  assert.equal(gateThreshold(-100), 0.001, "не ниже −60 dBFS");
  assert.equal(gateThreshold(-20), 0.0158, "не выше −36 dBFS");
  assert.deepEqual(noiseProfile({ floorDb: -58, quiet: { start: 0, end: 1.1 } }), { start: 0.05, end: 1 }, "запас 0,1 с до конца тишины");
  assert.deepEqual(noiseProfile({ floorDb: -58, quiet: { start: 0.3, end: 0.75 } }), { start: 0.3, end: 0.65 }, "как на записи владельца: щелчок до 0,3 с, речь с 0,75 с");
  assert.deepEqual(noiseProfile({ floorDb: -58, quiet: { start: 0, end: 3 } }), { start: 0.05, end: 2.05 }, "не длиннее 2 с");
  assert.equal(noiseProfile({ floorDb: -58, quiet: { start: 0.4, end: 0.75 } }), null, "после запаса короче 0,3 с");
  assert.equal(noiseProfile({ floorDb: -58, quiet: null }), null);
});

test("цепочка: гребёнка режекторов до шумоподавителя, образец шума через asendcmd, компенсация задержки, гейт и громкость в конце", () => {
  const withProfile = buildCleanChain({ profile: { start: 0.05, end: 0.7 }, gate: 0.004 });
  assert.equal(withProfile[0], "highpass=f=80");
  const notches = withProfile.filter((f) => f.startsWith("bandreject="));
  assert.equal(notches.length, COMB_KHZ.length);
  assert.ok(notches.includes("bandreject=f=5000:t=h:w=24") && notches.includes("bandreject=f=23000:t=h:w=24"));
  assert.ok(!notches.some((f) => f.includes("f=1000:") || f.includes("f=7000:")), "слабые линии 1 и 7 кГц не трогаем");
  const at = (re: RegExp) => withProfile.findIndex((f) => re.test(f));
  assert.ok(at(/^bandreject=f=23000/) < at(/^asendcmd/) && at(/^asendcmd/) < at(/^afftdn/), "режекторы → образец → шумоподавитель");
  assert.ok(withProfile.some((f) => f === "asendcmd=c='0.05 afftdn sn start;0.7 afftdn sn stop'"));
  assert.ok(withProfile.includes("afftdn=nr=20:nf=-50:gs=10:tn=0"));
  assert.ok(at(/^afftdn/) < at(/^atrim=start_sample=1200$/) && at(/^atrim/) < at(/^apad=pad_len=1200$/) && at(/^apad/) < at(/^agate/), "задержка шумоподавителя снимается сразу за ним");
  assert.equal(AFFTDN_DELAY, 1200);
  assert.match(withProfile.find((f) => f.startsWith("agate="))!, /^agate=threshold=0\.004:ratio=4:attack=8:release=260:range=0\.06/);
  assert.match(withProfile.at(-1)!, /^loudnorm=I=-16/);
  // без тишины в начале — слежение за шумом, образца нет
  const track = buildCleanChain({ profile: null, gate: 0.004 });
  assert.ok(track.includes("afftdn=nr=14:nf=-52:tn=1:gs=10"));
  assert.ok(!track.some((f) => f.startsWith("asendcmd")));
  assert.ok(!track.some((f) => /equalizer|acompressor|deesser/.test(f)), "студийных добавок нет — на C-1U они подтягивают шум");
});

const fakeDeps = (over: Partial<CleanDeps> = {}) => {
  const calls: string[][] = [];
  const deps: CleanDeps = {
    ffmpegPath: "ffmpeg",
    decode: async () => ({ samples: concat(noise(14400, 0.0017), speech(2, 16000, 0.05)), rate: 16000 }),
    run: async (_c, args) => {
      calls.push(args);
      writeFileSync(args[args.length - 1]!, "чистый");
      return { ok: true, stderr: "" };
    },
    ...over,
  };
  return { deps, calls };
};

test("cleanVoice: пишет во временный файл и переименовывает, рядом описание; сбой ffmpeg не оставляет мусора", async () => {
  const dir = tmp("rf-clean-");
  try {
    const src = join(dir, "озвучка.wav");
    writeFileSync(src, "оригинал");
    const dst = cleanedPath(dir, "озвучка.wav");
    assert.ok(dst.replace(/\\/g, "/").endsWith("/.rm/clean/озвучка.wav"));
    const { deps, calls } = fakeDeps();
    const info = await cleanVoice(src, dst, deps);
    assert.equal(info.mode, "profile");
    assert.ok(info.profile && info.profile.end >= 0.7 && info.profile.end <= 0.85, `образец ${JSON.stringify(info.profile)}`);
    assert.equal(readFileSync(dst, "utf8"), "чистый");
    assert.ok(!existsSync(dst.replace(/\.wav$/, ".tmp.wav")), "временный файл переименован");
    const args = calls[0]!;
    assert.equal(args[args.indexOf("-i") + 1], src);
    assert.ok(args[args.indexOf("-af") + 1]!.includes("bandreject=f=5000"));
    assert.deepEqual(args.slice(args.indexOf("-ar"), args.indexOf("-ar") + 4), ["-ar", "48000", "-c:a", "pcm_s24le"]);
    assert.equal((await readCleanInfo(dir, "озвучка.wav"))?.version, CLEAN_VERSION);

    // нет тишины в начале → слежение за шумом
    const loud = fakeDeps({ decode: async () => ({ samples: speech(3, 16000, 0.05), rate: 16000 }) });
    assert.equal((await cleanVoice(src, dst, loud.deps)).mode, "track");

    // ffmpeg упал: исключение с понятным текстом, старая копия цела, временного файла нет
    const bad = fakeDeps({
      run: async (_c, args) => {
        writeFileSync(args[args.length - 1]!, "обрывок");
        return { ok: false, stderr: "Error opening filters!\n" };
      },
    });
    await assert.rejects(cleanVoice(src, dst, bad.deps), /очистка «озвучка\.wav»: Error opening filters!/);
    assert.equal(readFileSync(dst, "utf8"), "чистый");
    assert.ok(!existsSync(dst.replace(/\.wav$/, ".tmp.wav")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("запасной образец: хороший образец записи сохраняется по микрофону и спасает запись без тишины", async () => {
  const dir = tmp("rf-clean-stored-");
  try {
    const noiseDir = join(dir, "noise");
    const src = join(dir, "озвучка.wav");
    writeFileSync(src, "оригинал");
    const mic = "Микрофон (2- C-1U)";
    assert.equal(micSlug(mic), "микрофон_2_c_1u");
    assert.equal(micSlug("???"), "default");
    assert.equal(defaultNoiseDir("C:/ReelsMaker/inbox").replace(/\\/g, "/"), "C:/ReelsMaker/noise");

    // 1) запись с тишиной: образец шума — из неё, и он сохраняется для микрофона
    const first = fakeDeps({ noiseDir });
    const info1 = await cleanVoice(src, join(dir, ".rm", "clean", "озвучка.wav"), first.deps, { mic });
    assert.equal(info1.mode, "profile");
    assert.equal(info1.mic, mic);
    const saved = await readNoiseSample(noiseDir, mic);
    assert.ok(saved && saved.seconds >= 0.5, `сохранён образец ${JSON.stringify(saved)}`);
    const ex = first.calls.find((c) => c.includes("-ss"))!;
    assert.deepEqual([ex[ex.indexOf("-ss") + 1], ex[ex.indexOf("-t") + 1]], ["0.05", String(saved!.seconds)], "вырезан именно тихий кусок");

    // 2) запись БЕЗ тишины, тот же микрофон: образец подклеивается перед записью
    const noSilence = fakeDeps({ noiseDir, decode: async () => ({ samples: speech(3, 16000, 0.05), rate: 16000 }) });
    const info2 = await cleanVoice(src, join(dir, ".rm", "clean", "озвучка 2.wav"), noSilence.deps, { mic });
    assert.equal(info2.mode, "stored");
    const args = noSilence.calls[0]!;
    assert.deepEqual(args.filter((_, i) => args[i - 1] === "-i"), [saved!.file, src], "вход 0 — образец, вход 1 — запись");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    assert.match(graph, /\[n\]\[s\]concat=n=2:v=0:a=1,highpass=f=80,bandreject=f=2000/, "образец клеится перед записью, до фильтров");
    assert.ok(graph.includes(`atrim=start_sample=${AFFTDN_DELAY + Math.round(saved!.seconds * 48000)}`), "после обработки срезаются и образец, и задержка");
    assert.ok(graph.endsWith("[o]") && args[args.indexOf("-map") + 1] === "[o]");
    assert.equal(buildStoredGraph({ seconds: 1, gate: 0.004 }).includes("asendcmd=c='0.05 afftdn sn start;0.95 afftdn sn stop'"), true);

    // 3) другой микрофон или микрофон неизвестен — чужой образец не берём: запасной режим
    assert.equal((await cleanVoice(src, join(dir, "c1.wav"), fakeDeps({ noiseDir, decode: noSilence.deps.decode }).deps, { mic: "Другой микрофон" })).mode, "track");
    assert.equal((await cleanVoice(src, join(dir, "c2.wav"), fakeDeps({ noiseDir, decode: noSilence.deps.decode }).deps)).mode, "track");
    // нет папки образцов вовсе — тоже track
    assert.equal((await cleanVoice(src, join(dir, "c3.wav"), fakeDeps({ decode: noSilence.deps.decode }).deps, { mic })).mode, "track");

    // 4) короткий образец не затирает более длинный
    const shortTake = fakeDeps({ noiseDir, decode: async () => ({ samples: concat(noise(Math.round(0.6 * 16000), 0.0017), speech(2, 16000, 0.05)), rate: 16000 }) });
    const before = (await readNoiseSample(noiseDir, mic))!.seconds;
    await cleanVoice(src, join(dir, "c4.wav"), shortTake.deps, { mic });
    assert.ok((await readNoiseSample(noiseDir, mic))!.seconds >= before - 1e-9, "образец не стал короче");
    // сбой сохранения образца запись не отменяет
    const flakySave = fakeDeps({
      noiseDir: join(dir, "noise2"),
      run: async (_c, a) => {
        if (a.includes("-ss")) return { ok: false, stderr: "нет места" };
        writeFileSync(a[a.length - 1]!, "чистый");
        return { ok: true, stderr: "" };
      },
    });
    assert.equal((await cleanVoice(src, join(dir, "c5.wav"), flakySave.deps, { mic })).mode, "profile");
    assert.equal(await readNoiseSample(join(dir, "noise2"), mic), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("чистая копия свежая, пока оригинал тот же и версия цепочки та же; разбор сюжета берёт звук из чистой копии", async () => {
  const dir = tmp("rf-clean-scan-");
  try {
    for (const f of ["голова.mp4", "озвучка.wav", "озвучка 2.wav"]) writeFileSync(join(dir, f), "x");
    const probe = async (_p: string, file: string) => ({ duration: 8, hasAudio: true, width: file.endsWith(".wav") ? null : 1080, height: file.endsWith(".wav") ? null : 1920 });
    const opts = { ffprobePath: "ffprobe", probe };
    await writeMeta(dir, { sources: { talk: "голова.mp4" } });
    let m = await scanMontage(dir, "s", opts);
    assert.equal(m.cleanOn, true, "очистка включена по умолчанию");
    assert.deepEqual(m.voices.map((v) => v.clean), ["stale", "stale"]);
    assert.ok(m.voices.every((v) => v.file === v.src.file), "копии нет — звук с оригинала");

    const { deps, calls } = fakeDeps();
    const first = await ensureClean(m, deps);
    assert.deepEqual(first.done.sort(), ["озвучка 2.wav", "озвучка.wav"]);
    assert.deepEqual(first.modes, { "озвучка 2.wav": "profile", "озвучка.wav": "profile" });
    m = await scanMontage(dir, "s", opts);
    assert.deepEqual(m.voices.map((v) => v.clean), ["ready", "ready"]);
    for (const v of m.voices) assert.equal(v.file, cleanedPath(dir, v.src.name), "звук — из чистой копии");
    assert.equal(m.voices[0]!.src.file, join(dir, m.voices[0]!.src.name), "оригинал и расшифровка — от оригинала");

    // повторно ничего не делаем; force — пересчитываем всё
    calls.length = 0;
    assert.deepEqual((await ensureClean(m, deps)).done, []);
    assert.equal((await ensureClean(m, deps, { force: true })).done.length, 2);

    // оригинал изменился → копия устарела
    writeFileSync(join(dir, "озвучка.wav"), "другой, подлиннее");
    assert.equal(await isCleanFresh(dir, "озвучка.wav"), false);
    assert.equal(await isCleanFresh(dir, "озвучка 2.wav"), true);
    // версия цепочки сменилась → устарела
    const side = cleanedPath(dir, "озвучка 2.wav").replace(/\.wav$/, ".json");
    writeFileSync(side, JSON.stringify({ ...JSON.parse(readFileSync(side, "utf8")), version: CLEAN_VERSION + 1 }));
    assert.equal(await isCleanFresh(dir, "озвучка 2.wav"), false);

    // сбой одной записи не останавливает остальные
    m = await scanMontage(dir, "s", opts);
    const flaky = fakeDeps({
      run: async (_c, args) => {
        if (args.includes(join(dir, "озвучка.wav"))) return { ok: false, stderr: "сбой" };
        writeFileSync(args[args.length - 1]!, "чистый");
        return { ok: true, stderr: "" };
      },
    });
    const r = await ensureClean(m, flaky.deps);
    assert.deepEqual(r.done, ["озвучка 2.wav"]);
    assert.equal(r.failed[0]!.name, "озвучка.wav");
    assert.match(r.failed[0]!.error, /сбой/);

    // очистка выключена: оригиналы, ensureClean ничего не делает
    await writeMeta(dir, { sources: { talk: "голова.mp4" }, voiceClean: false });
    m = await scanMontage(dir, "s", opts);
    assert.equal(m.cleanOn, false);
    assert.deepEqual(m.voices.map((v) => v.clean), ["off", "off"]);
    assert.ok(m.voices.every((v) => v.file === v.src.file));
    assert.deepEqual(await ensureClean(m, deps, { force: true }), { done: [], failed: [], modes: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── настоящий ffmpeg ─────────────────────────

const ffmpeg = process.env["RF_FFMPEG_PATH"] || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

/** WAV PCM 24 бит моно. */
function wav24(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 3);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 3, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 3, 28);
  buf.writeUInt16LE(3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 3, 40);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 8388607);
    buf.writeIntLE(x, 44 + i * 3, 3);
  }
  return buf;
}

/** Читает 24-битный wav (в т.ч. extensible от ffmpeg): ищет чанк data. */
function readWav24(file: string): Float32Array {
  const b = readFileSync(file);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - o - 8) / 3);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readIntLE(o + 8 + i * 3, 3) / 8388607;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("нет data");
}

/** Амплитуда на частоте f (Герцель) на участке [from, to) с. */
function tone(x: Float32Array, rate: number, f: number, from: number, to: number): number {
  const a = x.subarray(Math.round(from * rate), Math.round(to * rate));
  const w = 2 * Math.PI * f / rate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < a.length; i++) {
    re += a[i]! * Math.cos(w * i);
    im += a[i]! * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / a.length;
}

test("настоящий ffmpeg: линии гребёнки вырезаются, длина и тайминг сохраняются, образец шума берётся из тишины", { skip: !hasFfmpeg && "нет ffmpeg", timeout: 120_000 }, async () => {
  const dir = tmp("rf-clean-real-");
  try {
    const rate = 48000;
    // 1,2 с тишины (шум + линии USB 3, 5, 9 кГц, как у C-1U) и 4 с «речи» на том же фоне
    const total = Math.round(5.2 * rate);
    const interference = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      interference[i] = 0.004 * (Math.sin(2 * Math.PI * 3000 * t) + Math.sin(2 * Math.PI * 5000 * t) + Math.sin(2 * Math.PI * 9000 * t));
    }
    const hiss = noise(total, 0.0015);
    const voice = concat(new Float32Array(Math.round(1.2 * rate)), speech(4, rate, 0.12));
    const x = new Float32Array(total);
    for (let i = 0; i < total; i++) x[i] = voice[i]! + interference[i]! + hiss[i]!;
    const src = join(dir, "озвучка.wav");
    writeFileSync(src, wav24(x, rate));
    const dst = cleanedPath(dir, "озвучка.wav");
    const info = await cleanVoice(src, dst, { ffmpegPath: ffmpeg });
    assert.equal(info.mode, "profile", "тишина в начале найдена");
    assert.ok(info.profile!.end >= 0.95 && info.profile!.end <= 1.15, `образец ${JSON.stringify(info.profile)}`);

    const y = readWav24(dst);
    assert.ok(Math.abs(y.length - x.length) <= rate * 0.002, `длина ${y.length} против ${x.length}`);
    assert.equal(statSync(dst).size > 100000, true);

    // линия 5 кГц относительно соседних частот в тишине: в оригинале торчит, в чистой копии нет (после выравнивания громкости сравниваем отношения)
    const ratio = (s: Float32Array) => 20 * Math.log10(tone(s, rate, 5000, 0.2, 1.0) / ((tone(s, rate, 4700, 0.2, 1.0) + tone(s, rate, 5300, 0.2, 1.0)) / 2));
    const before = ratio(x);
    const after = ratio(y);
    assert.ok(before > 15, `в оригинале линия торчит на ${before.toFixed(1)} дБ`);
    assert.ok(before - after > 12, `линия должна упасть: было ${before.toFixed(1)} дБ, стало ${after.toFixed(1)} дБ`);

    // тайминг: речь начинается в тот же момент (задержку шумоподавителя 25 мс сняли)
    const seg = (s: Float32Array) => s.subarray(Math.round(1.5 * rate), Math.round(2.5 * rate));
    const a = seg(x);
    const b = seg(y);
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -300; lag <= 300; lag += 2) {
      let dot = 0;
      for (let i = 400; i < a.length - 400; i += 2) dot += a[i]! * b[i + lag]!;
      if (dot > best) {
        best = dot;
        bestLag = lag;
      }
    }
    assert.ok(Math.abs(bestLag) <= 96, `сдвиг ${bestLag} отсчётов (${((bestLag / rate) * 1000).toFixed(1)} мс), без компенсации было бы 1200`);

    // ── запись БЕЗ тишины на том же микрофоне: образец от прошлой записи, результат почти как со своей тишиной ──
    const noiseDir = join(dir, "noise");
    const mic = "Микрофон (тест)";
    await cleanVoice(src, join(dir, ".rm", "clean", "озвучка.wav"), { ffmpegPath: ffmpeg, noiseDir }, { mic });
    assert.ok(await readNoiseSample(noiseDir, mic), "образец сохранён");
    // вторая запись: та же помеха, речь с самого начала
    const total2 = Math.round(4 * rate);
    const x2 = new Float32Array(total2);
    const v2 = speech(4, rate, 0.12);
    const hiss2 = noise(total2, 0.0015, 999);
    for (let i = 0; i < total2; i++) x2[i] = v2[i]! + interference[i % interference.length]! + hiss2[i]!;
    const src2 = join(dir, "озвучка 2.wav");
    writeFileSync(src2, wav24(x2, rate));
    const dst2 = cleanedPath(dir, "озвучка 2.wav");
    const info2 = await cleanVoice(src2, dst2, { ffmpegPath: ffmpeg, noiseDir }, { mic });
    assert.equal(info2.mode, "stored", "тишины в начале нет — взят образец микрофона");
    const y2 = readWav24(dst2);
    assert.ok(Math.abs(y2.length - x2.length) <= rate * 0.002, `длина ${y2.length} против ${x2.length}: подклеенный образец срезан`);
    // линия 5 кГц на паузе нет (речь с первой секунды), поэтому сравниваем во всей записи: относительно соседних частот линия должна упасть
    const ratio2 = (s: Float32Array) => 20 * Math.log10(tone(s, rate, 5000, 0.5, 3.5) / ((tone(s, rate, 4700, 0.5, 3.5) + tone(s, rate, 5300, 0.5, 3.5)) / 2));
    assert.ok(ratio2(x2) - ratio2(y2) > 10, `линия должна упасть: было ${ratio2(x2).toFixed(1)} дБ, стало ${ratio2(y2).toFixed(1)} дБ`);
    // начало записи — речь: тайминг не съехал (образец срезан точно)
    const a2 = x2.subarray(Math.round(0.5 * rate), Math.round(1.5 * rate));
    const b2 = y2.subarray(Math.round(0.5 * rate), Math.round(1.5 * rate));
    let lag2 = 0;
    let best2 = -Infinity;
    for (let lag = -300; lag <= 300; lag += 2) {
      let dot = 0;
      for (let i = 400; i < a2.length - 400; i += 2) dot += a2[i]! * b2[i + lag]!;
      if (dot > best2) {
        best2 = dot;
        lag2 = lag;
      }
    }
    assert.ok(Math.abs(lag2) <= 96, `сдвиг ${lag2} отсчётов (${((lag2 / rate) * 1000).toFixed(1)} мс)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});