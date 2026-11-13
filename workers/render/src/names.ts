import type { ClipInput, ParsedName, Role, Scene, SceneTake } from "./types.ts";

const HOOK_WORDS = new Set(["хук", "hook"]);
const FINAL_WORDS = new Set(["финал", "final"]);

function baseName(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const name = slash >= 0 ? file.slice(slash + 1) : file;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Имя сценки: `NN[дубль]_<роль>_<слово>.mp4`, например `01_хук_привет`, `02a_кофе`, `09_финал`.
 * Роли `хук` и `финал` — второй сегмент имени; всё остальное — переставляемая сцена.
 * Имя без номера в начале — null (такой файл сюжет не принимает).
 */
export function parseClipName(file: string): ParsedName | null {
  const name = baseName(file);
  const m = /^(\d{1,3})([a-zа-я]?)(?:[_\- ]+(.*))?$/iu.exec(name);
  if (!m) return null;
  const scene = Number(m[1]);
  const take = (m[2] ?? "").toLowerCase();
  const rest = (m[3] ?? "").split(/[_\- ]+/u).filter(Boolean);
  const first = (rest[0] ?? "").toLowerCase();
  let role: Role = "body";
  let words = rest;
  if (HOOK_WORDS.has(first)) {
    role = "hook";
    words = rest.slice(1);
  } else if (FINAL_WORDS.has(first)) {
    role = "final";
    words = rest.slice(1);
  }
  return { scene, take, role, word: words.join(" ") };
}

export interface GroupResult {
  scenes: Scene[];
  /** файлы, которые не удалось разобрать */
  skipped: string[];
  errors: string[];
}

/** Группирует сценки в сцены (дубли одного номера — takes), сцены по возрастанию номера. */
export function groupScenes(clips: readonly ClipInput[]): GroupResult {
  const byScene = new Map<number, { role: Role; takes: SceneTake[] }>();
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const clip of clips) {
    const parsed = parseClipName(clip.file);
    if (!parsed) {
      skipped.push(clip.file);
      continue;
    }
    let entry = byScene.get(parsed.scene);
    if (!entry) {
      entry = { role: parsed.role, takes: [] };
      byScene.set(parsed.scene, entry);
    } else if (entry.role !== parsed.role && parsed.role !== "body") {
      // дубли одной сцены с разной ролью: приоритет у явно названной
      if (entry.role === "body") entry.role = parsed.role;
      else errors.push(`сцена ${parsed.scene}: у дублей разные роли`);
    }
    entry.takes.push({ clip, take: parsed.take, word: parsed.word });
  }
  const scenes: Scene[] = [...byScene.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, v]) => ({
      number,
      role: v.role,
      takes: v.takes.sort((a, b) => a.take.localeCompare(b.take)),
    }));
  return { scenes, skipped, errors };
}
