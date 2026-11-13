// Ручной прогон без базы: папка сюжета → N готовых роликов.
//   node --import tsx workers/render/src/cli.ts <папка-сюжета> <папка-вывода> [--count 10] [--hw nvenc] [--llm]
// В папке: NN_<роль>_<слово>.mp4 и (по желанию) такой же файл с расширением .transcript.json.
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPresets } from "./presets.ts";
import { planStory } from "./planner/index.ts";
import { renderVariant, probeDuration } from "./ffmpeg/render.ts";
import { defaultRun } from "./ffmpeg/runner.ts";
import type { ClipInput, StoryInput, TextLlm, Transcript } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

async function main(): Promise<void> {
  const [storyDirArg, outDirArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!storyDirArg || !outDirArg) {
    console.error("Использование: cli.ts <папка-сюжета> <папка-вывода> [--count 10] [--hw nvenc] [--llm]");
    process.exit(2);
  }
  const storyDir = resolve(storyDirArg);
  const outRoot = resolve(outDirArg);
  const ffmpegPath = process.env["RF_FFMPEG_PATH"] || "ffmpeg";
  const ffprobePath = process.env["RF_FFPROBE_PATH"] || "ffprobe";
  const presetsDir = join(here, "..", "presets");
  const presets = loadPresets(presetsDir);

  const clips: ClipInput[] = [];
  for (const name of (await readdir(storyDir)).filter((f) => /\.(mp4|mov|mkv)$/i.test(f)).sort()) {
    const file = join(storyDir, name);
    const duration = await probeDuration(defaultRun, ffprobePath, file);
    if (duration === null) {
      console.error(`пропущен ${name}: ffprobe не прочитал файл`);
      continue;
    }
    let transcript: Transcript | undefined;
    try {
      transcript = JSON.parse(await readFile(file.replace(/\.[^.]+$/, ".transcript.json"), "utf8")) as Transcript;
    } catch {
      transcript = undefined;
    }
    clips.push({ id: name, file, duration, transcript });
  }
  const story: StoryInput = { id: storyDir.split(/[\\/]/).pop() ?? "story", clips };

  let llm: TextLlm | undefined;
  if (process.argv.includes("--llm")) {
    const apiKey = process.env["RF_ANTHROPIC_API_KEY"];
    if (!apiKey) console.error("--llm: нет RF_ANTHROPIC_API_KEY, работают правила");
    else {
      const mod = await import("../../../packages/core/src/llm/claude.ts");
      llm = mod.createClaudeClient({ apiKey, model: process.env["RF_LLM_MODEL"] });
    }
  }
  const plan = await planStory(story, { count: Number(arg("count", "10")), presets: presets.map((p) => p.id), useLlm: Boolean(llm), llm });
  for (const w of plan.warnings) console.error(`предупреждение: ${w}`);

  const byId = new Map(clips.map((c) => [c.id, c]));
  const deps = { run: defaultRun, ffmpegPath, ffprobePath, presetsDir };
  await mkdir(outRoot, { recursive: true });
  for (const p of plan.plans) {
    const preset = presets.find((x) => x.id === p.preset)!;
    const outDir = join(outRoot, `v${String(p.index).padStart(2, "0")}`);
    process.stdout.write(`вариант ${p.index} (${p.preset}, «${p.hook.text}») … `);
    try {
      const r = await renderVariant(deps, { plan: p, preset, clips: byId, outDir, opts: { hw: arg("hw") === "nvenc" ? "nvenc" : "cpu" } });
      console.log(`готово, ${r.duration?.toFixed(1) ?? "?"} с → ${r.video}`);
    } catch (e) {
      console.log(`ошибка: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
