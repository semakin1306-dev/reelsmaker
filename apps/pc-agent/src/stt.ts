// Расшифровка сценок моделью службы голосового ввода (faster-whisper large-v3-turbo на видеокарте).
// Своей модели нет и ничего не скачивается: Python и каталог модели берутся у службы (RF_STT_PYTHON, RF_STT_MODEL),
// HF_HUB_OFFLINE=1. Модель живёт только на время одного прогона по файлам сюжета.
import { stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { run as coreRun } from "@reels-factory/core";
import type { Transcript } from "@reels-factory/render";

export const STT_SCRIPT = fileURLToPath(new URL("../py/transcribe.py", import.meta.url));

export interface SttConfig {
  python: string;
  model: string;
  language?: string;
  device?: "cuda" | "cpu";
  compute?: string;
}

export type SttResult = { file: string; ok: true; transcript: Transcript } | { file: string; ok: false; error: string };

export type SttRun = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; timeout: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

const defaultRun: SttRun = (cmd, args, opts) => coreRun(cmd, args, opts);

/** Модель не поднялась или процесс упал целиком — не ошибка отдельного файла. */
export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttError";
  }
}

function isTranscript(v: unknown): v is Transcript {
  const t = v as Transcript;
  return (
    typeof t === "object" &&
    t !== null &&
    typeof t.text === "string" &&
    Array.isArray(t.words) &&
    t.words.every((w) => typeof w.text === "string" && typeof w.start === "number" && typeof w.end === "number")
  );
}

/** Разбирает строки JSON скрипта; файлы без строки получают ошибку «нет ответа». */
export function parseSttOutput(stdout: string, files: readonly string[]): SttResult[] {
  const byFile = new Map<string, SttResult>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let obj: { file?: unknown; ok?: unknown; transcript?: unknown; error?: unknown };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.file !== "string") continue;
    if (obj.ok === true && isTranscript(obj.transcript)) byFile.set(obj.file, { file: obj.file, ok: true, transcript: obj.transcript });
    else byFile.set(obj.file, { file: obj.file, ok: false, error: typeof obj.error === "string" ? obj.error : "неверный ответ расшифровки" });
  }
  return files.map((f) => byFile.get(f) ?? { file: f, ok: false, error: "нет ответа от расшифровки" });
}

function tail(text: string, lines = 8): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

/** Расшифровывает файлы одним запуском модели. Модель не загрузилась — SttError. */
export async function transcribeFiles(files: readonly string[], cfg: SttConfig, run: SttRun = defaultRun): Promise<SttResult[]> {
  if (files.length === 0) return [];
  const args = [
    STT_SCRIPT,
    "--model", cfg.model,
    "--language", cfg.language ?? "ru",
    "--device", cfg.device ?? "cuda",
    "--compute", cfg.compute ?? "int8_float16",
    ...files,
  ];
  const res = await run(cfg.python, args, {
    env: { HF_HUB_OFFLINE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    // загрузка модели ~30 с, дальше секунды на сценку
    timeout: 120_000 + 60_000 * files.length,
  });
  if (res.timedOut) throw new SttError("расшифровка не уложилась во время и остановлена");
  const results = parseSttOutput(res.stdout, files);
  if (res.code !== 0 && results.every((r) => !r.ok)) {
    throw new SttError(`расшифровка не запустилась (код ${res.code}): ${tail(res.stderr) || "без сообщения"}`);
  }
  return results;
}

/** Расшифровка лежит рядом со сценкой: 01_хук.mp4 → 01_хук.transcript.json (так её читает и CLI рендера). */
export function transcriptPath(clipFile: string): string {
  return clipFile.replace(/\.[^./\\]+$/, "") + ".transcript.json";
}

export async function writeTranscript(clipFile: string, transcript: Transcript): Promise<string> {
  const path = transcriptPath(clipFile);
  await writeFile(path, JSON.stringify(transcript, null, 2), "utf8");
  return path;
}

/** Расшифровка есть и не старше сценки (сценку не переснимали после расшифровки). */
export async function isTranscriptFresh(clipFile: string): Promise<boolean> {
  try {
    const [clip, tr] = await Promise.all([stat(clipFile), stat(transcriptPath(clipFile))]);
    return tr.mtimeMs >= clip.mtimeMs;
  } catch {
    return false;
  }
}
