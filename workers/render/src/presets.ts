import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Каталог пресетов в репозитории: workers/render/presets (JSON, шрифты, LUT). */
export const PRESETS_DIR = fileURLToPath(new URL("../presets/", import.meta.url));

/** Стиль текстового слоя (ASS). Цвета — "#RRGGBB" или "#RRGGBBAA" (AA — непрозрачность, FF = полностью). */
export interface TextStyle {
  /** семейство, как оно записано внутри файла шрифта (его ищет libass по fontsdir) */
  font: string;
  /** файл шрифта из presets/fonts */
  fontFile: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  outlineColor: string;
  outline: number;
  shadow: number;
  /** 1 — контур, 3 — плашка (цвет плашки = outlineColor, отступ = outline) */
  borderStyle: 1 | 3;
  /** раскладка клавиатуры numpad: 2 — снизу по центру, 8 — сверху, 5 — по центру */
  alignment: number;
  marginV: number;
  marginH: number;
  uppercase: boolean;
  spacing: number;
}

export interface CaptionStyle extends TextStyle {
  maxWords: number;
  /** не длиннее стольких символов на кусок субтитров (0 — без предела): одна строка, без переноса на лицо */
  maxChars: number;
  /** подсветка текущего слова (караоке) */
  karaoke: boolean;
  highlight: string;
}

export interface Grade {
  eq?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number };
  /** имя пресета фильтра curves (`strong_contrast`, `vintage`, …) */
  curves?: string;
  /** файл .cube из presets/luts */
  lut?: string;
  vignette?: boolean;
  /** сила зерна 0–20, 0 — без */
  grain?: number;
  sharpen?: boolean;
}

export interface Preset {
  id: string;
  title: string;
  grade: Grade;
  hook: TextStyle;
  caption: CaptionStyle;
  block: TextStyle;
}

function fail(path: string, why: string): never {
  throw new Error(`пресет: ${path} — ${why}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "ожидался объект");
  return v as Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string, path: string, def?: string): string {
  const v = o[k];
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== "string" || v === "") fail(`${path}.${k}`, "ожидалась непустая строка");
  return v;
}

function num(o: Record<string, unknown>, k: string, path: string, def?: number): number {
  const v = o[k];
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${path}.${k}`, "ожидалось число");
  return v;
}

function bool(o: Record<string, unknown>, k: string, def: boolean): boolean {
  const v = o[k];
  return typeof v === "boolean" ? v : def;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

function color(o: Record<string, unknown>, k: string, path: string, def?: string): string {
  const v = str(o, k, path, def);
  if (!COLOR_RE.test(v)) fail(`${path}.${k}`, `цвет «${v}» не в формате #RRGGBB[AA]`);
  return v;
}

function parseStyle(raw: unknown, path: string): TextStyle {
  const o = obj(raw, path);
  const font = str(o, "font", path);
  const fontFile = str(o, "fontFile", path);
  const alignment = num(o, "alignment", path, 2);
  if (!Number.isInteger(alignment) || alignment < 1 || alignment > 9) fail(`${path}.alignment`, "1–9");
  const borderStyle = num(o, "borderStyle", path, 1);
  if (borderStyle !== 1 && borderStyle !== 3) fail(`${path}.borderStyle`, "1 или 3");
  const size = num(o, "size", path);
  if (size < 10 || size > 400) fail(`${path}.size`, "10–400");
  return {
    font,
    fontFile,
    size,
    bold: bool(o, "bold", false),
    italic: bool(o, "italic", false),
    color: color(o, "color", path, "#FFFFFF"),
    outlineColor: color(o, "outlineColor", path, "#000000"),
    outline: num(o, "outline", path, 4),
    shadow: num(o, "shadow", path, 0),
    borderStyle,
    alignment,
    marginV: num(o, "marginV", path, 200),
    marginH: num(o, "marginH", path, 60),
    uppercase: bool(o, "uppercase", false),
    spacing: num(o, "spacing", path, 0),
  };
}

export function validatePreset(raw: unknown): Preset {
  const o = obj(raw, "$");
  const id = str(o, "id", "$");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail("$.id", "латиница, цифры и дефис");
  const gradeRaw = o["grade"] === undefined ? {} : obj(o["grade"], "$.grade");
  const grade: Grade = {};
  if (gradeRaw["eq"] !== undefined) {
    const e = obj(gradeRaw["eq"], "$.grade.eq");
    grade.eq = {};
    for (const k of ["brightness", "contrast", "saturation", "gamma"] as const) {
      if (e[k] !== undefined) grade.eq[k] = num(e, k, "$.grade.eq");
    }
  }
  if (gradeRaw["curves"] !== undefined) grade.curves = str(gradeRaw, "curves", "$.grade");
  if (gradeRaw["lut"] !== undefined) {
    grade.lut = str(gradeRaw, "lut", "$.grade");
    if (!/^[\w.-]+\.cube$/.test(grade.lut)) fail("$.grade.lut", "имя файла .cube без пути");
  }
  grade.vignette = bool(gradeRaw, "vignette", false);
  grade.grain = num(gradeRaw, "grain", "$.grade", 0);
  grade.sharpen = bool(gradeRaw, "sharpen", false);
  const capRaw = obj(o["caption"], "$.caption");
  const caption: CaptionStyle = {
    ...parseStyle(capRaw, "$.caption"),
    maxWords: num(capRaw, "maxWords", "$.caption", 3),
    maxChars: num(capRaw, "maxChars", "$.caption", 0),
    karaoke: bool(capRaw, "karaoke", false),
    highlight: color(capRaw, "highlight", "$.caption", "#FFE14D"),
  };
  return {
    id,
    title: str(o, "title", "$", id),
    grade,
    hook: parseStyle(o["hook"], "$.hook"),
    caption,
    block: parseStyle(o["block"], "$.block"),
  };
}

/** Читает все `*.json` каталога пресетов. */
export function loadPresets(dir: string): Preset[] {
  const out: Preset[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (e) {
      throw new Error(`пресет ${name}: не JSON (${(e as Error).message})`);
    }
    try {
      out.push(validatePreset(parsed));
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
  const ids = new Set<string>();
  for (const p of out) {
    if (ids.has(p.id)) throw new Error(`пресет ${p.id}: id встречается дважды`);
    ids.add(p.id);
  }
  return out;
}
