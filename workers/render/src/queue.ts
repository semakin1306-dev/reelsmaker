import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { RenderOptions } from "./ffmpeg/graph.ts";
import type { RenderVariantParams, RenderVariantResult } from "./ffmpeg/render.ts";
import { planStory } from "./planner/index.ts";
import type { Preset } from "./presets.ts";
import type { ClipInput, StoryInput, TextLlm, VariantPlan } from "./types.ts";

/** Статусы по умолчанию (значения согласуются с моделью packages/core; адаптер хранилища может их переопределить). */
export const STORY_STATUS = { claimed: "rendering", done: "rendered", failed: "render_failed" } as const;
export const VARIANT_STATUS = { planned: "planned", rendering: "rendering", ready: "ready", failed: "failed" } as const;

export interface VariantPatch {
  status: string;
  video?: string;
  cover?: string;
  sheet?: string;
  log?: string;
  error?: string;
}

/**
 * Что воркеру нужно от базы. Реальный адаптер поверх packages/core (SQLite) — тонкая обёртка, пишется после влива RF0;
 * в тестах — память.
 */
export interface RenderStore {
  /** Атомарно берёт сюжет в статусе «расшифрован» и переводит в «собирается»; null — очередь пуста. */
  claimStory(): Promise<StoryInput | null>;
  createVariant(storyId: string, index: number, plan: VariantPlan): Promise<string>;
  updateVariant(variantId: string, patch: VariantPatch): Promise<void>;
  finishStory(storyId: string, status: string, note?: string): Promise<void>;
}

export interface RenderWorkerConfig {
  presets: readonly Preset[];
  /** корень для файлов вариантов: <outRoot>/<story>/v00/video.mp4 */
  outRoot: string;
  /** сколько вариантов, по умолчанию 10 */
  count?: number;
  /** одновременных рендеров; по умолчанию ядер/2 («один рендер на 2 ядра») */
  concurrency?: number;
  render?: RenderOptions;
  useLlm?: boolean;
  llm?: TextLlm;
  pollMs?: number;
}

export interface RenderWorkerDeps {
  store: RenderStore;
  renderVariant: (p: RenderVariantParams) => Promise<RenderVariantResult>;
  log?: (msg: string) => void;
}

export interface StoryRunSummary {
  storyId: string;
  ready: number;
  failed: number;
  warnings: string[];
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export function createRenderWorker(deps: RenderWorkerDeps, cfg: RenderWorkerConfig) {
  const log = deps.log ?? (() => {});
  const presetById = new Map(cfg.presets.map((p) => [p.id, p]));
  let stopping = false;
  let loop: Promise<void> | null = null;

  async function processStory(story: StoryInput): Promise<StoryRunSummary> {
    const summary: StoryRunSummary = { storyId: story.id, ready: 0, failed: 0, warnings: [] };
    let plans: VariantPlan[];
    try {
      const res = await planStory(story, { count: cfg.count, presets: cfg.presets.map((p) => p.id), useLlm: cfg.useLlm, llm: cfg.llm });
      plans = res.plans;
      summary.warnings = res.warnings;
    } catch (e) {
      await deps.store.finishStory(story.id, STORY_STATUS.failed, `планировщик: ${(e as Error).message}`);
      summary.failed = 1;
      return summary;
    }
    const clips = new Map<string, ClipInput>(story.clips.map((c) => [c.id, c]));
    const rows: { id: string; plan: VariantPlan }[] = [];
    for (const plan of plans) rows.push({ id: await deps.store.createVariant(story.id, plan.index, plan), plan });

    await pool(rows, cfg.concurrency ?? defaultConcurrency(), async ({ id, plan }) => {
      const preset = presetById.get(plan.preset);
      if (!preset) {
        await deps.store.updateVariant(id, { status: VARIANT_STATUS.failed, error: `нет пресета ${plan.preset}` });
        summary.failed += 1;
        return;
      }
      await deps.store.updateVariant(id, { status: VARIANT_STATUS.rendering });
      try {
        const outDir = join(cfg.outRoot, story.id, `v${pad(plan.index)}`);
        const r = await deps.renderVariant({ plan, preset, clips, outDir, opts: cfg.render });
        await deps.store.updateVariant(id, { status: VARIANT_STATUS.ready, video: r.video, cover: r.cover, sheet: r.sheet, log: r.log });
        summary.ready += 1;
      } catch (e) {
        const logPath = (e as { log?: string }).log;
        await deps.store.updateVariant(id, { status: VARIANT_STATUS.failed, error: (e as Error).message, log: logPath });
        log(`вариант ${plan.index} сюжета ${story.id}: ${(e as Error).message}`);
        summary.failed += 1;
      }
    });

    await deps.store.finishStory(
      story.id,
      summary.ready > 0 ? STORY_STATUS.done : STORY_STATUS.failed,
      summary.failed > 0 ? `готово ${summary.ready}, не собрано ${summary.failed}` : undefined,
    );
    return summary;
  }

  /** Берёт следующий сюжет из очереди и собирает его варианты. false — очередь пуста. */
  async function processNext(): Promise<StoryRunSummary | null> {
    const story = await deps.store.claimStory();
    if (!story) return null;
    log(`сюжет ${story.id}: сборка`);
    return processStory(story);
  }

  /** Обрабатывает очередь до пустой. */
  async function drain(): Promise<StoryRunSummary[]> {
    const out: StoryRunSummary[] = [];
    for (;;) {
      if (stopping) break;
      const s = await processNext();
      if (!s) break;
      out.push(s);
    }
    return out;
  }

  function start(): void {
    if (loop) return;
    stopping = false;
    const pollMs = cfg.pollMs ?? 5000;
    loop = (async () => {
      while (!stopping) {
        try {
          const done = await drain();
          if (done.length > 0) continue;
        } catch (e) {
          log(`воркер: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    })();
  }

  async function stop(): Promise<void> {
    stopping = true;
    await loop;
    loop = null;
  }

  return { processNext, drain, start, stop };
}
