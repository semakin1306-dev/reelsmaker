// Оформление из интерфейса: шрифт, размер и цвета заголовка, субтитров и плашек — поверх встроенного пресета.
// Хранится в <папка данных>/style.json, свои шрифты — в <папка данных>/fonts. Одно на все варианты и сюжеты.
import { readFile, writeFile } from "node:fs/promises";
import type { FontInfo, Preset, TextStyle } from "@reels-factory/render";

export const LAYERS = ["hook", "caption", "block"] as const;
export type Layer = (typeof LAYERS)[number];
export const LAYER_TITLE: Record<Layer, string> = { hook: "заголовок-хук", caption: "субтитры", block: "плашки" };

/** Что владелец может поменять в слое. */
export interface LayerStyle {
  /** имя файла шрифта (встроенного или своего) */
  fontFile?: string;
  size?: number;
  color?: string;
  outlineColor?: string;
  outline?: number;
}
export type StyleOverride = Partial<Record<Layer, LayerStyle>>;

const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export async function readStyle(file: string): Promise<StyleOverride> {
  try {
    return cleanStyle(JSON.parse(await readFile(file, "utf8")), null);
  } catch {
    return {};
  }
}

export async function writeStyle(file: string, style: StyleOverride): Promise<void> {
  await writeFile(file, JSON.stringify(style, null, 2), "utf8");
}

/**
 * Проверяет присланное оформление. fonts — какие шрифты есть (null — не проверять наличие, при чтении файла).
 * Ошибка называет слой и поле.
 */
export function cleanStyle(raw: unknown, fonts: readonly FontInfo[] | null): StyleOverride {
  if (!raw || typeof raw !== "object") throw new Error("оформление — объект {hook, caption, block}");
  const out: StyleOverride = {};
  for (const layer of LAYERS) {
    const v = (raw as Record<string, unknown>)[layer];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object") throw new Error(`${LAYER_TITLE[layer]}: ожидался объект`);
    const o = v as Record<string, unknown>;
    const st: LayerStyle = {};
    if (o["fontFile"] !== undefined && o["fontFile"] !== "") {
      const name = String(o["fontFile"]);
      if (fonts && !fonts.some((f) => f.file.toLowerCase() === name.toLowerCase())) throw new Error(`${LAYER_TITLE[layer]}: нет шрифта «${name}»`);
      st.fontFile = name;
    }
    const num = (k: "size" | "outline", min: number, max: number) => {
      if (o[k] === undefined || o[k] === "") return;
      const n = Number(o[k]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${LAYER_TITLE[layer]}: ${k === "size" ? "размер" : "обводка"} — от ${min} до ${max}`);
      st[k] = Math.round(n);
    };
    num("size", 20, 200);
    num("outline", 0, 20);
    for (const k of ["color", "outlineColor"] as const) {
      if (o[k] === undefined || o[k] === "") continue;
      const c = String(o[k]);
      if (!COLOR_RE.test(c)) throw new Error(`${LAYER_TITLE[layer]}: цвет «${c}» — нужен #RRGGBB`);
      st[k] = c.toUpperCase();
    }
    if (Object.keys(st).length) out[layer] = st;
  }
  return out;
}

/** Пресет с оформлением владельца: шрифт — по файлу (семейство из файла, свой — полным путём), размеры и цвета — как задано. */
export function applyStyle(base: Preset, style: StyleOverride, fonts: readonly FontInfo[]): Preset {
  const layer = (name: Layer, st: TextStyle): TextStyle => {
    const o = style[name];
    if (!o) return st;
    const next: TextStyle = { ...st };
    if (o.fontFile) {
      const f = fonts.find((x) => x.file.toLowerCase() === o.fontFile!.toLowerCase());
      if (f) {
        next.font = f.family;
        next.fontFile = f.source === "user" ? f.path : f.file;
      }
    }
    if (o.size !== undefined) next.size = o.size;
    if (o.color) next.color = o.color;
    if (o.outlineColor) next.outlineColor = o.outlineColor;
    if (o.outline !== undefined) next.outline = o.outline;
    return next;
  };
  return { ...base, hook: layer("hook", base.hook), caption: { ...base.caption, ...layer("caption", base.caption) }, block: layer("block", base.block) };
}

/** Как слой выглядит сейчас — для формы в интерфейсе. */
export function layerView(st: TextStyle, fonts: readonly FontInfo[]) {
  const file = st.fontFile.split(/[\\/]/).pop() ?? st.fontFile;
  const f = fonts.find((x) => x.file.toLowerCase() === file.toLowerCase());
  return { fontFile: file, family: f?.family ?? st.font, size: st.size, color: st.color.slice(0, 7), outlineColor: st.outlineColor.slice(0, 7), outline: st.outline, marginV: st.marginV, alignment: st.alignment };
}
