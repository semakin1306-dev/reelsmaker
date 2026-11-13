import { run as coreRun } from "@reels-factory/core";

export interface ClipProbe {
  /** секунды */
  duration: number;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
}

export type ProbeRun = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const defaultRun: ProbeRun = (cmd, args) => coreRun(cmd, args, { timeout: 30_000 });

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  side_data_list?: { rotation?: number | string }[];
  tags?: { rotate?: string };
}

/** Поворот кадра при показе (видео с телефона: пишется 1920×1080 с поворотом −90°). */
function rotation(s: ProbeStream): number {
  const r = Number(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0);
  return Number.isFinite(r) ? r : 0;
}

/** Разбирает JSON ffprobe (-show_format -show_streams). Нет длительности — null. */
export function parseProbe(json: string): ClipProbe | null {
  let data: { format?: { duration?: string }; streams?: ProbeStream[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    duration,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    // размер — как кадр выглядит при показе: при повороте на ±90° ширина и высота меняются местами
    ...(Math.abs(rotation(video)) % 180 === 90
      ? { width: video.height ?? null, height: video.width ?? null }
      : { width: video.width ?? null, height: video.height ?? null }),
  };
}

/** ffprobe сценки: длительность, есть ли звук, размер кадра. Битый файл — null. */
export async function probeClip(ffprobePath: string, file: string, run: ProbeRun = defaultRun): Promise<ClipProbe | null> {
  const res = await run(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height,duration:stream_side_data=rotation:stream_tags=rotate",
    "-of", "json",
    file,
  ]);
  return res.ok ? parseProbe(res.stdout) : null;
}
