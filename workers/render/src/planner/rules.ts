import { groupScenes } from "../names.ts";
import { between, hashSeed, mulberry32, shuffle } from "../rng.ts";
import {
  DEFAULT_OUTPUT,
  type OutputFormat,
  type PlanBlock,
  type PlanResult,
  type PlanScene,
  type Scene,
  type SceneTake,
  type StoryInput,
  type Trim,
  type VariantPlan,
} from "../types.ts";

export interface PlanOptions {
  /** сколько вариантов, по умолчанию 10 */
  count?: number;
  /** id пресетов оформления, которые можно назначать */
  presets: readonly string[];
  output?: OutputFormat;
}

const HOOK_TEMPLATES = [
  "Смотри до конца",
  "Это нужно увидеть",
  "Никто не ждал такого",
  "Не листай — дальше самое интересное",
  "Ты точно такое видел?",
  "Я не поверил своим глазам",
  "Подожди до конца",
  "Спорим, не угадаешь, чем закончится?",
  "Три секунды — и ты залип",
  "Сохрани, чтобы не потерять",
  "Такое бывает только раз",
  "Досмотри — не пожалеешь",
];

const THEME_TEMPLATES = [
  "Вот что бывает, когда {theme}",
  "Всё про {theme} за 15 секунд",
  "{theme}: смотри до конца",
  "Почему все говорят про {theme}",
];

const SPEED_POOL = [1.03, 0.97, 1.05, 0.96, 1.04, 0.98, 1.02, 0.95, 1.035, 0.965];
const MAX_HOOK_CHARS = 60;

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function clipText(s: string, max = MAX_HOOK_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[,;:\-—\s]+$/u, "");
}

/** Первое предложение расшифровки хук-сценки, не длиннее 8 слов — «естественный» хук. */
export function hookFromTranscript(text: string | undefined): string | null {
  if (!text) return null;
  const sentence = text.trim().split(/(?<=[.!?…])\s+/u)[0] ?? "";
  const words = sentence.replace(/[.!?…]+$/u, "").split(/\s+/u).filter(Boolean);
  if (words.length < 2) return null;
  return clipText(capitalize(words.slice(0, 8).join(" ")));
}

/** Пул хуков: сначала «естественный» из расшифровки, дальше перемешанные шаблоны (с темой — если она задана). */
export function buildHookPool(story: StoryInput, hookScene: Scene | undefined, seed: number): string[] {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const pool: string[] = [];
  const natural = hookFromTranscript(hookScene?.takes[0]?.clip.transcript?.text);
  if (natural) pool.push(natural);
  const theme = (story.theme ?? story.title ?? "").trim();
  const plain = shuffle(HOOK_TEMPLATES, rng);
  const themed = theme ? shuffle(THEME_TEMPLATES, rng).map((t) => clipText(t.replace("{theme}", theme))) : [];
  // шаблоны с темой и без чередуем: тема попадает в хуки даже при малом числе вариантов
  for (let i = 0; i < Math.max(plain.length, themed.length); i++) {
    for (const t of [plain[i], themed[i]]) if (t && !pool.includes(t)) pool.push(t);
  }
  return pool;
}

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** N разных порядков переставляемых элементов; первый — исходный. Если перестановок меньше N, повторяет по кругу. */
export function pickOrders<T>(items: readonly T[], count: number, seed: number): T[][] {
  const rng = mulberry32(seed ^ 0x51ed270b);
  const identity = items.slice();
  const orders: T[][] = [identity];
  if (items.length < 2) {
    while (orders.length < count) orders.push(identity.slice());
    return orders.slice(0, count);
  }
  const idx = identity.map((_, i) => i);
  const seen = new Set<string>([idx.join(",")]);
  const target = Math.min(count, factorial(items.length));
  let guard = 0;
  while (orders.length < target && guard++ < 5000) {
    const perm = shuffle(idx, rng);
    const key = perm.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    orders.push(perm.map((i) => identity[i] as T));
  }
  // перестановок меньше, чем вариантов: повторы идут со сдвигом на круг, чтобы пара «порядок + чётность дубля» не совпадала
  const unique = orders.length;
  for (let i = unique; i < count; i++) orders.push((orders[(i + Math.floor(i / unique)) % unique] as T[]).slice());
  return orders.slice(0, count);
}

/** Сдвиг высоты звука должен быть заметен для отпечатка звука: не ближе 0.4% к единице. */
function nonTrivialPitch(p: number): number {
  return Math.abs(p - 1) < 0.004 ? (p >= 1 ? 1.004 : 0.996) : p;
}

function trimFor(take: SceneTake, role: Scene["role"], tailPad: number): Trim {
  const d = take.clip.duration;
  const words = take.clip.transcript?.words ?? [];
  const last = words[words.length - 1];
  // хвост тишины режем только у переставляемых сцен и только заметный (≥0.3 с)
  if (role === "body" && last && last.end + tailPad < d - 0.3) {
    return { start: 0, end: Math.max(0.5, Math.round((last.end + tailPad) * 100) / 100) };
  }
  return { start: 0, end: d };
}

function blockLabel(style: string, take: SceneTake, k: number, total: number): string | null {
  switch (style) {
    case "word":
      return take.word ? capitalize(take.word) : null;
    case "step":
      return `Шаг ${k}`;
    case "count":
      return `${k}/${total}`;
    default:
      return null;
  }
}

export function planVariants(story: StoryInput, opts: PlanOptions): PlanResult {
  const count = opts.count ?? 10;
  if (!Number.isInteger(count) || count < 1) throw new Error("planVariants: count должен быть целым ≥ 1");
  if (opts.presets.length === 0) throw new Error("planVariants: не заданы пресеты оформления");
  const warnings: string[] = [];
  const grouped = groupScenes(story.clips);
  for (const f of grouped.skipped) warnings.push(`файл «${f}» пропущен: в имени нет номера сцены`);
  warnings.push(...grouped.errors);
  const scenes = grouped.scenes;
  if (scenes.length === 0) throw new Error(`сюжет ${story.id}: нет ни одной сцены с номером в имени`);

  const hooks = scenes.filter((s) => s.role === "hook");
  let hookScene = hooks[0];
  if (hooks.length > 1) warnings.push(`несколько сцен «хук» (${hooks.map((h) => h.number).join(", ")}); хуком взята первая`);
  if (!hookScene) {
    hookScene = scenes[0] as Scene;
    warnings.push(`нет сцены «хук»: первой остаётся сцена ${hookScene.number}`);
  }
  const finals = scenes.filter((s) => s.role === "final" && s !== hookScene);
  const finalScene = finals[finals.length - 1];
  if (finals.length > 1) warnings.push(`несколько сцен «финал»; финалом взята последняя (${finalScene?.number})`);
  const fixed = new Set<Scene>([hookScene]);
  if (finalScene) fixed.add(finalScene);
  const movable = scenes.filter((s) => !fixed.has(s));
  const ordinal = new Map<Scene, number>(scenes.map((s, i) => [s, i]));

  const storySeed = hashSeed(story.id);
  const orders = pickOrders(movable, count, storySeed);
  const presetOrder = shuffle(opts.presets, mulberry32(storySeed ^ 0xa5a5a5a5));
  const hookPool = buildHookPool(story, hookScene, storySeed);
  if (hookPool.length < count) {
    warnings.push(`хуков в пуле ${hookPool.length}, вариантов ${count}: часть хуков повторится (отличаются дубли, порядок и оформление)`);
  }
  const speeds = shuffle(SPEED_POOL, mulberry32(storySeed ^ 0x3c6ef372));
  const labelStyles = shuffle(["word", "step", "count", "none"], mulberry32(storySeed ^ 0x1b873593));
  const output = opts.output ?? DEFAULT_OUTPUT;
  const hasWords = story.clips.some((c) => (c.transcript?.words.length ?? 0) > 0);

  const plans: VariantPlan[] = [];
  for (let i = 0; i < count; i++) {
    const seed = hashSeed(`${story.id}:${i}`);
    const rng = mulberry32(seed);
    const sequence: Scene[] = [hookScene, ...(orders[i] as Scene[]), ...(finalScene ? [finalScene] : [])];
    const style = labelStyles[i % labelStyles.length] as string;
    const planScenes: PlanScene[] = [];
    const blocks: PlanBlock[] = [];
    let bodyK = 0;
    for (const scene of sequence) {
      // дубли чередуются между вариантами; смещение по номеру сцены разводит сцены между собой
      const take = scene.takes[(i + (ordinal.get(scene) ?? 0)) % scene.takes.length] as SceneTake;
      const trim = trimFor(take, scene.role, between(rng, 0.25, 0.6, 2));
      const sign = rng() < 0.5 ? -1 : 1;
      planScenes.push({
        clipId: take.clip.id,
        file: take.clip.file,
        scene: scene.number,
        take: take.take,
        role: scene.role,
        duration: take.clip.duration,
        hasAudio: take.clip.hasAudio ?? true,
        trim,
        zoom: { factor: between(rng, 1.04, 1.1, 3), drift: sign * between(rng, 0.3, 0.9, 2) },
      });
      if (scene !== hookScene && scene !== finalScene) {
        bodyK += 1;
        const len = trim.end - trim.start;
        const text = len >= 1.6 ? blockLabel(style, take, bodyK, movable.length) : null;
        if (text) {
          const offset = between(rng, 0.25, 0.6, 2);
          blocks.push({
            text,
            sceneIndex: planScenes.length - 1,
            offset,
            duration: Math.round(Math.min(2.2, len - offset - 0.3) * 100) / 100,
          });
        }
      }
    }
    const hookClip = planScenes[0] as PlanScene;
    const hookLen = hookClip.trim.end - hookClip.trim.start;
    plans.push({
      version: 1,
      index: i,
      seed,
      preset: presetOrder[i % presetOrder.length] as string,
      hook: {
        text: hookPool[i % hookPool.length] as string,
        duration: Math.round(Math.min(hookLen, between(rng, 2.2, 3, 2)) * 100) / 100,
      },
      scenes: planScenes,
      blocks,
      speed: speeds[i % speeds.length] as number,
      pitch: nonTrivialPitch(between(rng, 0.98, 1.02, 3)),
      captions: hasWords,
      output,
    });
  }
  return { plans, warnings };
}

/** «Первые секунды» варианта: дубль хука, текст хука, второй план. Нужен для проверки разнообразия. */
export function openingKey(plan: VariantPlan): string {
  const first = plan.scenes[0];
  const second = plan.scenes[1];
  return [first?.clipId, plan.hook.text, second?.clipId].join("|");
}
