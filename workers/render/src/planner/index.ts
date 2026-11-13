import type { PlanResult, StoryInput, TextLlm } from "../types.ts";
import { enhancePlansWithLlm, type LlmPlanReport } from "./llm.ts";
import { planVariants, type PlanOptions } from "./rules.ts";

export interface PlanStoryOptions extends PlanOptions {
  /** клиент Claude; без него (или с useLlm=false) работают только правила */
  llm?: TextLlm;
  /** флаг конфига: включить Claude для хуков, подписей и порядка */
  useLlm?: boolean;
}

export interface PlanStoryResult extends PlanResult {
  llm?: LlmPlanReport;
}

/** Схемы монтажа для сюжета: правила, затем (за флагом и при наличии клиента) Claude. */
export async function planStory(story: StoryInput, opts: PlanStoryOptions): Promise<PlanStoryResult> {
  const base = planVariants(story, opts);
  if (!opts.useLlm) return base;
  if (!opts.llm) {
    return { ...base, warnings: [...base.warnings, "useLlm включён, но клиент Claude не задан (нет ключа): работают правила"] };
  }
  const res = await enhancePlansWithLlm(story, base.plans, opts.llm);
  const warnings = [...base.warnings];
  if (res.report.error) warnings.push(`Claude: ${res.report.error}; схемы остались на правилах`);
  return { plans: res.plans, warnings, llm: res.report };
}

export { planVariants, openingKey, type PlanOptions } from "./rules.ts";
export { enhancePlansWithLlm, applyLlmAnswer, parseJsonLoose, buildLlmPrompt } from "./llm.ts";
