// Виртуальный микрофон с очисткой (программа в трее, apps/mic-clean): настоящий микрофон → ffmpeg с цепочкой voice-clean → виртуальный кабель
// (VB-Cable), в программах выбирают «CABLE Output». Здесь — настройки и план запуска ffmpeg; сама работа с устройствами — в Python (micclean.py).
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { analyzeNoise, buildLiveGraph, decodeMono, gateThreshold } from "./voice-clean.ts";

export interface MicCleanConfig {
  /** дружественное имя микрофона в DirectShow (ffmpeg -list_devices true -f dshow -i dummy) */
  input: string;
  /** часть имени устройства воспроизведения виртуального кабеля */
  output: string;
  /** образец шума микрофона (wav, 1–3 с тишины), записанный тем же путём — через DirectShow */
  noiseSample: string;
  /** усиление после очистки, дБ (потом лимитер): сырой C-1U тихий, программы ждут речь около −20 dBFS */
  gainDb: number;
  /** true — очистка, false — звук без обработки (для звонков) */
  processing: boolean;
  /** путь к ffmpeg; нет — из PATH */
  ffmpegPath?: string;
}

export function defaultMicCleanConfig(dataDir: string): MicCleanConfig {
  return {
    input: "Микрофон (2- C-1U)",
    output: "CABLE Input",
    noiseSample: join(dataDir, "noise", "live.wav"),
    gainDb: 9,
    processing: true,
  };
}

/** Читает настройки (поверх умолчаний); нет файла — умолчания. */
export async function readMicCleanConfig(file: string, dataDir: string): Promise<MicCleanConfig> {
  const base = defaultMicCleanConfig(dataDir);
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<MicCleanConfig>;
    return { ...base, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null)) } as MicCleanConfig;
  } catch {
    return base;
  }
}

export interface LivePlan {
  /** clean — очистка по образцу шума; passthrough — звук как есть */
  mode: "clean" | "passthrough";
  /** аргументы ffmpeg (без самой программы); звук — s16le 48 кГц моно в stdout */
  args: string[];
  gate: number | null;
  noiseSeconds: number | null;
  /** почему passthrough, если очистка была нужна */
  note: string;
}

export interface PlanDeps {
  /** подмена декодера (тесты): моно-отсчёты −1…1 и частота */
  decode?: (file: string) => Promise<{ samples: ArrayLike<number>; rate: number }>;
}

const OUT = ["-f", "s16le", "-ar", "48000", "-ac", "1", "-flush_packets", "1", "pipe:1"];
const dshow = (cfg: MicCleanConfig) => ["-fflags", "nobuffer", "-flags", "low_delay", "-f", "dshow", "-audio_buffer_size", "20", "-i", `audio=${cfg.input}`];

/** План запуска: очистка, если включена и есть образец шума; иначе звук без обработки (с понятной причиной). */
export async function planLive(cfg: MicCleanConfig, opts: { passthrough?: boolean } = {}, deps: PlanDeps = {}): Promise<LivePlan> {
  const passthrough = (note: string): LivePlan => ({
    mode: "passthrough",
    args: ["-hide_banner", "-loglevel", "warning", "-nostdin", ...dshow(cfg), "-af", "alimiter=limit=0.95:level=disabled", ...OUT],
    gate: null,
    noiseSeconds: null,
    note,
  });
  if (opts.passthrough || !cfg.processing) return passthrough("");
  try {
    await stat(cfg.noiseSample);
  } catch {
    return passthrough("нет образца шума микрофона — выберите в меню «Выучить шум» (3 секунды тишины)");
  }
  const { samples, rate } = await (deps.decode ?? ((f) => decodeMono(cfg.ffmpegPath ?? "ffmpeg", f)))(cfg.noiseSample);
  const noiseSeconds = Math.round((samples.length / rate) * 100) / 100;
  if (noiseSeconds < 0.4) return passthrough(`образец шума слишком короткий (${noiseSeconds} с) — выучите шум заново`);
  const gate = gateThreshold(analyzeNoise(samples, rate).floorDb);
  const graph = buildLiveGraph({ noiseSeconds, gate, gainDb: cfg.gainDb });
  return {
    mode: "clean",
    args: ["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", cfg.noiseSample, ...dshow(cfg), "-filter_complex", graph, "-map", "[o]", ...OUT],
    gate,
    noiseSeconds,
    note: "",
  };
}
