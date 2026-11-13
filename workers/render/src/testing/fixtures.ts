// Тестовые сценки: короткие ролики из ffmpeg `testsrc2` + `sine`. Сами файлы в git не лежат — генерируются в
// workers/render/fixtures/.generated (каталог игнорируется) или в каталог, который передал тест.
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultRun } from "../ffmpeg/runner.ts";
import type { ClipInput, StoryInput, Transcript } from "../types.ts";

interface Spec {
  name: string;
  seconds: number;
  size: string;
  freq: number;
  audio: boolean;
  words: string[];
}

const SPECS: Spec[] = [
  { name: "01a_хук_привет.mp4", seconds: 3, size: "720x1280", freq: 440, audio: true, words: ["Привет", "друзья", "сегодня", "покажу", "кое-что"] },
  { name: "01b_хук_привет.mp4", seconds: 3, size: "1280x720", freq: 520, audio: true, words: ["Эй", "ты", "это", "видел", "уже?"] },
  { name: "02_кофе.mp4", seconds: 3, size: "720x1280", freq: 330, audio: true, words: ["Сначала", "завариваем", "кофе"] },
  { name: "03_работа.mp4", seconds: 3, size: "1080x1920", freq: 660, audio: false, words: [] },
  { name: "04_прогулка.mp4", seconds: 3, size: "720x1280", freq: 392, audio: true, words: ["Потом", "идём", "гулять"] },
  { name: "05_финал_пока.mp4", seconds: 2, size: "720x1280", freq: 294, audio: true, words: ["До", "встречи"] },
];

function transcriptFor(spec: Spec): Transcript | undefined {
  if (spec.words.length === 0) return undefined;
  const step = (spec.seconds - 0.6) / spec.words.length;
  return {
    text: spec.words.join(" ") + ".",
    words: spec.words.map((text, i) => ({ text, start: Math.round((0.2 + i * step) * 100) / 100, end: Math.round((0.2 + (i + 0.85) * step) * 100) / 100 })),
  };
}

export async function ensureFixtureStory(dir: string, ffmpegPath = process.env["RF_FFMPEG_PATH"] || "ffmpeg"): Promise<StoryInput> {
  await mkdir(dir, { recursive: true });
  const clips: ClipInput[] = [];
  for (const spec of SPECS) {
    const file = join(dir, spec.name);
    const exists = await stat(file).then((s) => s.size > 0, () => false);
    if (!exists) {
      const args = ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc2=size=${spec.size}:rate=30:duration=${spec.seconds}`];
      if (spec.audio) args.push("-f", "lavfi", "-i", `sine=frequency=${spec.freq}:sample_rate=44100:duration=${spec.seconds}`);
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
      if (spec.audio) args.push("-c:a", "aac", "-shortest");
      args.push(file);
      const res = await defaultRun(ffmpegPath, args, { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`не удалось создать ${spec.name}: ${res.stderr.slice(-300)}`);
    }
    clips.push({ id: spec.name, file, duration: spec.seconds, hasAudio: spec.audio, transcript: transcriptFor(spec) });
  }
  return { id: "fixture-story", title: "Утро", theme: "утро выходного дня", clips };
}

/** Описание сюжета без файлов: для тестов планировщика, ASS и графа (ffmpeg не нужен). */
export function fakeStory(): StoryInput {
  return {
    id: "fixture-story",
    title: "Утро",
    theme: "утро выходного дня",
    clips: SPECS.map((s) => ({
      id: s.name,
      file: `/fx/${s.name}`,
      duration: s.seconds,
      hasAudio: s.audio,
      transcript: transcriptFor(s),
    })),
  };
}
