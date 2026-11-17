// Сборка сюжета «из исходников» по монтажному листу edit.json: основа → реплики → варианты с перебивками и вставками.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { editToPlans, type EditList, type EditVariant, type MontageInput, type MontageResult, type Replica, type VariantPlan } from "@reels-factory/render";
import { defaultNoiseDir, ensureClean, isMontageStory, needsTranscription, readMeta, scanMontage, soundMode, transcribeSound, VIDEO_RE, type MontageScan } from "@reels-factory/pc-agent";
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
  if (!t?.probe) throw new Error("нет основы (видео) или ffprobe её не прочитал");
  for (const v of scan.voices) if (!v.src.probe) throw new Error(`озвучка «${v.src.name}»: ffprobe не прочитал файл`);
  const src = (s: MontageScan["roles"]["wide"]) => (s?.probe ? { name: s.name, file: s.file, duration: s.probe.duration, crop: s.crop } : null);
  return {
    storyId: scan.id,
    talk: { name: t.name, file: t.file, duration: t.probe.duration, crop: t.crop, transcript: scan.transcript },
    // звук — из чистой копии (если очистка включена и копия готова); имя и расшифровка остаются от оригинала
    voices: scan.voices.map((v) => ({ name: v.src.name, file: v.file, duration: v.src.probe!.duration, transcript: v.transcript })),
    voiceReplicas: scan.voiceReplicas,
    // звук видео отключён (или у основы его нет) и озвучки нет — ролик без звука
    mute: soundMode(scan) === "none",
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

/** Файл сцены — это источник реплики? Сравниваем имя без расширения: чистая копия озвучки (.wav) называется как оригинал (.mp3, .m4a…). */
function fromSource(file: string, source: string | undefined): boolean {
  if (!source) return true;
  const base = (f: string) => (f.replace(/\\/g, "/").split("/").pop() ?? f).replace(/\.[^.]+$/, "");
  return base(file) === base(source);
}

/** Подпись варианта: реплики по порядку и план — «r02 → r03 дальний+экран → r05» (при нескольких скринкастах — «экран:гитхаб»). */
export function montageLabel(plan: VariantPlan, replicas: readonly Replica[], screens = 1, talkFile?: string): string {
  const screenName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.[^.]+$/, "").replace(/^(экран|скрин|screen)[\s_—-]*/i, "") || "экран";
  return plan.scenes
    .map((s) => {
      // у озвучки реплики разных файлов пересекаются по времени — берём реплику того файла, что в сцене
      const rep = replicas.find((r) => fromSource(s.file, r.source) && s.trim.start >= r.start - 0.05 && s.trim.start < r.end);
      const id = rep ? rep.id : `${s.trim.start.toFixed(1)}–${s.trim.end.toFixed(1)}с`;
      // при озвучке крупный план — тоже «картинка» (из файла основы), дальним он не называется
      const marks = [s.picture && s.picture.file !== talkFile ? "дальний" : "", s.inset ? (screens > 1 ? `экран:${screenName(s.inset.file)}` : "экран") : ""].filter(Boolean).join("+");
      return marks ? `${id} ${marks}` : id;
    })
    .join(" → ");
}

export interface SceneInfo {
  /** секунды готового ролика */
  from: number;
  to: number;
  /** реплика озвучки/основы или отрезок */
  id: string;
  /** что на экране: вид / дальний / экран «имя» */
  visual: string;
  /** подпись монтажёра (note в листе) */
  note: string;
  /** текст реплики, если сцена — реплика */
  text: string;
}

/** План варианта по сценам: время в ролике, реплика, картинка, подпись — чтобы владелец видел, что показывается к каждой реплике. */
export function montageScenes(plan: VariantPlan, variant: EditVariant, replicas: readonly Replica[], talkFile?: string): SceneInfo[] {
  const screenName = (file: string) => (file.split(/[\\/]/).pop() ?? file).replace(/\.[^.]+$/, "");
  let t = 0;
  return plan.scenes.map((s, i) => {
    const seg = variant.segments[i] ?? {};
    const len = (s.trim.end - s.trim.start) / plan.speed;
    // сегмент задан отрезком start/end — реплики определяем по перекрытию со звуком (того же файла озвучки)
    const over = seg.voice || seg.replica ? [] : replicas.filter((r) => fromSource(s.file, r.source) && Math.min(r.end, s.trim.end) - Math.max(r.start, s.trim.start) > 0.15);
    const id = seg.voice ?? seg.replica ?? (over.length ? over.map((r) => r.id).join(" + ") : `${s.trim.start.toFixed(1)}–${s.trim.end.toFixed(1)} с`);
    const visual = s.inset ? `экран «${screenName(s.inset.file)}»` : s.picture && s.picture.file !== talkFile ? "дальний" : "вид";
    const rep = replicas.find((r) => r.id === id);
    const info: SceneInfo = { from: Math.round(t * 10) / 10, to: Math.round((t + len) * 10) / 10, id, visual, note: seg.note ?? "", text: rep?.text ?? over.map((r) => r.text).join(" ") };
    t += len;
    return info;
  });
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
  // звук озвучки идёт из чистой копии: недостающие делаем сейчас; не вышло — берётся оригинал, сборка не падает
  if (scan.cleanOn && scan.voices.some((v) => v.clean === "stale")) {
    const r = await ensureClean(scan, { ffmpegPath: env.ffmpegPath, noiseDir: defaultNoiseDir(env.inboxDir), ...hooks.cleanDeps }, { log });
    for (const f of r.failed) log(`очистка ${f.name} не удалась, звук берётся с оригинала: ${f.error}`);
    scan = await scanMontage(dir, storyId, scanOpts);
  }
  if (needsTranscription(scan)) {
    const what = scan.voices.length ? "озвучка" : "основа";
    if (!env.stt) throw new Error(`${what} не расшифрована, а расшифровка не настроена (RF_STT_PYTHON, RF_STT_MODEL)`);
    await transcribeSound(scan, { stt: env.stt, log });
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
      labelOf: (p) => montageLabel(p, scan.voices.length ? scan.voiceReplicas : scan.replicas, scan.screens.length, scan.voices.length ? scan.roles.talk?.file : undefined),
      nameOf: (p) => names.get(p.index) ?? String(p.index),
    },
    opts,
    env,
    hooks,
  );
}
