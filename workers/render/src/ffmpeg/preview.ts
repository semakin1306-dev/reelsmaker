import type { RunFn } from "./runner.ts";

export const SHEET_COLS = 3;
export const SHEET_ROWS = 2;

/** Кадр-обложка: берём момент, когда хук уже на экране. */
export function coverTime(duration: number): number {
  return Math.round(Math.min(1, Math.max(0, duration / 3)) * 100) / 100;
}

export function buildCoverArgs(video: string, out: string, duration: number): string[] {
  return ["-hide_banner", "-nostdin", "-y", "-ss", String(coverTime(duration)), "-i", video, "-frames:v", "1", "-q:v", "3", "-update", "1", out];
}

/** Контактный лист 3×2: шесть кадров через равные промежутки, ширина плитки 360 px. */
export function buildSheetArgs(video: string, out: string, duration: number): string[] {
  const n = SHEET_COLS * SHEET_ROWS;
  const rate = Math.round((n / Math.max(0.5, duration)) * 100000) / 100000;
  return [
    "-hide_banner", "-nostdin", "-y",
    "-i", video,
    "-vf", `fps=${rate},scale=360:-2,tile=${SHEET_COLS}x${SHEET_ROWS}`,
    "-frames:v", "1", "-an", "-q:v", "4", "-update", "1",
    out,
  ];
}

export interface PreviewPaths {
  cover: string;
  sheet: string;
}

export async function makePreviews(
  run: RunFn,
  ffmpegPath: string,
  video: string,
  paths: PreviewPaths,
  duration: number,
): Promise<void> {
  const cover = await run(ffmpegPath, buildCoverArgs(video, paths.cover, duration));
  if (cover.code !== 0) throw new Error(`обложка не собрана (код ${cover.code}): ${cover.stderr.slice(-300)}`);
  const sheet = await run(ffmpegPath, buildSheetArgs(video, paths.sheet, duration));
  if (sheet.code !== 0) throw new Error(`контактный лист не собран (код ${sheet.code}): ${sheet.stderr.slice(-300)}`);
}
