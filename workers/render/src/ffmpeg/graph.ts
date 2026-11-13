import { basename, isAbsolute, join } from "node:path";
import { buildAss } from "../ass.ts";
import type { Preset } from "../presets.ts";
import type { ClipInput, VariantPlan, Crop } from "../types.ts";

export type HwMode = "cpu" | "nvenc";

export interface RenderOptions {
  /** cpu — libx264 veryfast (сервер); nvenc — h264_nvenc (ПК) */
  hw?: HwMode;
  /** потоков на один рендер (по умолчанию 2: «один рендер на 2 ядра») */
  threads?: number;
  crf?: number;
}

/** Файл, который нужно положить в рабочий каталог ffmpeg до запуска (пути в графе — относительные). */
export interface StagedFile {
  /** путь внутри рабочего каталога, например `captions.ass` или `fonts/Oswald-Bold.ttf` */
  name: string;
  content?: string;
  copyFrom?: string;
}

export interface FfmpegJob {
  args: string[];
  /** текст filter_complex отдельно: его проверяют тесты и пишет журнал */
  filterGraph: string;
  staged: StagedFile[];
  /** длительность готового ролика, секунды */
  expectedDuration: number;
}

export interface BuildInput {
  plan: VariantPlan;
  preset: Preset;
  clips: ReadonlyMap<string, ClipInput>;
  /** абсолютный путь итогового mp4 */
  outFile: string;
  /** каталог presets (fonts/, luts/) */
  presetsDir: string;
  opts?: RenderOptions;
}

const AUDIO_RATE = 48000;

function r(n: number, digits = 5): string {
  return String(Math.round(n * 10 ** digits) / 10 ** digits);
}

function even(n: number): number {
  return Math.ceil(n / 2) * 2;
}

/**
 * Входы ffmpeg по сценам: у каждой сцены свой вход звука (file), а при перебивке и вставке — ещё входы картинки.
 * Один файл может открываться несколько раз — так проще, чем делить поток split'ом между сценами.
 */
export function sceneInputs(plan: VariantPlan): { files: string[]; audio: number[]; picture: number[]; inset: (number | null)[] } {
  const files: string[] = [];
  const audio: number[] = [];
  const picture: number[] = [];
  const inset: (number | null)[] = [];
  for (const s of plan.scenes) {
    audio.push(files.push(s.file) - 1);
    picture.push(s.picture ? files.push(s.picture.file) - 1 : (audio.at(-1) as number));
    inset.push(s.inset ? files.push(s.inset.file) - 1 : null);
  }
  return { files, audio, picture, inset };
}

/** Кроп в долях кадра → фильтр ffmpeg (пустая строка — без кропа). */
export function cropFilter(c: Crop | undefined): string {
  if (!c) return "";
  return `crop=w='iw*${r(c.w, 4)}':h='ih*${r(c.h, 4)}':x='iw*${r(c.x, 4)}':y='ih*${r(c.y, 4)}',`;
}

function sceneChains(plan: VariantPlan, inputs: ReturnType<typeof sceneInputs>): string[] {
  const { width: W, height: H, fps } = plan.output;
  const out: string[] = [];
  plan.scenes.forEach((s, i) => {
    const len = s.trim.end - s.trim.start;
    const A = even(W * s.zoom.factor);
    const B = even(H * s.zoom.factor);
    const frac = `(0.5+(${r(s.zoom.drift, 3)})*(t/${r(len, 3)}-0.5))`;
    const vStart = s.picture ? s.picture.start : s.trim.start;
    const crop = cropFilter(s.picture ? s.picture.crop : s.crop);
    const base =
      `[${inputs.picture[i]}:v]trim=start=${r(vStart, 3)}:end=${r(vStart + len, 3)},setpts=PTS-STARTPTS,fps=${fps},${crop}` +
      `scale=${A}:${B}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H}:x='(iw-ow)*${frac}':y='(ih-oh)/2',setsar=1` +
      // перебивка короче отрезка звука — держим последний кадр, иначе склейка разъедется со звуком
      (s.picture ? `,tpad=stop_mode=clone:stop_duration=${r(len, 3)},trim=duration=${r(len, 3)}` : "");
    const ins = inputs.inset[i];
    if (s.inset && ins !== null && ins !== undefined) {
      const b = s.inset.box;
      const bw = even(b.w);
      const bh = even(b.h);
      out.push(`${base}[vb${i}]`);
      // вставка вписывается в рамку целиком (без обрезки) и центрируется в ней; короче сцены — держит последний кадр
      out.push(
        `[${ins}:v]trim=start=${r(s.inset.start, 3)}:end=${r(s.inset.start + len, 3)},setpts=PTS-STARTPTS,fps=${fps},${cropFilter(s.inset.crop)}` +
          `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,setsar=1,tpad=stop_mode=clone:stop_duration=${r(len, 3)}[vi${i}]`,
      );
      out.push(
        `[vb${i}][vi${i}]overlay=x=${Math.round(b.x)}+(${bw}-w)/2:y=${Math.round(b.y)}+(${bh}-h)/2:eof_action=pass,` +
          `trim=duration=${r(len, 3)}[v${i}]`,
      );
    } else {
      out.push(`${base}[v${i}]`);
    }
    const fade = `afade=t=in:st=0:d=0.015,afade=t=out:st=${r(Math.max(0, len - 0.015), 3)}:d=0.015`;
    if (s.hasAudio) {
      out.push(
        `[${inputs.audio[i]}:a]atrim=start=${r(s.trim.start, 3)}:end=${r(s.trim.end, 3)},asetpts=PTS-STARTPTS,` +
          `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,${fade}[a${i}]`,
      );
    } else {
      out.push(`anullsrc=r=${AUDIO_RATE}:cl=stereo,atrim=duration=${r(len, 3)},asetpts=PTS-STARTPTS,${fade}[a${i}]`);
    }
  });
  return out;
}

/** Цветокор пресета — одинаковый для всех вариантов (решение владельца: без разницы цвета по вариантам). Пустой — без фильтров. */
function gradeFilters(preset: Preset, staged: StagedFile[], presetsDir: string): string[] {
  const g = preset.grade;
  const f: string[] = [];
  if (g.eq) {
    const parts: string[] = [];
    if (g.eq.brightness !== undefined) parts.push(`brightness=${r(g.eq.brightness, 4)}`);
    if (g.eq.contrast !== undefined) parts.push(`contrast=${r(g.eq.contrast, 4)}`);
    if (g.eq.saturation !== undefined) parts.push(`saturation=${r(g.eq.saturation, 4)}`);
    if (g.eq.gamma !== undefined) parts.push(`gamma=${r(g.eq.gamma, 4)}`);
    if (parts.length) f.push(`eq=${parts.join(":")}`);
  }
  if (g.curves) f.push(`curves=preset=${g.curves}`);
  if (g.lut) {
    staged.push({ name: g.lut, copyFrom: join(presetsDir, "luts", g.lut) });
    f.push(`lut3d=file=${g.lut}`);
  }
  if (g.vignette) f.push("vignette");
  if (g.grain && g.grain > 0) f.push(`noise=alls=${Math.round(g.grain)}:allf=t`);
  if (g.sharpen) f.push("unsharp=5:5:0.5:5:5:0.0");
  return f;
}

export function buildFfmpegJob(input: BuildInput): FfmpegJob {
  const { plan, preset, clips, outFile, presetsDir } = input;
  const hw: HwMode = input.opts?.hw ?? "cpu";
  const threads = Math.max(1, input.opts?.threads ?? 2);
  const n = plan.scenes.length;
  if (n === 0) throw new Error("схема без сцен");
  if (plan.speed < 0.5 || plan.speed > 2) throw new Error(`скорость ${plan.speed} вне диапазона atempo`);
  const staged: StagedFile[] = [];

  const inputs = sceneInputs(plan);
  const chains = sceneChains(plan, inputs);
  const concatIn = plan.scenes.map((_, i) => `[v${i}][a${i}]`).join("");
  chains.push(`${concatIn}concat=n=${n}:v=1:a=1[vcat][acat]`);

  const vf: string[] = [`setpts=PTS/${r(plan.speed)}`, `fps=${plan.output.fps}`];
  vf.push(...gradeFilters(preset, staged, presetsDir));

  // субтитры, хук и плашки одним ASS; шрифты кладём рядом — libass берёт их из fontsdir
  staged.push({ name: "captions.ass", content: buildAss(plan, preset, clips) });
  const fonts = new Set([preset.hook.fontFile, preset.caption.fontFile, preset.block.fontFile]);
  // свой шрифт — полный путь (папка данных), встроенный — имя файла в presets/fonts
  for (const f of fonts) staged.push({ name: `fonts/${basename(f)}`, copyFrom: isAbsolute(f) ? f : join(presetsDir, "fonts", f) });
  vf.push("ass=filename=captions.ass:fontsdir=fonts", "format=yuv420p");
  chains.push(`[vcat]${vf.join(",")}[vout]`);

  const af: string[] = [];
  const pitch = plan.pitch;
  if (Math.abs(pitch - 1) > 0.001) {
    // сдвиг высоты: asetrate меняет и темп, поэтому atempo делит скорость на pitch — итоговый темп = plan.speed
    af.push(`asetrate=${r(AUDIO_RATE * pitch, 2)}`, `aresample=${AUDIO_RATE}`, `atempo=${r(plan.speed / pitch)}`);
  } else {
    af.push(`atempo=${r(plan.speed)}`);
  }
  chains.push(`[acat]${af.join(",")}[aout]`);
  const filterGraph = chains.join(";\n");

  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-loglevel", "info"];
  for (const f of inputs.files) args.push("-i", f);
  args.push("-filter_complex", filterGraph, "-filter_complex_threads", String(threads), "-map", "[vout]", "-map", "[aout]");
  if (hw === "nvenc") {
    args.push("-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(input.opts?.crf ?? 23), "-b:v", "0");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String(input.opts?.crf ?? 21), "-threads", String(threads));
  }
  args.push(
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", String(AUDIO_RATE), "-ac", "2",
    "-map_metadata", "-1",
    "-movflags", "+faststart",
    outFile,
  );

  const total = plan.scenes.reduce((sum, s) => sum + (s.trim.end - s.trim.start), 0);
  return { args, filterGraph, staged, expectedDuration: total / plan.speed };
}
