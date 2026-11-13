// Папка входа и папка сюжета: какие сценки лежат, как разобрались имена, что показал ffprobe, есть ли расшифровки.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { groupScenes, parseClipName, type ClipInput, type ParsedName, type StoryInput, type Transcript } from "@reels-factory/render";
import { probeClip, type ClipProbe } from "./probe.ts";
import { isTranscriptFresh, transcriptPath } from "./stt.ts";

export const VIDEO_RE = /\.(mp4|mov|mkv|m4v)$/i;
/** Файлы темы сюжета: первая непустая строка подставляется в шаблоны хуков. */
export const THEME_FILES = ["тема.txt", "сюжет.md", "theme.txt"];

export interface StoryClip {
  name: string;
  file: string;
  parsed: ParsedName | null;
  probe: ClipProbe | null;
  transcript: Transcript | null;
  /** расшифровка есть и новее сценки */
  transcriptFresh: boolean;
}

export interface StoryScan {
  /** имя папки сюжета */
  id: string;
  dir: string;
  theme: string | null;
  clips: StoryClip[];
  /** что в сюжет не попадёт и почему */
  problems: string[];
}

/** Имя папки сюжета годится для адреса и пути: без разделителей и «..». */
export function isSafeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/:*?"<>|]/.test(name);
}

/** Папки сюжетов в папке входа (скрытые и начинающиеся с «_» пропускаются), по имени. */
export async function listStoryDirs(inboxDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && isSafeName(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "ru"));
}

export async function readTheme(dir: string): Promise<string | null> {
  for (const name of THEME_FILES) {
    try {
      const text = await readFile(join(dir, name), "utf8");
      const line = text
        .split(/\r?\n/)
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find(Boolean);
      if (line) return line;
    } catch {
      // нет файла — следующий
    }
  }
  return null;
}

async function readTranscript(clipFile: string): Promise<Transcript | null> {
  try {
    return JSON.parse(await readFile(transcriptPath(clipFile), "utf8")) as Transcript;
  } catch {
    return null;
  }
}

export interface ScanOptions {
  ffprobePath: string;
  probe?: typeof probeClip;
}

export async function scanStory(dir: string, id: string, opts: ScanOptions): Promise<StoryScan> {
  const probe = opts.probe ?? probeClip;
  const names = (await readdir(dir)).filter((f) => VIDEO_RE.test(f)).sort((a, b) => a.localeCompare(b, "ru"));
  const problems: string[] = [];
  const clips: StoryClip[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const parsed = parseClipName(name);
    if (!parsed) problems.push(`${name}: имя не по правилу NN_<роль>_<слово> — сценка пропущена`);
    const p = await probe(opts.ffprobePath, file);
    if (!p) problems.push(`${name}: ffprobe не прочитал файл — сценка пропущена`);
    else if (!p.hasAudio) problems.push(`${name}: нет звуковой дорожки — будет тишина, без субтитров`);
    clips.push({
      name,
      file,
      parsed,
      probe: p,
      transcript: await readTranscript(file),
      transcriptFresh: await isTranscriptFresh(file),
    });
  }
  if (names.length === 0) problems.push("в папке нет видео (mp4, mov, mkv)");
  const scan: StoryScan = { id, dir, theme: await readTheme(dir), clips, problems };
  scan.problems.push(...groupScenes(toStoryInput(scan).clips).errors);
  return scan;
}

/** Сценки, которые можно собирать: имя разобрано и ffprobe прочитал файл. */
export function usableClips(scan: StoryScan): StoryClip[] {
  return scan.clips.filter((c) => c.parsed && c.probe);
}

/** Вход планировщика рендера. */
export function toStoryInput(scan: StoryScan): StoryInput {
  const clips: ClipInput[] = usableClips(scan).map((c) => ({
    id: c.name,
    file: c.file,
    duration: c.probe!.duration,
    hasAudio: c.probe!.hasAudio,
    transcript: c.transcript ?? undefined,
  }));
  return { id: scan.id, title: scan.id, theme: scan.theme ?? undefined, clips };
}

/** Сценки со звуком, у которых расшифровки нет или она старше файла. */
export function needsTranscript(scan: StoryScan): StoryClip[] {
  return usableClips(scan).filter((c) => c.probe!.hasAudio && !c.transcriptFresh);
}
