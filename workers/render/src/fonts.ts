// Шрифты оформления: встроенные (presets/fonts) и свои (папка данных, загружаются из интерфейса).
// libass ищет шрифт по семейству, записанному внутри файла, — его читаем из таблицы name (TrueType/OpenType).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FONT_RE = /\.(ttf|otf)$/i;

/**
 * Семейство шрифта из таблицы name: nameID 1 (Windows, английский — как его видит libass), иначе любое nameID 1.
 * Не шрифт или нет таблицы — null.
 */
export function fontFamily(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  const tag = buf.toString("latin1", 0, 4);
  if (tag !== "OTTO" && buf.readUInt32BE(0) !== 0x00010000 && tag !== "true") return null;
  const tables = buf.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString("latin1", rec, rec + 4) !== "name") continue;
    const off = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(off + 2);
    const strings = off + buf.readUInt16BE(off + 4);
    let best: { score: number; text: string } | null = null;
    for (let j = 0; j < count; j++) {
      const r = off + 6 + j * 12;
      const platform = buf.readUInt16BE(r);
      const lang = buf.readUInt16BE(r + 4);
      const nameId = buf.readUInt16BE(r + 6);
      const len = buf.readUInt16BE(r + 8);
      const at = strings + buf.readUInt16BE(r + 10);
      if (nameId !== 1 || at + len > buf.length) continue;
      let text = "";
      if (platform === 3 || platform === 0) for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(buf.readUInt16BE(at + k));
      else text = buf.toString("latin1", at, at + len);
      text = text.trim();
      if (!text) continue;
      const score = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : 1;
      if (!best || score > best.score) best = { score, text };
    }
    return best?.text ?? null;
  }
  return null;
}

export interface FontInfo {
  /** имя файла */
  file: string;
  /** полный путь */
  path: string;
  /** семейство для ASS */
  family: string;
  /** встроенный (в репозитории) или свой (папка данных) */
  source: "builtin" | "user";
}

/** Шрифты папок по порядку; при одинаковом имени файла свой перекрывает встроенный. */
export function listFonts(dirs: readonly { dir: string; source: FontInfo["source"] }[]): FontInfo[] {
  const byFile = new Map<string, FontInfo>();
  for (const { dir, source } of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => FONT_RE.test(f));
    } catch {
      continue;
    }
    for (const file of names) {
      const path = join(dir, file);
      let family: string | null = null;
      try {
        family = fontFamily(readFileSync(path));
      } catch {
        family = null;
      }
      if (family) byFile.set(file.toLowerCase(), { file, path, family, source });
    }
  }
  return [...byFile.values()].sort((a, b) => a.family.localeCompare(b.family, "ru") || a.file.localeCompare(b.file));
}
