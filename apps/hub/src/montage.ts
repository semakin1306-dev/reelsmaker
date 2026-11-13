// Сборка сюжета «из исходников» по монтажному листу edit.json: основа → реплики → варианты с перебивками и вставками.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { editToPlans, type EditList, type MontageInput, type MontageResult, type Replica, type VariantPlan } from "@reels-factory/render";
import { isMontageStory, readMeta, scanMontage, transcribeTalk, VIDEO_RE, type MontageScan } from "@reels-factory/pc-agent";
import { renderRun, type BuildEnv, type BuildHooks, type RunSummary } from "./build.ts";
import type { HwMode } from "@reels-factory/render";

export type StoryKind = "scenes" | "montage";

/** Сценки NN_… или исходники (основа, дальний, экран). */
export async function storyKind(dir: string): Promise<StoryKind> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => VIDEO_RE.test(f));
  return isMontageStory(names, await readMeta(dir)) ? "montage" : "scenes";
}

export function montageInput(scan: MontageScan, presets: readonly string[]): MontageInput {
  const t = scan.roles.talk;
  if (!t?.probe) throw new Error("нет основы (видео со звуком) или ffprobe её не прочитал");
  const src = (s: MontageScan["roles"]["wide"]) => (s?.probe ? { name: s.name, file: s.file, duration: s.probe.duration, crop: s.crop } : null);
  return {
    storyId: scan.id,
    talk: { name: t.name, file: t.file, duration: t.probe.duration, crop: t.crop, transcript: scan.transcript },
    wide: src(scan.roles.wide),
    screens: scan.screens.map(src).filter((x): x is NonNullable<typeof x> => x !== null),
    replicas: scan.replicas,
    presets,
  };
}

/** Проверка листа без сборки: ошибки, предупреждения, схемы. */
export function checkEdit(scan: MontageScan, edit: EditList, presets: readonly string[]): MontageResult {
  return editToPlans(edit, montageInput(scan, presets));
}

/** Подпись варианта: реплики по порядку и план — «r02 → r03 дальний+экран → r05» (при нескольких скринкастах — «экран:гитхаб»). */
export function montageLabel(plan: VariantPlan, replicas: readonly Replica[], screens = 1): string {
  const screenName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.[^.]+$/, "").replace(/^(экран|скрин|screen)[\s_—-]*/i, "") || "экран";
  return plan.scenes
    .map((s) => {
      const rep = replicas.find((r) => s.trim.start >= r.start - 0.05 && s.trim.start < r.end);
      const id = rep ? rep.id : `${s.trim.start.toFixed(1)}–${s.trim.end.toFixed(1)}с`;
      const marks = [s.picture ? "дальний" : "", s.inset ? (screens > 1 ? `экран:${screenName(s.inset.file)}` : "экран") : ""].filter(Boolean).join("+");
      return marks ? `${id} ${marks}` : id;
    })
    .join(" → ");
}

export interface MontageBuildOptions {
  hw: HwMode;
  concurrency: number;
  /** id вариантов листа; пусто — все */
  variants?: string[];
}

export async function buildMontage(storyId: string, opts: MontageBuildOptions, env: BuildEnv, hooks: BuildHooks = {}): Promise<RunSummary> {
  const log = hooks.log ?? (() => {});
  const dir = join(env.inboxDir, storyId);
  const scanOpts = { ffprobePath: env.ffprobePath, probe: hooks.probe };
  let scan = await scanMontage(dir, storyId, scanOpts);
  if (scan.roles.talk && !scan.transcriptFresh) {
    if (!env.stt) throw new Error("основа не расшифрована, а расшифровка не настроена (RF_STT_PYTHON, RF_STT_MODEL)");
    await transcribeTalk(scan, { stt: env.stt, log });
    scan = await scanMontage(dir, storyId, scanOpts);
  }
  if (scan.editError) throw new Error(scan.editError);
  if (!scan.edit) throw new Error("нет монтажного листа edit.json — его составляет агент-монтажёр (окно справа)");
  const edit: EditList = opts.variants?.length
    ? { ...scan.edit, variants: scan.edit.variants.filter((v) => opts.variants!.includes(v.id)) }
    : scan.edit;
  const presets = env.presets.map((p) => p.id);
  const res = checkEdit(scan, edit, presets);
  if (res.errors.length) throw new Error("монтажный лист с ошибками:\n" + res.errors.join("\n"));
  for (const w of res.warnings) log(`лист: ${w}`);
  const names = new Map(res.plans.map((p, i) => [p.index, edit.variants[i]!.id]));
  return renderRun(
    storyId,
    res.plans,
    res.clips,
    {
      presets,
      warnings: [...scan.problems.filter((p) => !/нет дальнего|нет скринкаста/.test(p)), ...res.warnings],
      labelOf: (p) => montageLabel(p, scan.replicas, scan.screens.length),
      nameOf: (p) => names.get(p.index) ?? String(p.index),
    },
    opts,
    env,
    hooks,
  );
}
