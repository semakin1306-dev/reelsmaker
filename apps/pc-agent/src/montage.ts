// Сюжет «из исходников»: основа (говорящая голова со звуком), дальний план (перебивки), скринкаст (вставки)
// и по желанию озвучка — отдельные аудиофайлы (дублей может быть несколько), которые заменяют звук основы
// (основа тогда даёт только картинку). Звук видео можно отключить совсем (story.json → muteVideo).
// Роли — из story.json или по имени файла; реплики — из расшифровки основы; монтажный лист — edit.json в папке сюжета.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run as coreRun } from "@reels-factory/core";
import { cleanCrop, cropFilter, parseClipName, splitReplicas, type Crop, type EditList, type Replica, type Transcript } from "@reels-factory/render";
import { AUDIO_RE, probeClip, type ClipProbe } from "./probe.ts";
import { cleanedPath, isCleanFresh } from "./voice-clean.ts";
import { VIDEO_RE } from "./story.ts";
import { isTranscriptFresh, transcribeFiles, transcriptPath, writeTranscript, type SttConfig, type SttRun } from "./stt.ts";

export type SourceRole = "talk" | "wide" | "screen" | "voice";
export const SOURCE_ROLES: readonly SourceRole[] = ["talk", "wide", "screen", "voice"];
export const ROLE_TITLE: Record<SourceRole, string> = {
  talk: "основа (крупный, со звуком)",
  wide: "дальний план",
  screen: "скринкаст",
  voice: "озвучка (звук отдельным файлом)",
};

/** Настройки сюжета, которые правит владелец или агент: роли и кроп исходников. */
export const META_FILE = "story.json";
/** Монтажный лист агента. */
export const EDIT_FILE = "edit.json";
/** Рабочая папка: кадры для агента, его сессия. */
export const WORK_DIR = ".rm";

const ROLE_RE: Record<SourceRole, RegExp> = {
  talk: /крупн|голов|говор|основ|talk|close|a[-_ ]?roll/i,
  wide: /дальн|общ|wide|перебив|b[-_ ]?roll/i,
  screen: /экран|скрин|screen|интерфейс|record/i,
  voice: /озвуч|голос|аудио|звук|дикт|voice|audio|narrat/i,
};

/** Файл озвучки, записанный в интерфейсе: «озвучка.wav», «озвучка 2.wav»… */
export const VOICE_BASE = "озвучка";

/** Видео и аудио сюжета: аудио годится только как озвучка. */
export const SOURCE_RE = new RegExp(`${VIDEO_RE.source}|${AUDIO_RE.source}`, "i");

export function guessRole(name: string): SourceRole | null {
  if (AUDIO_RE.test(name)) return "voice";
  for (const role of SOURCE_ROLES) if (ROLE_RE[role].test(name)) return role;
  return null;
}

export interface StoryMeta {
  /** роли исходников; скринкастов и озвучек может быть несколько (массив имён) */
  sources?: Partial<Record<SourceRole, string | string[]>>;
  /** звук видео не нужен (владелец запишет озвучку сам): без озвучки ролик собирается без звука */
  muteVideo?: boolean;
  /** false — озвучки идут как записаны, без очистки (по умолчанию очистка включена: «чистая» копия в .rm/clean) */
  voiceClean?: boolean;
  /** микрофон записи (метка устройства) по имени файла озвучки: ключ сохранённого образца шума для очистки */
  voiceMic?: Record<string, string>;
  /**
   * буква озвучки по имени файла (a, b, c…): закреплена за файлом навсегда, чтобы удаление или перестановка дублей
   * не сдвигали id реплик в листе. Удалённые файлы остаются в списке — их буква не выдаётся заново.
   */
  voiceLetters?: Record<string, string>;
  /** сколько вариантов владелец хочет в итоге (агент берёт из brief) */
  count?: number;
  /** кроп по имени файла, в долях кадра; нет — весь кадр */
  crops?: Record<string, Crop>;
}

export async function readMeta(dir: string): Promise<StoryMeta> {
  try {
    return JSON.parse(await readFile(join(dir, META_FILE), "utf8")) as StoryMeta;
  } catch {
    return {};
  }
}

export async function writeMeta(dir: string, meta: StoryMeta): Promise<void> {
  await writeFile(join(dir, META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

/** Сюжет из исходников, если роли заданы в story.json или хоть одно видео без номера узнаётся по имени. */
export function isMontageStory(videoNames: readonly string[], meta: StoryMeta): boolean {
  if (meta.sources && Object.values(meta.sources).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))) return true;
  return videoNames.some((n) => !parseClipName(n) && guessRole(n) !== null && !AUDIO_RE.test(n));
}

export interface SourceInfo {
  name: string;
  file: string;
  role: SourceRole | null;
  probe: ClipProbe | null;
  /** кроп из story.json (владелец выбирает в интерфейсе) */
  crop: Crop | null;
}

/** Первая буква a–z, которой нет среди занятых (все заняты — z). */
export function nextVoiceLetter(used: Iterable<string>): string {
  const taken = new Set(used);
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(97 + i);
    if (!taken.has(l)) return l;
  }
  return "z";
}

/** Один файл озвучки: расшифровка и реплики со своей буквой (a, b, c… по порядку файлов). */
export interface VoiceTake {
  src: SourceInfo;
  /** файл, из которого берётся ЗВУК в роликах: чистая копия, если она готова, иначе оригинал */
  file: string;
  /** микрофон, на котором сделана запись (если запись сделана в интерфейсе) */
  mic: string | null;
  /** ready — чистая копия готова и используется; stale — нужна (нет или устарела); off — очистка выключена */
  clean: "ready" | "stale" | "off";
  letter: string;
  transcript: Transcript | null;
  fresh: boolean;
  replicas: Replica[];
}

export interface MontageScan {
  id: string;
  dir: string;
  sources: SourceInfo[];
  /** основная роль каждого вида; для скринкаста — первый из screens */
  roles: Partial<Record<SourceRole, SourceInfo>>;
  /** все скринкасты (подписаны именами файлов) */
  screens: SourceInfo[];
  /** сколько вариантов нужно (story.json), null — не задано */
  count: number | null;
  transcript: Transcript | null;
  transcriptFresh: boolean;
  replicas: Replica[];
  /** озвучки (если есть) по порядку: у каждой своя расшифровка и реплики a01…, b01… — источник звука вместо основы */
  voices: VoiceTake[];
  /** реплики всех озвучек подряд (у каждой source — файл) */
  voiceReplicas: Replica[];
  /** звук видео отключён владельцем */
  mute: boolean;
  /** очистка озвучки включена (story.json → voiceClean не false) */
  cleanOn: boolean;
  edit: EditList | null;
  /** ошибка чтения edit.json */
  editError: string | null;
  problems: string[];
}

export interface MontageScanOptions {
  ffprobePath: string;
  probe?: typeof probeClip;
}

export async function scanMontage(dir: string, id: string, opts: MontageScanOptions): Promise<MontageScan> {
  const probe = opts.probe ?? probeClip;
  const meta = await readMeta(dir);
  const names = (await readdir(dir)).filter((f) => SOURCE_RE.test(f)).sort((a, b) => a.localeCompare(b, "ru"));
  const problems: string[] = [];
  const sources: SourceInfo[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const p = await probe(opts.ffprobePath, file);
    if (!p) problems.push(`${name}: ffprobe не прочитал файл`);
    sources.push({ name, file, role: null, probe: p, crop: cleanCrop(meta.crops?.[name]) });
  }
  const roles: Partial<Record<SourceRole, SourceInfo>> = {};
  const screens: SourceInfo[] = [];
  const voiceSources: SourceInfo[] = [];
  const mute = meta.muteVideo === true;
  for (const role of SOURCE_ROLES) {
    const raw = meta.sources?.[role];
    // "" у озвучки — владелец отказался от неё: аудиофайл по расширению не подбираем
    if (role === "voice" && raw === "") continue;
    const fixed = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x): x is string => typeof x === "string" && x !== "");
    const pinned: SourceInfo[] = [];
    for (const name of fixed) {
      const src = sources.find((s) => s.name === name);
      if (src && !src.role) pinned.push(src);
      else if (!src) problems.push(`story.json: ${ROLE_TITLE[role]} — файла «${name}» в папке нет${pinned.length ? "" : ", роль подобрана по имени"}`);
    }
    // скринкастов и озвучек может быть несколько: все заданные, иначе все узнанные по имени; остальные роли — по одному.
    // Аудиофайл — только озвучка; видео «озвучка…» по имени озвучкой не считаем (его назначают явно)
    const guessed = sources.filter((s) => !s.role && guessRole(s.name) === role && (role === "voice") === AUDIO_RE.test(s.name));
    const multi = role === "screen" || role === "voice";
    const picked = pinned.length ? pinned : multi ? guessed : guessed.slice(0, 1);
    for (const src of multi ? picked : picked.slice(0, 1)) {
      src.role = role;
      if (!roles[role]) roles[role] = src;
      if (role === "screen") screens.push(src);
      if (role === "voice") voiceSources.push(src);
    }
  }
  if (!roles.talk) problems.push("не назначена основа (видео): назовите файл «голова…»/«крупный…» или задайте роль");
  else if (roles.talk.probe && !roles.talk.probe.hasAudio && !voiceSources.length) {
    problems.push(`${roles.talk.name}: у основы нет звука — ролики соберутся без звука; запишите озвучку (кнопка с микрофоном) или положите аудиофайл в папку сюжета`);
  }
  for (const v of voiceSources) if (v.probe && !v.probe.hasAudio) problems.push(`${v.name}: в файле озвучки нет звука`);
  if (!roles.wide) problems.push("нет дальнего плана — перебивок не будет");
  if (!roles.screen) problems.push("нет скринкаста — вставок экрана не будет");

  const readTr = async (file: string): Promise<Transcript | null> => {
    try {
      return JSON.parse(await readFile(transcriptPath(file), "utf8")) as Transcript;
    } catch {
      return null;
    }
  };
  let transcript: Transcript | null = null;
  let transcriptFresh = false;
  if (roles.talk) {
    transcript = await readTr(roles.talk.file);
    transcriptFresh = await isTranscriptFresh(roles.talk.file);
    // основа без звука расшифровке не подлежит; при озвучке звук не с неё
    if (!transcript && !voiceSources.length && !mute && roles.talk.probe?.hasAudio !== false) problems.push("основа ещё не расшифрована");
  }
  const replicas = transcript && roles.talk?.probe ? splitReplicas(transcript, roles.talk.probe.duration) : [];
  const voices: VoiceTake[] = [];
  const cleanOn = meta.voiceClean !== false;
  const letters = { ...meta.voiceLetters };
  for (const src of voiceSources) {
    const tr = await readTr(src.file);
    const fresh = await isTranscriptFresh(src.file);
    if (!tr) problems.push(`озвучка «${src.name}» ещё не расшифрована`);
    // буква файла: a, b, c… — так реплики разных дублей не путаются (a01, b01…); закреплена за файлом в story.json
    const letter = (letters[src.name] ??= nextVoiceLetter(Object.values(letters)));
    const replicas = tr && src.probe ? splitReplicas(tr, src.probe.duration, { prefix: letter }).map((r) => ({ ...r, source: src.name })) : [];
    const cleanFresh = cleanOn && (await isCleanFresh(dir, src.name));
    voices.push({
      src,
      file: cleanFresh ? cleanedPath(dir, src.name) : src.file,
      clean: !cleanOn ? "off" : cleanFresh ? "ready" : "stale",
      mic: meta.voiceMic?.[src.name] ?? null,
      letter,
      transcript: tr,
      fresh,
      replicas,
    });
  }
  const voiceReplicas = voices.flatMap((v) => v.replicas);

  let edit: EditList | null = null;
  let editError: string | null = null;
  try {
    edit = JSON.parse(await readFile(join(dir, EDIT_FILE), "utf8")) as EditList;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") editError = `edit.json: ${(e as Error).message}`;
  }
  const count = Number.isInteger(meta.count) && (meta.count as number) > 0 ? (meta.count as number) : null;
  return { id, dir, sources, roles, screens, count, transcript, transcriptFresh, replicas, voices, voiceReplicas, mute, cleanOn, edit, editError, problems };
}

/** Файлы, у которых берётся звук (и расшифровка): озвучки, без них основа — если звук видео не отключён. */
function soundFiles(scan: MontageScan): { kind: "voice" | "talk"; items: { src: SourceInfo; fresh: boolean }[] } | null {
  if (scan.voices.length) return { kind: "voice", items: scan.voices.map((v) => ({ src: v.src, fresh: v.fresh })) };
  const t = scan.roles.talk;
  if (t && !scan.mute && t.probe?.hasAudio !== false) return { kind: "talk", items: [{ src: t, fresh: scan.transcriptFresh }] };
  return null;
}

/** Какой звук войдёт в ролик: озвучка (дубли), звук основы или никакого. */
export function soundMode(scan: MontageScan): "voice" | "talk" | "none" {
  return soundFiles(scan)?.kind ?? "none";
}

/** Источнику звука нужна расшифровка: её нет или она старше файла. */
export function needsTranscription(scan: MontageScan): boolean {
  const s = soundFiles(scan);
  return Boolean(s && s.items.some((i) => !i.fresh));
}

/** Расшифровать источники звука (все озвучки одним запуском модели, без них основу), у которых расшифровки нет или она старше файла (force — все). */
export async function transcribeSound(
  scan: MontageScan,
  opts: { stt: SttConfig; force?: boolean; run?: SttRun; log?: (m: string) => void },
): Promise<boolean> {
  const sound = soundFiles(scan);
  if (!sound) throw new Error("нечего расшифровывать: звук видео отключён или у основы нет звука — запишите озвучку");
  const todo = sound.items.filter((i) => opts.force || !i.fresh);
  if (todo.length === 0) return false;
  const what = sound.kind === "voice" ? "озвучки" : "основы";
  opts.log?.(`расшифровка ${what}: ${todo.map((i) => i.src.name).join(", ")}, загрузка модели…`);
  const results = await transcribeFiles(todo.map((i) => i.src.file), opts.stt, opts.run);
  const failed: string[] = [];
  for (const [i, item] of todo.entries()) {
    const r = results[i];
    if (!r || !r.ok) {
      failed.push(`${item.src.name}: ${r && !r.ok ? r.error : "нет ответа"}`);
      continue;
    }
    await writeTranscript(item.src.file, r.transcript);
    opts.log?.(`${item.src.name} расшифрована: ${r.transcript.words.length} слов`);
  }
  if (failed.length) throw new Error(`не расшифровано (${what}): ${failed.join("; ")}`);
  return true;
}

export type FrameRun = (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>;
const frameRun: FrameRun = (cmd, args) => coreRun(cmd, args, { timeout: 30_000 });

/** Кадр исходника на секунде t → jpg в <сюжет>/.rm/frames. Возвращает путь. */
export async function grabFrame(
  ffmpegPath: string,
  dir: string,
  src: SourceInfo,
  t: number,
  opts: { width?: number; run?: FrameRun; /** весь кадр без кропа — для выбора кропа */ full?: boolean } = {},
): Promise<string> {
  const dur = src.probe?.duration ?? Infinity;
  if (!(t >= 0) || t > dur) throw new Error(`${src.name}: секунда ${t} вне файла (0–${dur.toFixed(2)})`);
  const outDir = join(dir, WORK_DIR, "frames");
  await mkdir(outDir, { recursive: true });
  const crop = opts.full ? null : src.crop;
  const out = join(outDir, `${src.role ?? "src"}_${t.toFixed(2).replace(".", "_")}${opts.full ? "_full" : ""}.jpg`);
  const width = opts.width ?? 540;
  const res = await (opts.run ?? frameRun)(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", t.toFixed(3), "-i", src.file,
    "-frames:v", "1", "-vf", `${cropFilter(crop ?? undefined)}scale=${width}:-2`, "-q:v", "3",
    out,
  ]);
  if (!res.ok) throw new Error(`кадр ${src.name} @${t}: ${res.stderr.trim().split(/\r?\n/).pop() ?? "ffmpeg"}`);
  return out;
}
