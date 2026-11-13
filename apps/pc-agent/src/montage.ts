// Сюжет «из исходников»: основа (говорящая голова со звуком), дальний план (перебивки), скринкаст (вставки).
// Роли — из story.json или по имени файла; реплики — из расшифровки основы; монтажный лист — edit.json в папке сюжета.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run as coreRun } from "@reels-factory/core";
import { cleanCrop, cropFilter, parseClipName, splitReplicas, type Crop, type EditList, type Replica, type Transcript } from "@reels-factory/render";
import { probeClip, type ClipProbe } from "./probe.ts";
import { VIDEO_RE } from "./story.ts";
import { isTranscriptFresh, transcribeFiles, transcriptPath, writeTranscript, type SttConfig, type SttRun } from "./stt.ts";

export type SourceRole = "talk" | "wide" | "screen";
export const SOURCE_ROLES: readonly SourceRole[] = ["talk", "wide", "screen"];
export const ROLE_TITLE: Record<SourceRole, string> = { talk: "основа (крупный, со звуком)", wide: "дальний план", screen: "скринкаст" };

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
};

export function guessRole(name: string): SourceRole | null {
  for (const role of SOURCE_ROLES) if (ROLE_RE[role].test(name)) return role;
  return null;
}

export interface StoryMeta {
  /** роли исходников; скринкастов может быть несколько (массив имён) */
  sources?: Partial<Record<SourceRole, string | string[]>>;
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
  return videoNames.some((n) => !parseClipName(n) && guessRole(n) !== null);
}

export interface SourceInfo {
  name: string;
  file: string;
  role: SourceRole | null;
  probe: ClipProbe | null;
  /** кроп из story.json (владелец выбирает в интерфейсе) */
  crop: Crop | null;
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
  const names = (await readdir(dir)).filter((f) => VIDEO_RE.test(f)).sort((a, b) => a.localeCompare(b, "ru"));
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
  for (const role of SOURCE_ROLES) {
    const raw = meta.sources?.[role];
    const fixed = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((x): x is string => typeof x === "string" && x !== "");
    const pinned: SourceInfo[] = [];
    for (const name of fixed) {
      const src = sources.find((s) => s.name === name);
      if (src && !src.role) pinned.push(src);
      else if (!src) problems.push(`story.json: ${ROLE_TITLE[role]} — файла «${name}» в папке нет${pinned.length ? "" : ", роль подобрана по имени"}`);
    }
    // скринкастов может быть несколько: все заданные, иначе все узнанные по имени; основа и дальний — по одному
    const guessed = sources.filter((s) => !s.role && guessRole(s.name) === role);
    const picked = pinned.length ? pinned : role === "screen" ? guessed : guessed.slice(0, 1);
    for (const src of role === "screen" ? picked : picked.slice(0, 1)) {
      src.role = role;
      if (!roles[role]) roles[role] = src;
      if (role === "screen") screens.push(src);
    }
  }
  if (!roles.talk) problems.push("не назначена основа (видео со звуком): назовите файл «голова…»/«крупный…» или задайте роль");
  else if (roles.talk.probe && !roles.talk.probe.hasAudio) problems.push(`${roles.talk.name}: у основы нет звука`);
  if (!roles.wide) problems.push("нет дальнего плана — перебивок не будет");
  if (!roles.screen) problems.push("нет скринкаста — вставок экрана не будет");

  let transcript: Transcript | null = null;
  let transcriptFresh = false;
  if (roles.talk) {
    try {
      transcript = JSON.parse(await readFile(transcriptPath(roles.talk.file), "utf8")) as Transcript;
    } catch {
      transcript = null;
    }
    transcriptFresh = await isTranscriptFresh(roles.talk.file);
    if (!transcript) problems.push("основа ещё не расшифрована");
  }
  const replicas = transcript && roles.talk?.probe ? splitReplicas(transcript, roles.talk.probe.duration) : [];

  let edit: EditList | null = null;
  let editError: string | null = null;
  try {
    edit = JSON.parse(await readFile(join(dir, EDIT_FILE), "utf8")) as EditList;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") editError = `edit.json: ${(e as Error).message}`;
  }
  const count = Number.isInteger(meta.count) && (meta.count as number) > 0 ? (meta.count as number) : null;
  return { id, dir, sources, roles, screens, count, transcript, transcriptFresh, replicas, edit, editError, problems };
}

/** Расшифровать основу, если расшифровки нет или она старше файла (force — всегда). */
export async function transcribeTalk(
  scan: MontageScan,
  opts: { stt: SttConfig; force?: boolean; run?: SttRun; log?: (m: string) => void },
): Promise<boolean> {
  const talk = scan.roles.talk;
  if (!talk) throw new Error("не назначена основа — расшифровывать нечего");
  if (!opts.force && scan.transcriptFresh) return false;
  opts.log?.(`расшифровка основы ${talk.name}, загрузка модели…`);
  const [r] = await transcribeFiles([talk.file], opts.stt, opts.run);
  if (!r || !r.ok) throw new Error(`основа не расшифрована: ${r && !r.ok ? r.error : "нет ответа"}`);
  await writeTranscript(talk.file, r.transcript);
  opts.log?.(`основа расшифрована: ${r.transcript.words.length} слов`);
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
