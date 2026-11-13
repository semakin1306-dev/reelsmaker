// Станция на ПК: папка входа, ffprobe, расшифровка моделью службы голосового ввода, transcript.json рядом со сценкой.
import { CORE_VERSION } from "@reels-factory/core";
import { needsTranscript, scanStory, type ScanOptions, type StoryScan } from "./story.ts";
import { transcribeFiles, writeTranscript, type SttConfig, type SttRun } from "./stt.ts";

export const PACKAGE_NAME = "@reels-factory/pc-agent";
export const BUILT_ON_CORE = CORE_VERSION;

export * from "./probe.ts";
export * from "./stt.ts";
export * from "./story.ts";

export interface TranscribeStoryResult {
  scan: StoryScan;
  done: string[];
  failed: { name: string; error: string }[];
}

/**
 * Расшифровывает сценки сюжета, у которых нет свежей расшифровки (force — все со звуком), и пересканирует папку.
 * Модель не поднялась — SttError наружу.
 */
export async function transcribeStory(
  dir: string,
  id: string,
  opts: ScanOptions & { stt: SttConfig; force?: boolean; run?: SttRun; log?: (msg: string) => void },
): Promise<TranscribeStoryResult> {
  const before = await scanStory(dir, id, opts);
  const todo = opts.force ? before.clips.filter((c) => c.parsed && c.probe?.hasAudio) : needsTranscript(before);
  const done: string[] = [];
  const failed: { name: string; error: string }[] = [];
  if (todo.length > 0) {
    opts.log?.(`расшифровка: ${todo.length} сценок, загрузка модели…`);
    const results = await transcribeFiles(
      todo.map((c) => c.file),
      opts.stt,
      opts.run,
    );
    for (const [i, r] of results.entries()) {
      const name = todo[i]!.name;
      if (r.ok) {
        await writeTranscript(r.file, r.transcript);
        done.push(name);
        opts.log?.(`${name}: «${r.transcript.text}»`);
      } else {
        failed.push({ name, error: r.error });
        opts.log?.(`${name}: не расшифровано — ${r.error}`);
      }
    }
  }
  return { scan: await scanStory(dir, id, opts), done, failed };
}
export * from "./montage.ts";
