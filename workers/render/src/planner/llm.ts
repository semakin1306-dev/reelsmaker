import { groupScenes } from "../names.ts";
import type { PlanBlock, StoryInput, TextLlm, VariantPlan } from "../types.ts";

export interface LlmPlanReport {
  /** варианты, где хоть что-то взято у модели */
  applied: number;
  /** варианты, ответ по которым не прошёл проверку (остались на правилах) */
  rejected: number;
  /** общая ошибка (сеть, не JSON) — тогда все схемы остались на правилах */
  error?: string;
}

export interface LlmPlanResult {
  plans: VariantPlan[];
  report: LlmPlanReport;
}

const SYSTEM = [
  "Ты монтажёр коротких вертикальных роликов (Reels, Shorts). Тебе дают сцены сюжета с расшифровкой озвучки и черновые схемы монтажа.",
  "Для каждого варианта предложи: текст хука (первые 2–3 секунды, 3–60 символов, интригующий, без кликбейта-лжи, по-русски),",
  "порядок переставляемых сцен по смыслу расшифровки (только номера переставляемых сцен, каждая ровно один раз) и короткие подписи к сценам (до 40 символов).",
  "Хуки разных вариантов должны заметно отличаться. Отвечай ТОЛЬКО JSON без пояснений и без markdown:",
  '{"variants":[{"index":0,"hook":"...","order":[2,3],"blocks":{"2":"...","3":"..."}}]}',
].join("\n");

export function buildLlmPrompt(story: StoryInput, plans: readonly VariantPlan[]): string {
  const { scenes } = groupScenes(story.clips);
  const lines: string[] = [];
  lines.push(`Сюжет: ${story.title ?? story.id}`);
  if (story.theme) lines.push(`Тема: ${story.theme}`);
  lines.push("", "Сцены (номер, роль, расшифровка):");
  for (const s of scenes) {
    const text = s.takes[0]?.clip.transcript?.text?.trim() || "(без расшифровки)";
    lines.push(`- ${s.number} [${s.role === "hook" ? "хук, первая" : s.role === "final" ? "финал, последняя" : "переставляемая"}] ${text}`);
  }
  lines.push("", "Черновые схемы:");
  for (const p of plans) {
    const order = p.scenes.filter((x) => x.role === "body").map((x) => x.scene);
    lines.push(`- вариант ${p.index}: хук «${p.hook.text}», порядок переставляемых [${order.join(", ")}]`);
  }
  return lines.join("\n");
}

/** Достаёт первый JSON-объект из ответа (модель может обернуть его в ```json). */
export function parseJsonLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("в ответе модели нет JSON-объекта");
  return JSON.parse(body.slice(start, end + 1));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function samePermutation(order: unknown, expected: readonly number[]): order is number[] {
  if (!Array.isArray(order) || order.length !== expected.length) return false;
  const a = [...order].sort();
  const b = [...expected].sort();
  return a.every((v, i) => v === b[i]);
}

function cleanText(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Применяет ответ модели к схемам. Всё, что не прошло проверку, остаётся от правил:
 * хук и финал не двигаются, порядок — только перестановка переставляемых, хуки разных вариантов не совпадают.
 */
export function applyLlmAnswer(plans: readonly VariantPlan[], answer: unknown): LlmPlanResult {
  const out = plans.map((p) => structuredClone(p));
  const report: LlmPlanReport = { applied: 0, rejected: 0 };
  const list = isRecord(answer) && Array.isArray(answer["variants"]) ? (answer["variants"] as unknown[]) : null;
  if (!list) return { plans: out, report: { ...report, error: "в ответе нет массива variants" } };
  const usedHooks = new Set(out.map((p) => norm(p.hook.text)));

  for (const item of list) {
    if (!isRecord(item) || typeof item["index"] !== "number") continue;
    const plan = out.find((p) => p.index === item["index"]);
    if (!plan) continue;
    let touched = false;
    let bad = false;

    const hook = cleanText(item["hook"], 3, 60);
    if (item["hook"] !== undefined) {
      if (!hook) bad = true;
      else {
        const key = norm(hook);
        if (key !== norm(plan.hook.text) && usedHooks.has(key)) bad = true;
        else {
          usedHooks.delete(norm(plan.hook.text));
          usedHooks.add(key);
          plan.hook.text = hook;
          touched = true;
        }
      }
    }

    if (item["order"] !== undefined) {
      const bodyIdx = plan.scenes.map((s, i) => (s.role === "body" ? i : -1)).filter((i) => i >= 0);
      const expected = bodyIdx.map((i) => (plan.scenes[i] as { scene: number }).scene);
      if (!samePermutation(item["order"], expected)) bad = true;
      else {
        // схема хранит выбранный дубль каждой сцены: переставляем готовые элементы, не пересобирая дубли
        const byNumber = new Map(bodyIdx.map((i) => [(plan.scenes[i] as { scene: number }).scene, plan.scenes[i]!]));
        const oldIndexOf = new Map(bodyIdx.map((i) => [(plan.scenes[i] as { scene: number }).scene, i]));
        const newScenes = plan.scenes.slice();
        (item["order"] as number[]).forEach((num, k) => {
          newScenes[bodyIdx[k] as number] = byNumber.get(num)!;
        });
        // блоки привязаны к индексу сцены: переносим вместе со сценой
        const newIndexOf = new Map<number, number>();
        (item["order"] as number[]).forEach((num, k) => newIndexOf.set(oldIndexOf.get(num)!, bodyIdx[k] as number));
        // нумерованные подписи («Шаг 2», «2/3») после перестановки врут — убираем; подписи словом едут со сценой
        plan.blocks = plan.blocks
          .filter((b) => !/^(Шаг \d+|\d+\/\d+)$/u.test(b.text))
          .map((b) => ({ ...b, sceneIndex: newIndexOf.get(b.sceneIndex) ?? b.sceneIndex }));
        plan.scenes = newScenes;
        touched = true;
      }
    }

    if (item["blocks"] !== undefined) {
      if (!isRecord(item["blocks"])) bad = true;
      else {
        const labels = item["blocks"];
        const blocks: PlanBlock[] = [];
        for (let si = 0; si < plan.scenes.length; si++) {
          const s = plan.scenes[si]!;
          if (s.role !== "body") continue;
          const text = cleanText(labels[String(s.scene)], 1, 40);
          if (!text) continue;
          const len = s.trim.end - s.trim.start;
          if (len < 1.6) continue;
          const old = plan.blocks.find((b) => b.sceneIndex === si);
          const offset = old?.offset ?? 0.4;
          blocks.push({ text, sceneIndex: si, offset, duration: Math.round(Math.min(2.2, len - offset - 0.3) * 100) / 100 });
        }
        plan.blocks = blocks;
        touched = true;
      }
    }

    if (touched) report.applied += 1;
    if (bad) report.rejected += 1;
  }
  return { plans: out, report };
}

/** Просит у модели хуки, подписи и порядок; при любой ошибке возвращает схемы правил как есть. */
export async function enhancePlansWithLlm(
  story: StoryInput,
  plans: readonly VariantPlan[],
  llm: TextLlm,
): Promise<LlmPlanResult> {
  try {
    const text = await llm.complete({ system: SYSTEM, prompt: buildLlmPrompt(story, plans), maxTokens: 2000 });
    return applyLlmAnswer(plans, parseJsonLoose(text));
  } catch (e) {
    return {
      plans: plans.map((p) => structuredClone(p)),
      report: { applied: 0, rejected: 0, error: (e as Error).message },
    };
  }
}
