// Очистка озвучки: «чистая» копия записи лежит рядом с оригиналом (<сюжет>/.rm/clean/<имя>.wav), оригинал не трогается.
// Звук в роликах идёт из чистой копии, расшифровка и реплики — по оригиналу (тайминг сохраняется с точностью до отсчёта).
//
// Цепочка собрана под USB-микрофон Behringer C-1U (проверено на записях владельца):
//  1. highpass 80 Гц — гул;
//  2. узкие режекторы на каждом килогерце 2–23 кГц — помехи шины USB (частота кадров 1 кГц) дают «гребёнку» тональных линий,
//     слышную как писк и дребезжание; обычные шумоподавители их не берут;
//  3. afftdn по ОБРАЗЦУ шума. Образец — по убыванию надёжности:
//       profile — тихий кусок в начале ЭТОЙ записи (самый длинный в первых 3 с: щелчок от кнопки записи не мешает);
//       stored  — образец, сохранённый с прошлой хорошей записи на ТОМ ЖЕ микрофоне (шум шины стационарен, образец работает так же
//                 хорошо; подклеивается перед записью и срезается после обработки) — спасает запись, где забыли помолчать;
//       track   — образца нет совсем: шум отслеживается на ходу (заметно слабее: на записи владельца запас речь/шум 38 против 51 дБ);
//  4. глубокий гейт в паузах, порог — от измеренного уровня шума записи;
//  5. выравнивание громкости (loudnorm, −16 LUFS).
// Студийные добавки (эквалайзер, компрессор) нарочно не включены: на этом микрофоне они подтягивают остаточный шум.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { run as coreRun } from "@reels-factory/core";
import type { MontageScan } from "./montage.ts";

const execFileP = promisify(execFile);

/** Менять при любом изменении цепочки: чистые копии с другой версией считаются устаревшими и пересчитываются. */
export const CLEAN_VERSION = 3;
export const CLEAN_SUBDIR = [".rm", "clean"] as const;
/** Линии помех шины USB (кратные 1 кГц) — те, что заметно выше фона на записи с C-1U. */
export const COMB_KHZ: readonly number[] = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23];
/** afftdn выдаёт звук с задержкой 1200 отсчётов (25 мс при 48 кГц); без компенсации чистая копия отстаёт от оригинала. */
export const AFFTDN_DELAY = 1200;
const RATE = 48000;

/** Папка сохранённых образцов шума микрофонов: рядом с папкой входа, в папке данных (<RF_DATA_DIR>/noise). */
export function defaultNoiseDir(inboxDir: string): string {
  return join(dirname(inboxDir), "noise");
}

/** Путь чистой копии озвучки (всегда wav, имя — как у оригинала). */
export function cleanedPath(dir: string, name: string): string {
  return join(dir, ...CLEAN_SUBDIR, name.replace(/\.[^./\\]+$/, "") + ".wav");
}
const sidecarOf = (wav: string) => wav.replace(/\.wav$/, ".json");
/** Все файлы, принадлежащие чистой копии: звук и описание. */
export function cleanedFiles(dir: string, name: string): string[] {
  const wav = cleanedPath(dir, name);
  return [wav, sidecarOf(wav)];
}

export interface CleanInfo {
  version: number;
  /** profile — образец из тишины этой записи; stored — образец прошлой записи этого микрофона; track — образца нет */
  mode: "profile" | "stored" | "track";
  profile: { start: number; end: number } | null;
  /** уровень шума записи, dBFS (10-й процентиль 50-мс кусков) */
  floorDb: number;
  /** порог гейта, линейный */
  gate: number;
  /** микрофон записи (метка устройства), если известен */
  mic?: string | null;
  source: { size: number; mtimeMs: number };
}

// ───────────────────────────── анализ шума ─────────────────────────────

export interface NoiseAnalysis {
  floorDb: number;
  /** самый длинный тихий кусок в первых 3 с, начинающийся не позже 1,5 с (щелчок от кнопки записи в начале не мешает); null — тишины нет */
  quiet: { start: number; end: number } | null;
}

const FRAME_SEC = 0.05;
/** Запас до конца тишины: кадр с началом речи уже отсечён порогом, запас — на плавный выход на уровень. Больше нельзя: на реальных записях тихий кусок бывает всего 0,45 с. */
const PROFILE_MARGIN = 0.1;
/** Образец короче не годится (afftdn нужны хотя бы несколько окон). */
const MIN_PROFILE = 0.3;

/** Уровень шума записи и самый длинный тихий кусок в начале. samples — моно, −1…1. */
export function analyzeNoise(samples: ArrayLike<number>, rate: number): NoiseAnalysis {
  const n = Math.max(1, Math.floor(rate * FRAME_SEC));
  const frames = Math.floor(samples.length / n);
  const db: number[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * n; i < (f + 1) * n; i++) sum += (samples[i] as number) ** 2;
    db.push(20 * Math.log10(Math.max(Math.sqrt(sum / n), 1e-6)));
  }
  if (db.length === 0) return { floorDb: -120, quiet: null };
  const sorted = [...db].sort((a, b) => a - b);
  const floorDb = sorted[Math.floor(sorted.length * 0.1)] as number;
  // тихий кусок = кадры в пределах 6 дБ от пола шума; берём самый длинный из начинающихся в первые 1,5 с
  const limit = Math.min(db.length, Math.round(3 / FRAME_SEC));
  const startLimit = Math.round(1.5 / FRAME_SEC);
  let best: { from: number; to: number } | null = null;
  let from = -1;
  for (let i = 0; i <= limit; i++) {
    const quiet = i < limit && (db[i] as number) <= floorDb + 6;
    if (quiet && from < 0) from = i;
    if (!quiet && from >= 0) {
      if (from <= startLimit && (!best || i - from > best.to - best.from)) best = { from, to: i };
      from = -1;
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const quiet = best && (best.to - best.from) * FRAME_SEC >= MIN_PROFILE + PROFILE_MARGIN ? { start: r2(best.from * FRAME_SEC), end: r2(best.to * FRAME_SEC) } : null;
  return { floorDb: Math.round(floorDb * 10) / 10, quiet };
}

/** Порог гейта (линейный): на 9,5 дБ выше шума записи, в пределах −60…−36 dBFS. */
export function gateThreshold(floorDb: number): number {
  const lin = 10 ** ((floorDb + 9.5) / 20);
  return Math.round(Math.min(0.0158, Math.max(0.001, lin)) * 100000) / 100000;
}

/** Образец шума — тихий кусок записи без щелчка в начале и без запаса перед речью, не длиннее 2 с; тишины нет — null. */
export function noiseProfile(a: NoiseAnalysis): { start: number; end: number } | null {
  if (!a.quiet) return null;
  const start = Math.max(a.quiet.start, 0.05);
  const end = Math.round(Math.min(a.quiet.end - PROFILE_MARGIN, start + 2) * 100) / 100;
  return end - start >= MIN_PROFILE - 1e-9 ? { start, end } : null;
}

// ───────────────────────────── цепочка ffmpeg ─────────────────────────────

const preChain = (): string[] => ["highpass=f=80", ...COMB_KHZ.map((k) => `bandreject=f=${k * 1000}:t=h:w=24`)];
const learn = (p: { start: number; end: number }) => [`asendcmd=c='${p.start} afftdn sn start;${p.end} afftdn sn stop'`, "afftdn=nr=20:nf=-50:gs=10:tn=0"];
/** Хвост цепочки. lead — сколько отсчётов подклеенного перед записью образца срезать (0 — ничего не клеили). */
const postChain = (gate: number, lead: number): string[] => [
  // задержка шумоподавителя: срезаем её (и подклеенный образец) с начала и добавляем тишины в конец — длина и тайминг как у оригинала
  `atrim=start_sample=${AFFTDN_DELAY + lead}`,
  "asetpts=PTS-STARTPTS",
  `apad=pad_len=${AFFTDN_DELAY}`,
  `agate=threshold=${gate}:ratio=4:attack=8:release=260:range=0.06:knee=3`,
  "loudnorm=I=-16:TP=-1.5:LRA=11",
];

export function buildCleanChain(opts: { profile: { start: number; end: number } | null; gate: number }): string[] {
  return [...preChain(), ...(opts.profile ? learn(opts.profile) : ["afftdn=nr=14:nf=-52:tn=1:gs=10"]), ...postChain(opts.gate, 0)];
}

/** filter_complex для режима stored: [0] — сохранённый образец, [1] — запись; образец клеится перед записью и срезается после обработки. */
export function buildStoredGraph(opts: { seconds: number; gate: number }): string {
  const tail = Math.max(MIN_PROFILE, opts.seconds - 0.05);
  const chain = [...preChain(), ...learn({ start: 0.05, end: Math.round(tail * 100) / 100 }), ...postChain(opts.gate, Math.round(opts.seconds * RATE))];
  return (
    "[0:a]aresample=48000,aformat=channel_layouts=mono[n];[1:a]aresample=48000,aformat=channel_layouts=mono[s];" +
    `[n][s]concat=n=2:v=0:a=1,${chain.join(",")}[o]`
  );
}

/**
 * filter_complex ЖИВОГО потока (программа в трее, виртуальный микрофон): [0] — образец шума (файл), [1] — микрофон в реальном времени.
 * Образец проходит цепочку первым, afftdn учится на нём, затем срезается; дальше идёт живой звук с задержкой одной обработки (~25 мс).
 * От файловой цепочки отличается хвостом: нет loudnorm и apad (поток бесконечный), вместо них фиксированное усиление и лимитер.
 */
export function buildLiveGraph(opts: { noiseSeconds: number; gate: number; gainDb: number }): string {
  const tail = Math.max(MIN_PROFILE, opts.noiseSeconds - 0.05);
  const lead = Math.round(opts.noiseSeconds * RATE) + AFFTDN_DELAY;
  const chain = [
    ...preChain(),
    ...learn({ start: 0.05, end: Math.round(tail * 100) / 100 }),
    `atrim=start_sample=${lead}`,
    "asetpts=PTS-STARTPTS",
    `agate=threshold=${opts.gate}:ratio=4:attack=8:release=260:range=0.06:knee=3`,
    `volume=${opts.gainDb}dB`,
    "alimiter=limit=0.95:level=disabled",
  ];
  return (
    "[0:a]aresample=48000,aformat=channel_layouts=mono[n];[1:a]aresample=48000,aformat=channel_layouts=mono[s];" +
    `[n][s]concat=n=2:v=0:a=1,${chain.join(",")}[o]`
  );
}

// ───────────────────────────── сохранённые образцы шума ─────────────────────────────

/** Имя файла образца по метке микрофона: буквы и цифры, остальное — «_». */
export function micSlug(label: string): string {
  const s = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return s || "default";
}

export interface NoiseSample {
  file: string;
  seconds: number;
}

export async function readNoiseSample(noiseDir: string, mic: string): Promise<NoiseSample | null> {
  const file = join(noiseDir, micSlug(mic) + ".wav");
  try {
    const meta = JSON.parse(await readFile(file.replace(/\.wav$/, ".json"), "utf8")) as { seconds?: number };
    await stat(file);
    return typeof meta.seconds === "number" && meta.seconds >= MIN_PROFILE ? { file, seconds: meta.seconds } : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── запуск ─────────────────────────────

export interface CleanDeps {
  ffmpegPath: string;
  /** где хранятся образцы шума микрофонов; не задана — запасного образца нет */
  noiseDir?: string;
  /** подмена для тестов: моно-отсчёты файла (−1…1) и их частота */
  decode?: (file: string) => Promise<{ samples: ArrayLike<number>; rate: number }>;
  /** подмена запуска ffmpeg (тесты) */
  run?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>;
}

export interface CleanOpts {
  /** метка микрофона записи — ключ сохранённого образца шума */
  mic?: string | null;
}

const DECODE_RATE = 16000;

export async function decodeMono(ffmpegPath: string, file: string): Promise<{ samples: Float32Array; rate: number }> {
  const { stdout } = await execFileP(ffmpegPath, ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(DECODE_RATE), "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 30,
  });
  const buf = stdout as Buffer;
  const ints = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 2)));
  const samples = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) samples[i] = (ints[i] as number) / 32768;
  return { samples, rate: DECODE_RATE };
}

/**
 * Делает чистую копию src → dst (wav 48 кГц, 24 бит). Пишет во временный файл и переименовывает — битой копии не остаётся.
 * Хороший образец шума этой записи (profile) заодно сохраняется как запасной для микрофона opts.mic.
 */
export async function cleanVoice(src: string, dst: string, deps: CleanDeps, opts: CleanOpts = {}): Promise<CleanInfo> {
  const { samples, rate } = await (deps.decode ?? ((f) => decodeMono(deps.ffmpegPath, f)))(src);
  const analysis = analyzeNoise(samples, rate);
  const profile = noiseProfile(analysis);
  const gate = gateThreshold(analysis.floorDb);
  const stored = !profile && opts.mic && deps.noiseDir ? await readNoiseSample(deps.noiseDir, opts.mic) : null;
  const mode: CleanInfo["mode"] = profile ? "profile" : stored ? "stored" : "track";
  await mkdir(dirname(dst), { recursive: true });
  const tmp = dst.replace(/\.wav$/, ".tmp.wav");
  const out = ["-ar", "48000", "-c:a", "pcm_s24le", tmp];
  const args =
    mode === "stored"
      ? ["-hide_banner", "-loglevel", "error", "-y", "-i", stored!.file, "-i", src, "-filter_complex", buildStoredGraph({ seconds: stored!.seconds, gate }), "-map", "[o]", ...out]
      : ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-af", buildCleanChain({ profile, gate }).join(","), ...out];
  const runner = deps.run ?? ((c, a) => coreRun(c, a, { timeout: 10 * 60_000 }));
  const res = await runner(deps.ffmpegPath, args);
  if (!res.ok) {
    await rm(tmp, { force: true });
    throw new Error(`очистка «${src.split(/[\\/]/).pop()}»: ${res.stderr.trim().split(/\r?\n/).pop() ?? "ffmpeg"}`);
  }
  await rename(tmp, dst);
  const st = await stat(src);
  const info: CleanInfo = {
    version: CLEAN_VERSION,
    mode,
    profile,
    floorDb: analysis.floorDb,
    gate,
    mic: opts.mic ?? null,
    source: { size: st.size, mtimeMs: st.mtimeMs },
  };
  await writeFile(sidecarOf(dst), JSON.stringify(info, null, 2), "utf8");
  if (profile && opts.mic && deps.noiseDir) await saveNoiseSample(src, profile, opts.mic, deps, runner).catch(() => {});
  return info;
}

/** Сохраняет тихий кусок записи как образец шума микрофона. Не затирает более длинный образец коротким. */
async function saveNoiseSample(
  src: string,
  profile: { start: number; end: number },
  mic: string,
  deps: CleanDeps,
  runner: (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>,
): Promise<void> {
  const noiseDir = deps.noiseDir!;
  const seconds = Math.round((profile.end - profile.start) * 100) / 100;
  const old = await readNoiseSample(noiseDir, mic);
  if (old && old.seconds >= seconds) return;
  await mkdir(noiseDir, { recursive: true });
  const wav = join(noiseDir, micSlug(mic) + ".wav");
  const tmp = wav.replace(/\.wav$/, ".tmp.wav");
  const res = await runner(deps.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(profile.start), "-t", String(seconds), "-i", src, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le", tmp]);
  if (!res.ok) {
    await rm(tmp, { force: true });
    return;
  }
  await rename(tmp, wav);
  await writeFile(wav.replace(/\.wav$/, ".json"), JSON.stringify({ mic, seconds, from: src.split(/[\\/]/).pop(), savedAt: new Date().toISOString() }, null, 2), "utf8");
}

/** Чистая копия есть, сделана той же версией цепочки и с этого же файла (размер и время изменения совпадают). */
export async function isCleanFresh(dir: string, name: string): Promise<boolean> {
  const wav = cleanedPath(dir, name);
  try {
    const [info, src, out] = await Promise.all([readFile(sidecarOf(wav), "utf8").then((t) => JSON.parse(t) as CleanInfo), stat(join(dir, name)), stat(wav)]);
    return out.size > 0 && info.version === CLEAN_VERSION && info.source.size === src.size && info.source.mtimeMs === src.mtimeMs;
  } catch {
    return false;
  }
}

/** Описание чистой копии (режим, образец шума) или null. */
export async function readCleanInfo(dir: string, name: string): Promise<CleanInfo | null> {
  try {
    return JSON.parse(await readFile(sidecarOf(cleanedPath(dir, name)), "utf8")) as CleanInfo;
  } catch {
    return null;
  }
}

const MODE_TEXT: Record<CleanInfo["mode"], (i: CleanInfo) => string> = {
  profile: (i) => `шум по образцу тишины ${i.profile!.start}–${i.profile!.end} с`,
  stored: () => "тишины в начале нет — шум по образцу прошлой записи этого микрофона",
  track: () => "тишины в начале нет и образца микрофона нет — шум отслеживается на ходу (слабее)",
};

/**
 * Делает недостающие (или все при force) чистые копии озвучек сюжета. Только если очистка включена (story.json → voiceClean не false).
 * Сбой одной записи не останавливает остальные: вернётся список ошибок.
 */
export async function ensureClean(
  scan: MontageScan,
  deps: CleanDeps,
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<{ done: string[]; failed: { name: string; error: string }[]; modes: Record<string, CleanInfo["mode"]> }> {
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const modes: Record<string, CleanInfo["mode"]> = {};
  if (!scan.cleanOn) return { done, failed, modes };
  for (const v of scan.voices) {
    if (!opts.force && v.clean === "ready") continue;
    opts.log?.(`очистка озвучки ${v.src.name}…`);
    try {
      const info = await cleanVoice(v.src.file, cleanedPath(scan.dir, v.src.name), deps, { mic: v.mic });
      opts.log?.(`${v.src.name}: ${MODE_TEXT[info.mode](info)}, уровень шума ${info.floorDb} dBFS`);
      done.push(v.src.name);
      modes[v.src.name] = info.mode;
    } catch (e) {
      failed.push({ name: v.src.name, error: (e as Error).message });
    }
  }
  return { done, failed, modes };
}
