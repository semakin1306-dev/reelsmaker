import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Preset } from "../presets.ts";
import type { ClipInput, VariantPlan } from "../types.ts";
import { buildFfmpegJob, type RenderOptions } from "./graph.ts";
import { makePreviews } from "./preview.ts";
import type { RunFn } from "./runner.ts";

export interface RenderDeps {
  run: RunFn;
  ffmpegPath: string;
  ffprobePath: string;
  presetsDir: string;
}

export interface RenderVariantParams {
  plan: VariantPlan;
  preset: Preset;
  clips: ReadonlyMap<string, ClipInput>;
  /** каталог варианта: сюда пойдут video.mp4, cover.jpg, sheet.jpg, ffmpeg.log, plan.json */
  outDir: string;
  opts?: RenderOptions;
  /** таймаут рендера, мс (по умолчанию 20 минут) */
  timeoutMs?: number;
}

export interface RenderVariantResult {
  video: string;
  cover: string;
  sheet: string;
  log: string;
  /** фактическая длительность по ffprobe (null — ffprobe не ответил) */
  duration: number | null;
  expectedDuration: number;
}

export class RenderError extends Error {
  log: string;
  constructor(message: string, log: string) {
    super(message);
    this.name = "RenderError";
    this.log = log;
  }
}

export async function probeDuration(run: RunFn, ffprobePath: string, file: string): Promise<number | null> {
  const res = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  if (res.code !== 0) return null;
  const v = Number(res.stdout.trim());
  return Number.isFinite(v) ? v : null;
}

/** Рендерит один вариант: рабочий каталог → ffmpeg → проверка → превью. Журнал ffmpeg — в файле варианта. */
export async function renderVariant(deps: RenderDeps, p: RenderVariantParams): Promise<RenderVariantResult> {
  const { outDir } = p;
  const video = join(outDir, "video.mp4");
  const cover = join(outDir, "cover.jpg");
  const sheet = join(outDir, "sheet.jpg");
  const log = join(outDir, "ffmpeg.log");
  const work = join(outDir, "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(outDir, "plan.json"), JSON.stringify(p.plan, null, 2));

  const job = buildFfmpegJob({ plan: p.plan, preset: p.preset, clips: p.clips, outFile: video, presetsDir: deps.presetsDir, opts: p.opts });
  for (const f of job.staged) {
    const dest = join(work, f.name);
    await mkdir(dirname(dest), { recursive: true });
    if (f.content !== undefined) await writeFile(dest, f.content);
    else if (f.copyFrom) await copyFile(f.copyFrom, dest);
  }

  const logStream = createWriteStream(log, { flags: "w" });
  const logDone = new Promise<void>((res) => logStream.on("close", () => res()));
  logStream.write(`# ${new Date().toISOString()} вариант ${p.plan.index}, пресет ${p.plan.preset}, hw=${p.opts?.hw ?? "cpu"}\n`);
  logStream.write(`# ${deps.ffmpegPath} ${job.args.map((a) => (/[\s;\[\]]/.test(a) ? "<граф: см. ниже>" : a)).join(" ")}\n`);
  logStream.write(`# filter_complex:\n${job.filterGraph}\n\n`);
  try {
    const res = await deps.run(deps.ffmpegPath, job.args, {
      cwd: work,
      timeoutMs: p.timeoutMs ?? 20 * 60_000,
      onStderr: (c) => logStream.write(c),
    });
    if (res.timedOut) throw new RenderError("ffmpeg превысил таймаут", log);
    if (res.code !== 0) throw new RenderError(`ffmpeg завершился с кодом ${res.code}: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`, log);
  } finally {
    logStream.end();
    await logDone;
  }

  const size = await stat(video).then((s) => s.size, () => 0);
  if (size === 0) throw new RenderError("ffmpeg не создал выходной файл", log);
  const duration = await probeDuration(deps.run, deps.ffprobePath, video);
  if (duration !== null && Math.abs(duration - job.expectedDuration) > 1.5) {
    throw new RenderError(`длительность ${duration.toFixed(2)} с, ожидалось ${job.expectedDuration.toFixed(2)} с`, log);
  }
  await makePreviews(deps.run, deps.ffmpegPath, video, { cover, sheet }, duration ?? job.expectedDuration);
  await rm(work, { recursive: true, force: true });
  return { video, cover, sheet, log, duration, expectedDuration: job.expectedDuration };
}
