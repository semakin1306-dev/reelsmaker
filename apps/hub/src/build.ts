// Сборка сюжета на ПК: (дорасшифровать) → схемы вариантов → ffmpeg → <вывод>/<сюжет>/<прогон>/vNN + run.json.
import { link, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultRun,
  planStory,
  renderVariant as realRenderVariant,
  type HwMode,
  type Preset,
  type RenderVariantParams,
  type RenderVariantResult,
  type VariantPlan,
  type ClipInput,
} from "@reels-factory/render";
import { probeClip, scanStory, toStoryInput, transcribeStory, needsTranscript, type SttConfig, type StoryScan } from "@reels-factory/pc-agent";

export interface BuildEnv {
  inboxDir: string;
  outputDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  presetsDir: string;
  presets: readonly Preset[];
  /** null — расшифровки нет, ролики без субтитров */
  stt: SttConfig | null;
}

export interface BuildOptions {
  count: number;
  /** id пресетов; пусто — все */
  presets: string[];
  hw: HwMode;
  /** одновременных рендеров */
  concurrency: number;
}

export type VariantStatus = "pending" | "rendering" | "ready" | "failed";

export interface VariantSummary {
  index: number;
  /** каталог варианта внутри прогона: v01 */
  dir: string;
  preset: string;
  hook: string;
  /** порядок сцен, например «01 → 03 → 02b → 05» */
  order: string;
  /** имя варианта в монтажном листе (edit.json) */
  name?: string;
  speed: number;
  status: VariantStatus;
  /** ролик одним файлом в корне прогона: <сюжет>_v01.mp4 */
  file?: string;
  duration?: number | null;
  error?: string;
}

export interface RunSummary {
  id: string;
  story: string;
  createdAt: string;
  finishedAt: string | null;
  count: number;
  presets: string[];
  hw: HwMode;
  warnings: string[];
  variants: VariantSummary[];
}

export interface BuildHooks {
  log?: (msg: string) => void;
  progress?: (done: number, total: number) => void;
  onRun?: (runId: string) => void;
  renderVariant?: (p: RenderVariantParams) => Promise<RenderVariantResult>;
  transcribe?: typeof transcribeStory;
  /** подмена ffprobe (тесты) */
  probe?: typeof probeClip;
  now?: () => Date;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function runIdFor(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function orderLabel(plan: VariantPlan): string {
  return plan.scenes.map((s) => `${pad(s.scene)}${s.take}`).join(" → ");
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/** Жёсткая ссылка (тот же диск — без копии), иначе копия. */
async function linkOrCopy(from: string, to: string): Promise<void> {
  await rm(to, { force: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

export async function buildStory(storyId: string, opts: BuildOptions, env: BuildEnv, hooks: BuildHooks = {}): Promise<RunSummary> {
  const log = hooks.log ?? (() => {});
  const dir = join(env.inboxDir, storyId);
  const scanOpts = { ffprobePath: env.ffprobePath, probe: hooks.probe };

  let scan: StoryScan = await scanStory(dir, storyId, scanOpts);
  const warnings: string[] = [...scan.problems];
  if (needsTranscript(scan).length > 0) {
    if (!env.stt) {
      warnings.push("расшифровка не настроена (RF_STT_PYTHON, RF_STT_MODEL): субтитры и хук из речи будут не у всех сцен");
    } else {
      try {
        const res = await (hooks.transcribe ?? transcribeStory)(dir, storyId, { ...scanOpts, stt: env.stt, log });
        scan = res.scan;
        for (const f of res.failed) warnings.push(`${f.name}: не расшифровано — ${f.error}`);
      } catch (e) {
        warnings.push(`расшифровка не удалась: ${(e as Error).message}`);
        log(`расшифровка не удалась: ${(e as Error).message}`);
      }
    }
  }

  const story = toStoryInput(scan);
  const allIds = env.presets.map((p) => p.id);
  const presetIds = opts.presets.filter((id) => allIds.includes(id));
  const chosen = presetIds.length > 0 ? presetIds : allIds;
  const plan = await planStory(story, { count: opts.count, presets: chosen });
  warnings.push(...plan.warnings);
  for (const w of plan.warnings) log(`планировщик: ${w}`);

  const clips = new Map(story.clips.map((c) => [c.id, c]));
  return renderRun(storyId, plan.plans, clips, { presets: chosen, warnings, labelOf: orderLabel }, opts, env, hooks);
}

export interface RunContext {
  presets: string[];
  warnings: string[];
  /** подпись порядка сцен варианта */
  labelOf: (p: VariantPlan) => string;
  /** имя варианта из монтажного листа */
  nameOf?: (p: VariantPlan) => string;
}

/** Прогон: <вывод>/<сюжет>/<дата_время>/vNN + ролик одним файлом в корне + run.json; варианты параллельно. */
export async function renderRun(
  storyId: string,
  plans: VariantPlan[],
  clips: Map<string, ClipInput>,
  ctx: RunContext,
  opts: Pick<BuildOptions, "hw" | "concurrency">,
  env: BuildEnv,
  hooks: BuildHooks = {},
): Promise<RunSummary> {
  const log = hooks.log ?? (() => {});
  const plan = { plans };
  const chosen = ctx.presets;
  const warnings = ctx.warnings;
  const created = (hooks.now ?? (() => new Date()))();
  const runId = runIdFor(created);
  const runDir = join(env.outputDir, storyId, runId);
  await mkdir(runDir, { recursive: true });
  hooks.onRun?.(runId);

  const summary: RunSummary = {
    id: runId,
    story: storyId,
    createdAt: created.toISOString(),
    finishedAt: null,
    count: plan.plans.length,
    presets: chosen,
    hw: opts.hw,
    warnings,
    variants: plan.plans.map((p) => ({
      index: p.index,
      dir: `v${pad(p.index)}`,
      preset: p.preset,
      hook: p.hook.text,
      order: ctx.labelOf(p),
      ...(ctx.nameOf ? { name: ctx.nameOf(p) } : {}),
      speed: p.speed,
      status: "pending",
    })),
  };
  const save = () => writeFile(join(runDir, "run.json"), JSON.stringify(summary, null, 2), "utf8");
  await save();

  const presetById = new Map(env.presets.map((p) => [p.id, p]));
  const render =
    hooks.renderVariant ??
    ((p: RenderVariantParams) => realRenderVariant({ run: defaultRun, ffmpegPath: env.ffmpegPath, ffprobePath: env.ffprobePath, presetsDir: env.presetsDir }, p));

  let done = 0;
  hooks.progress?.(0, plan.plans.length);
  await pool(plan.plans, opts.concurrency, async (p) => {
    const v = summary.variants.find((x) => x.index === p.index)!;
    const preset = presetById.get(p.preset);
    if (!preset) {
      Object.assign(v, { status: "failed", error: `нет пресета ${p.preset}` });
    } else {
      v.status = "rendering";
      await save();
      const t0 = Date.now();
      try {
        const r = await render({ plan: p, preset, clips, outDir: join(runDir, v.dir), opts: { hw: opts.hw } });
        const flat = `${storyId}_${v.dir}.mp4`;
        await linkOrCopy(r.video, join(runDir, flat));
        Object.assign(v, { status: "ready", file: flat, duration: r.duration });
        log(`вариант ${v.index} (${p.preset}) готов за ${((Date.now() - t0) / 1000).toFixed(0)} с: «${p.hook.text}»`);
      } catch (e) {
        Object.assign(v, { status: "failed", error: (e as Error).message });
        log(`вариант ${v.index}: ошибка — ${(e as Error).message}`);
      }
    }
    done += 1;
    hooks.progress?.(done, plan.plans.length);
    await save();
  });

  summary.finishedAt = new Date().toISOString();
  await save();
  return summary;
}

/** Прогоны сюжета, новые первыми. */
export async function listRuns(outputDir: string, storyId: string): Promise<RunSummary[]> {
  const base = join(outputDir, storyId);
  let names: string[];
  try {
    names = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  for (const name of names.sort().reverse()) {
    try {
      runs.push(JSON.parse(await readFile(join(base, name, "run.json"), "utf8")) as RunSummary);
    } catch {
      // не прогон или битый run.json — пропускаем
    }
  }
  return runs;
}
