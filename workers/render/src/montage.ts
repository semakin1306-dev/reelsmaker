// Монтаж из исходников: одно видео со звуком (основа, крупный план) режется на реплики; варианты собираются из реплик
// по монтажному листу (edit.json), который пишет агент-монтажёр. Перебивки — дальним планом, вставки — скринкастом.
// Звук и субтитры с основы — или, если в сюжете есть озвучка (отдельные аудиофайлы, дублей может быть несколько), с неё:
// каждый файл режется на свои реплики (a01…, b01…, по букве на файл), а картинка (крупный, дальний, экран) берётся
// из видео как обычно. Владелец может отключить звук видео совсем (mute): тогда ролик без звука, пока не пришла озвучка. Оформление (пресет, цвет, скорость, высота звука, зум) — как у обычных вариантов:
// задано в листе — берётся оттуда, нет — раздаётся по вариантам автоматически, чтобы варианты различались.
import { hashSeed } from "./rng.ts";
import { capitalize, hookFromTranscript } from "./planner/rules.ts";
import { DEFAULT_OUTPUT, SAFE_BOX, type Box, type Crop, type ClipInput, type PlanBlock, type PlanScene, type Transcript, type VariantPlan } from "./types.ts";

export interface Replica {
  /** r01, r02… по порядку в основе; у озвучки — буква файла и номер: a01, b01… */
  id: string;
  /** озвучка: имя файла, из которого реплика (у реплик основы нет) */
  source?: string;
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
  /** буква номера реплики: r (основа), a (озвучка) */
  prefix?: string;
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
      id: `${opts.prefix ?? "r"}${String(i + 1).padStart(2, "0")}`,
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
  /** реплика озвучки (a01, b03…) — когда в сюжете есть озвучка: звук и длина сегмента берутся из неё */
  voice?: string;
  /** озвучка: файл для start/end, когда озвучек несколько (имя, можно без расширения) */
  voiceFile?: string;
  /** явный отрезок источника звука (основы или озвучки), с */
  start?: number;
  end?: number;
  /** озвучка: с какой секунды основы показывать крупный план; нет — та же секунда, что у звука, + layout.talkOffset */
  at?: number;
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
  /** подпись сцены для владельца: что говорится и что на экране; на сборку не влияет, показывается на странице в плане варианта */
  note?: string;
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
  /** сдвиг крупного плана относительно озвучки, с (только при озвучке) */
  talkOffset?: number;
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
  /** озвучка: отдельные аудиофайлы (дубли) — источник звука и субтитров вместо основы */
  voices?: (MontageSource & { transcript: Transcript | null })[];
  /** реплики всех озвучек (у каждой source — файл) */
  voiceReplicas?: Replica[];
  /** звук видео отключён: без озвучки ролик получается без звука и без субтитров */
  mute?: boolean;
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

/** Кадр держится меньше — картинка «скачет», смотреть тяжело (жалоба владельца на ролики с частой сменой). */
export const MIN_SHOT = 2.5;

/**
 * «Кадр» — подряд идущие сцены с одной и той же картинкой без скачка: скринкаст продолжает себя с того же места,
 * фон идёт дальше. Разрез звука посреди кадра (вырезанная пауза) кадром не считается.
 */
export function shotsOf(scenes: readonly PlanScene[]): { from: number; to: number; len: number }[] {
  const shots: { from: number; to: number; len: number }[] = [];
  const EPS = 0.15;
  scenes.forEach((s, i) => {
    const len = s.trim.end - s.trim.start;
    const prev = i > 0 ? scenes[i - 1]! : null;
    let same = false;
    if (prev) {
      const pl = prev.trim.end - prev.trim.start;
      const screen = (prev.inset?.file ?? null) === (s.inset?.file ?? null) && (!s.inset || Math.abs(s.inset.start - (prev.inset!.start + pl)) <= EPS);
      // фон: своя картинка (picture) должна продолжаться; без неё картинка — сам отрезок основы
      const pic = (prev.picture?.file ?? prev.file) === (s.picture?.file ?? s.file) &&
        (s.picture && prev.picture ? Math.abs(s.picture.start - (prev.picture.start + pl)) <= EPS : !s.picture && !prev.picture ? Math.abs(s.trim.start - prev.trim.end) <= EPS : false);
      same = screen && pic;
    }
    if (same) {
      const last = shots[shots.length - 1]!;
      last.to = i;
      last.len += len;
    } else shots.push({ from: i, to: i, len });
  });
  return shots;
}

export interface MontageResult {
  plans: VariantPlan[];
  /** файлы для словаря клипов рендера: источник звука (основа или озвучка) с расшифровкой — для субтитров */
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
  const voices = input.voices ?? [];
  const voiced = voices.length > 0;
  /** звук видео отключён и озвучки нет: ролик без звука */
  const mute = !voiced && input.mute === true;
  // с озвучкой реплики — её (a01, b01…): звук и субтитры берутся из неё, а видео даёт только картинку
  const byId = new Map((voiced ? (input.voiceReplicas ?? []) : input.replicas).map((r) => [r.id, r]));
  const normName = (x: string) => x.toLowerCase().replace(/\.[^.]+$/, "").trim();
  const voiceNames = voices.map((x) => x.name).join(", ");
  /** озвучка по имени файла (можно без расширения); без имени — единственная */
  const pickVoice = (name: string | undefined) => {
    if (!name) return voices.length === 1 ? voices[0]! : null;
    return voices.find((x) => x.name === name) ?? voices.find((x) => normName(x.name) === normName(name)) ?? null;
  };
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
  const clips = new Map<string, ClipInput>();
  if (voiced) {
    for (const x of voices) clips.set(x.name, { id: x.name, file: x.file, duration: x.duration, hasAudio: true, transcript: x.transcript ?? undefined });
  } else {
    clips.set(talk.name, { id: talk.name, file: talk.file, duration: talk.duration, hasAudio: !mute, transcript: mute ? undefined : (talk.transcript ?? undefined) });
    if (mute) warnings.push("звук видео отключён, озвучки нет — ролики соберутся без звука и без субтитров (запишите озвучку или положите аудиофайл в папку сюжета)");
  }
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
      if (voiced && sg.replica !== undefined) {
        errors.push(`${at}: в сюжете есть озвучка — звук берётся из неё, укажите "voice": "a01" (реплики основы r.. не используются)`);
        return;
      }
      if (!voiced && sg.voice !== undefined) {
        errors.push(`${at}: voice «${sg.voice}», а озвучки в сюжете нет`);
        return;
      }
      // источник звука сегмента: файл озвучки (по реплике или по voiceFile) либо основа
      let sound: MontageSource = talk;
      const ref = voiced ? sg.voice : sg.replica;
      if (ref !== undefined) {
        const rep = byId.get(ref);
        if (!rep) {
          errors.push(`${at}: нет реплики ${ref}`);
          return;
        }
        if (voiced) sound = pickVoice(rep.source) ?? voices[0]!;
        start = rep.start + (sg.cutStart ?? 0);
        end = rep.end - (sg.cutEnd ?? 0);
      } else if (typeof sg.start === "number" && typeof sg.end === "number") {
        if (voiced) {
          const vf = pickVoice(sg.voiceFile);
          if (!vf) {
            errors.push(`${at}: ${sg.voiceFile ? `нет озвучки «${sg.voiceFile}»` : "озвучек несколько — укажите voiceFile"} (есть: ${voiceNames})`);
            return;
          }
          sound = vf;
        }
        start = sg.start;
        end = sg.end;
      } else {
        errors.push(`${at}: нужна ${voiced ? "voice" : "replica"} или start/end`);
        return;
      }
      if (sg.voiceFile !== undefined && !voiced) warnings.push(`${at}: voiceFile без озвучки в сюжете — не используется`);
      start = Math.max(0, start);
      end = Math.min(sound.duration, end);
      const len = end - start;
      if (len < 0.3) {
        errors.push(`${at}: отрезок короче 0,3 с (${round3(start)}–${round3(end)})`);
        return;
      }
      const view: View = sg.view ?? "close";
      if (view !== "close" && view !== "wide") errors.push(`${at}: view — close или wide`);
      const scene: PlanScene = {
        clipId: sound.name,
        file: sound.file,
        scene: si + 1,
        take: "",
        role: si === 0 ? "hook" : si === v.segments.length - 1 ? "final" : "body",
        duration: sound.duration,
        hasAudio: voiced || !mute,
        trim: { start: round3(start), end: round3(end) },
        ...(!voiced && talk.crop ? { crop: talk.crop } : {}),
        // без зума и дрейфа: кадр ровно как выбран кропом
        zoom: { factor: 1, drift: 0 },
      };
      if (sg.at !== undefined && !voiced) warnings.push(`${at}: at работает только при озвучке — крупный план без озвучки идёт со звуком основы`);
      if (voiced && view === "close") {
        // крупный план при озвучке — тоже «картинка из другого файла»: звук с озвучки, картинка с основы
        const want = sg.at ?? start + (layout.talkOffset ?? 0);
        const maxStart = Math.max(0, talk.duration - len);
        if (!Number.isFinite(want) || want < 0) errors.push(`${at}: at ${String(sg.at)} — секунда основы, от 0`);
        else {
          if (want > talk.duration - 0.1) warnings.push(`${at}: основа длиной ${round3(talk.duration)} с, взято с ${round3(Math.min(want, maxStart))} с`);
          scene.picture = { file: talk.file, start: round3(Math.min(want, maxStart)), ...(talk.crop ? { crop: talk.crop } : {}) };
        }
      }
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
    for (const sh of shotsOf(scenes)) {
      if (sh.len < MIN_SHOT - 0.05) {
        warnings.push(`${where}: кадр держится ${sh.len.toFixed(1).replace(".", ",")} с (${sh.from === sh.to ? `сцена ${sh.from + 1}` : `сцены ${sh.from + 1}–${sh.to + 1}`}) — короче ${String(MIN_SHOT).replace(".", ",")} с, картинка будет скакать; объедините с соседней или удлините`);
      }
    }

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
      const first = voiced ? s0.voice : s0.replica;
      const rep = first ? byId.get(first) : null;
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
    const key = `${p.hook.text}|${s.trim.start}|${s.picture ? s.picture.file : "close"}|${s.picture ? s.picture.start : ""}`;
    openings.set(key, [...(openings.get(key) ?? []), String(p.index)]);
  }
  for (const [, same] of openings) {
    if (same.length > 1) warnings.push(`варианты ${same.join(", ")} начинаются одинаково (тот же хук, реплика и план) — площадки сочтут их дублями`);
  }
  return { plans, clips, errors, warnings };
}
