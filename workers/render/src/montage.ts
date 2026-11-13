// Монтаж из исходников: одно видео со звуком (основа, крупный план) режется на реплики; варианты собираются из реплик
// по монтажному листу (edit.json), который пишет агент-монтажёр. Перебивки — дальним планом, вставки — скринкастом.
// Звук и субтитры всегда с основы. Оформление (пресет, цвет, скорость, высота звука, зум) — как у обычных вариантов:
// задано в листе — берётся оттуда, нет — раздаётся по вариантам автоматически, чтобы варианты различались.
import { hashSeed } from "./rng.ts";
import { capitalize, hookFromTranscript } from "./planner/rules.ts";
import { DEFAULT_OUTPUT, SAFE_BOX, type Box, type Crop, type ClipInput, type PlanBlock, type PlanScene, type Transcript, type VariantPlan } from "./types.ts";

export interface Replica {
  /** r01, r02… по порядку в основе */
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface ReplicaOptions {
  /** пауза между словами, после которой — новая реплика, с */
  pause?: number;
  /** запас до первого и после последнего слова, с */
  padBefore?: number;
  padAfter?: number;
}

/** Режет расшифровку основы на реплики: по концу предложения или паузе. Границы не залезают на соседей. */
export function splitReplicas(transcript: Transcript, duration: number, opts: ReplicaOptions = {}): Replica[] {
  const pause = opts.pause ?? 0.55;
  const padBefore = opts.padBefore ?? 0.12;
  const padAfter = opts.padAfter ?? 0.25;
  const words = [...transcript.words].filter((w) => w.text.trim()).sort((a, b) => a.start - b.start);
  const groups: (typeof words)[] = [];
  let cur: typeof words = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev) {
      const gap = w.start - prev.end;
      const sentenceEnd = /[.!?…]["»”)]*$/u.test(prev.text);
      if (gap >= pause || (sentenceEnd && gap >= 0.12)) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const first = g[0]!;
    const last = g.at(-1)!;
    // запас не заходит за середину паузы до соседней реплики — соседи не пересекаются
    const prevMid = i > 0 ? (groups[i - 1]!.at(-1)!.end + first.start) / 2 : 0;
    const nextMid = i < groups.length - 1 ? (last.end + groups[i + 1]![0]!.start) / 2 : duration;
    const start = Math.max(prevMid, first.start - padBefore, 0);
    const end = Math.min(nextMid, last.end + padAfter, duration);
    return {
      id: `r${String(i + 1).padStart(2, "0")}`,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(Math.max(end, start + 0.1) * 1000) / 1000,
      text: g.map((w) => w.text.trim()).join(" "),
    };
  });
}

// ─────────────────────────────── монтажный лист ───────────────────────────────

export type View = "close" | "wide";

export interface EditSegment {
  /** реплика основы; или явный отрезок start/end основы */
  replica?: string;
  start?: number;
  end?: number;
  /** подрезать реплику: + к началу, − к концу (с) */
  cutStart?: number;
  cutEnd?: number;
  /** close — крупный план (основа), wide — перебивка дальним планом */
  view?: View;
  /** с какой секунды дальнего плана брать картинку; нет — та же секунда, что у звука, + layout.wideOffset */
  wideAt?: number;
  /** вставка скринкаста: секунда скринкаста, с которой показывать; true — та же секунда, что у звука, + layout.screenOffset */
  screen?: number | true;
  /** какой скринкаст вставить (имя файла, можно без расширения); нужен, когда скринкастов несколько */
  screenFile?: string;
}

export interface EditBlock {
  /** номер сегмента в варианте, с 0 */
  segment: number;
  text: string;
  /** с от начала сегмента */
  offset?: number;
  duration?: number;
}

export interface EditVariant {
  id: string;
  hook?: string;
  hookDuration?: number;
  /** больше не используются: оформление одно на все варианты, темп и голос — как сняты */
  preset?: string;
  speed?: number;
  pitch?: number;
  captions?: boolean;
  segments: EditSegment[];
  blocks?: EditBlock[];
}

export interface EditLayout {
  /** рамка скринкаста на дальнем плане (пиксели кадра 1080×1920) */
  wideScreenBox?: Box;
  /** рамка скринкаста на крупном плане */
  closeScreenBox?: Box;
  /** сдвиг дальнего плана относительно основы, с (если сняты одновременно, но запущены не разом) */
  wideOffset?: number;
  screenOffset?: number;
}

export interface EditList {
  version: 1;
  /** о чём сюжет — заметка монтажёра */
  notes?: string;
  layout?: EditLayout;
  variants: EditVariant[];
}

export interface MontageSource {
  name: string;
  file: string;
  duration: number;
  /** кроп исходника (story.json), в долях кадра */
  crop?: Crop | null;
}

/** Проверенный кроп: доли 0…1, не меньше 10% стороны, целиком внутри кадра; весь кадр или мусор — null. */
export function cleanCrop(c: unknown): Crop | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const n = (k: string) => Number(o[k]);
  let [x, y, w, h] = [n("x"), n("y"), n("w"), n("h")];
  if (![x, y, w, h].every(Number.isFinite)) return null;
  w = Math.min(1, Math.max(0.1, w));
  h = Math.min(1, Math.max(0.1, h));
  x = Math.min(1 - w, Math.max(0, x));
  y = Math.min(1 - h, Math.max(0, y));
  const q = (v: number) => Math.round(v * 10000) / 10000;
  if (w > 0.999 && h > 0.999) return null;
  return { x: q(x), y: q(y), w: q(w), h: q(h) };
}

export interface MontageInput {
  storyId: string;
  talk: MontageSource & { transcript: Transcript | null };
  wide?: MontageSource | null;
  /** один скринкаст (старый вид) — то же, что screens: [screen] */
  screen?: MontageSource | null;
  /** все скринкасты сюжета; сегмент выбирает свой по screenFile */
  screens?: MontageSource[] | null;
  replicas: Replica[];
  /** id всех пресетов — для раздачи по вариантам */
  presets: readonly string[];
}

/** Рамка по умолчанию: верх охранной зоны — там у дальнего плана свободное место. */
export const DEFAULT_SCREEN_BOX: Box = { x: SAFE_BOX.x, y: SAFE_BOX.y, w: SAFE_BOX.w, h: 600 };

/** Рамка внутри охранной зоны: сдвигается внутрь, размер урезается, только если иначе не влезает. */
export function fitSafe(b: Box): Box {
  const w = Math.min(Math.max(1, b.w), SAFE_BOX.w);
  const h = Math.min(Math.max(1, b.h), SAFE_BOX.h);
  const x = Math.min(Math.max(b.x, SAFE_BOX.x), SAFE_BOX.x + SAFE_BOX.w - w);
  const y = Math.min(Math.max(b.y, SAFE_BOX.y), SAFE_BOX.y + SAFE_BOX.h - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Единственный пресет оформления (решение владельца: шрифты и цвет одинаковые у всех вариантов). */
export const DEFAULT_PRESET = "default";

export interface MontageResult {
  plans: VariantPlan[];
  /** файлы для словаря клипов рендера: основа (с расшифровкой — для субтитров) */
  clips: Map<string, ClipInput>;
  errors: string[];
  warnings: string[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Проверяет лист и переводит его в схемы вариантов. Ошибки — по варианту и сегменту, понятные агенту. */
export function editToPlans(edit: EditList, input: MontageInput): MontageResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const plans: VariantPlan[] = [];
  const byId = new Map(input.replicas.map((r) => [r.id, r]));
  const layout: EditLayout = { ...(edit.layout ?? {}) };
  for (const k of ["wideScreenBox", "closeScreenBox"] as const) {
    const b = layout[k];
    if (!b) continue;
    const fit = fitSafe(b);
    if (fit.x !== b.x || fit.y !== b.y || fit.w !== b.w || fit.h !== b.h) {
      warnings.push(`layout.${k} {x:${b.x}, y:${b.y}, w:${b.w}, h:${b.h}} выходит из охранной зоны Reels (x ${SAFE_BOX.x}–${SAFE_BOX.x + SAFE_BOX.w}, y ${SAFE_BOX.y}–${SAFE_BOX.y + SAFE_BOX.h}) — взята {x:${fit.x}, y:${fit.y}, w:${fit.w}, h:${fit.h}}`);
      layout[k] = fit;
    }
  }
  const talk = input.talk;
  const clips = new Map<string, ClipInput>([
    [talk.name, { id: talk.name, file: talk.file, duration: talk.duration, hasAudio: true, transcript: talk.transcript ?? undefined }],
  ]);
  if (!Array.isArray(edit.variants) || edit.variants.length === 0) errors.push("в листе нет вариантов (variants)");
  const screens = input.screens?.length ? input.screens : input.screen ? [input.screen] : [];
  const screenNames = screens.map((x) => x.name).join(", ");
  /** скринкаст по имени файла (без учёта регистра, можно без расширения); без имени — единственный или первый */
  const pickScreen = (name: string | undefined): MontageSource | null => {
    if (!name) return screens[0] ?? null;
    const norm = (x: string) => x.toLowerCase().replace(/\.[^.]+$/, "").trim();
    return screens.find((x) => x.name === name) ?? screens.find((x) => norm(x.name) === norm(name)) ?? null;
  };
  const preset = input.presets.includes(DEFAULT_PRESET) ? DEFAULT_PRESET : (input.presets[0] ?? DEFAULT_PRESET);
  const ids = new Set<string>();

  (edit.variants ?? []).forEach((v, vi) => {
    const where = `вариант ${v.id ?? vi + 1}`;
    if (!v.id) errors.push(`${where}: нет id`);
    else if (ids.has(v.id)) errors.push(`${where}: id повторяется`);
    ids.add(v.id);
    if (!Array.isArray(v.segments) || v.segments.length === 0) {
      errors.push(`${where}: нет сегментов`);
      return;
    }
    const seed = hashSeed(`${input.storyId}:${v.id}`);
    const scenes: PlanScene[] = [];
    v.segments.forEach((sg, si) => {
      const at = `${where}, сегмент ${si}`;
      let start: number;
      let end: number;
      if (sg.replica !== undefined) {
        const rep = byId.get(sg.replica);
        if (!rep) {
          errors.push(`${at}: нет реплики ${sg.replica}`);
          return;
        }
        start = rep.start + (sg.cutStart ?? 0);
        end = rep.end - (sg.cutEnd ?? 0);
      } else if (typeof sg.start === "number" && typeof sg.end === "number") {
        start = sg.start;
        end = sg.end;
      } else {
        errors.push(`${at}: нужна replica или start/end`);
        return;
      }
      start = Math.max(0, start);
      end = Math.min(talk.duration, end);
      const len = end - start;
      if (len < 0.3) {
        errors.push(`${at}: отрезок короче 0,3 с (${round3(start)}–${round3(end)})`);
        return;
      }
      const view: View = sg.view ?? "close";
      if (view !== "close" && view !== "wide") errors.push(`${at}: view — close или wide`);
      const scene: PlanScene = {
        clipId: talk.name,
        file: talk.file,
        scene: si + 1,
        take: "",
        role: si === 0 ? "hook" : si === v.segments.length - 1 ? "final" : "body",
        duration: talk.duration,
        hasAudio: true,
        trim: { start: round3(start), end: round3(end) },
        ...(talk.crop ? { crop: talk.crop } : {}),
        // без зума и дрейфа: кадр ровно как выбран кропом
        zoom: { factor: 1, drift: 0 },
      };
      if (view === "wide") {
        if (!input.wide) errors.push(`${at}: перебивка дальним планом, а дальнего плана в сюжете нет`);
        else {
          const want = sg.wideAt ?? start + (layout.wideOffset ?? 0);
          const maxStart = Math.max(0, input.wide.duration - len);
          if (want > input.wide.duration - 0.1) warnings.push(`${at}: дальний план длиной ${round3(input.wide.duration)} с, взято с ${round3(Math.min(want, maxStart))} с`);
          scene.picture = { file: input.wide.file, start: round3(Math.min(Math.max(0, want), maxStart)), ...(input.wide.crop ? { crop: input.wide.crop } : {}) };
        }
      }
      if (sg.screenFile !== undefined && (sg.screen === undefined || sg.screen === null)) errors.push(`${at}: screenFile без screen — укажите секунду скринкаста`);
      if (sg.screen !== undefined && sg.screen !== null) {
        const scr = pickScreen(sg.screenFile);
        if (!screens.length) errors.push(`${at}: вставка экрана, а скринкаста в сюжете нет`);
        else if (!scr) errors.push(`${at}: нет скринкаста «${sg.screenFile}» (есть: ${screenNames})`);
        else {
          if (!sg.screenFile && screens.length > 1) warnings.push(`${at}: скринкастов несколько, screenFile не указан — взят «${scr.name}»`);
          const want = sg.screen === true ? start + (layout.screenOffset ?? 0) : Number(sg.screen);
          if (!Number.isFinite(want) || want < 0 || want >= scr.duration) {
            errors.push(`${at}: screen ${String(sg.screen)} вне скринкаста «${scr.name}» (0–${round3(scr.duration)} с)`);
          } else {
            const box = (view === "wide" ? layout.wideScreenBox : layout.closeScreenBox) ?? layout.wideScreenBox ?? DEFAULT_SCREEN_BOX;
            scene.inset = { file: scr.file, start: round3(want), box, ...(scr.crop ? { crop: scr.crop } : {}) };
          }
        }
      }
      scenes.push(scene);
    });
    if (scenes.length !== v.segments.length) return;

    const blocks: PlanBlock[] = [];
    for (const b of v.blocks ?? []) {
      if (!scenes[b.segment]) {
        errors.push(`${where}: плашка «${b.text}» ссылается на сегмент ${b.segment}, его нет`);
        continue;
      }
      blocks.push({ text: b.text, sceneIndex: b.segment, offset: b.offset ?? 0.2, duration: b.duration ?? 2 });
    }
    const extra = (["preset", "speed", "pitch"] as const).filter((k) => v[k] !== undefined);
    if (extra.length) warnings.push(`${where}: ${extra.join(", ")} в листе не используются — оформление, темп и голос одни на все варианты`);
    const firstText = (() => {
      const s0 = v.segments[0]!;
      const rep = s0.replica ? byId.get(s0.replica) : null;
      return rep ? hookFromTranscript(rep.text) : null;
    })();
    plans.push({
      version: 1,
      index: vi + 1,
      seed,
      preset,
      hook: { text: capitalize((v.hook ?? firstText ?? "").trim()), duration: v.hookDuration ?? 2.6 },
      scenes,
      blocks,
      speed: 1,
      pitch: 1,
      captions: v.captions ?? true,
      output: DEFAULT_OUTPUT,
    });
  });

  const openings = new Map<string, string[]>();
  for (const p of plans) {
    const s = p.scenes[0]!;
    const key = `${p.hook.text}|${s.trim.start}|${s.picture ? "wide" : "close"}`;
    openings.set(key, [...(openings.get(key) ?? []), String(p.index)]);
  }
  for (const [, same] of openings) {
    if (same.length > 1) warnings.push(`варианты ${same.join(", ")} начинаются одинаково (тот же хук, реплика и план) — площадки сочтут их дублями`);
  }
  return { plans, clips, errors, warnings };
}
