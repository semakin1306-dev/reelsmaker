import type { CaptionStyle, Preset, TextStyle } from "./presets.ts";
import type { ClipInput, VariantPlan, Word } from "./types.ts";

/** 83.456 → "0:01:23.46" (формат времени ASS: H:MM:SS.cc). */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** "#RRGGBB" или "#RRGGBBAA" (AA — непрозрачность) → "&HAABBGGRR" (в ASS 00 = непрозрачный). */
export function assColor(hex: string): string {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const opacity = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  const alpha = (255 - opacity).toString(16).toUpperCase().padStart(2, "0");
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** Цвет для оверрайда `{\c...}`: без альфы, с закрывающим &. */
function assOverrideColor(hex: string): string {
  const c = assColor(hex);
  return `&H${c.slice(4)}&`;
}

/** Текст реплики: фигурные скобки ломают теги ASS, обратный слэш — переносы, поэтому заменяем. */
export function escapeAssText(s: string): string {
  return s
    .replace(/\r?\n/g, "\\N")
    .replace(/\\(?!N)/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")");
}

function styleLine(name: string, st: TextStyle): string {
  const back = st.borderStyle === 3 ? assColor(st.outlineColor) : "&H80000000";
  const fields = [
    name,
    st.font,
    st.size,
    assColor(st.color),
    assColor(st.color),
    assColor(st.outlineColor),
    back,
    st.bold ? -1 : 0,
    st.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    st.spacing,
    0,
    st.borderStyle,
    st.outline,
    st.shadow,
    st.alignment,
    st.marginH,
    st.marginH,
    st.marginV,
    1,
  ];
  return `Style: ${fields.join(",")}`;
}

interface Event {
  start: number;
  end: number;
  style: string;
  text: string;
}

function dialogue(e: Event): string {
  return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`;
}

function shape(text: string, st: TextStyle): string {
  return escapeAssText(st.uppercase ? text.toLocaleUpperCase("ru") : text);
}

interface TimedWord {
  /** индекс сцены в схеме: субтитры не склеивают слова разных сцен */
  seg: number;
  text: string;
  start: number;
  end: number;
}

function chunkWords(words: readonly TimedWord[], maxWords: number, maxChars = 0): TimedWord[][] {
  const chunks: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  let len = 0;
  for (const w of words) {
    const prev = cur[cur.length - 1];
    // кусок не длиннее maxChars символов — держится одной строкой (перенос поднял бы текст на лицо)
    const tooLong = maxChars > 0 && len + 1 + w.text.length > maxChars;
    const brk = prev && (cur.length >= maxWords || tooLong || w.seg !== prev.seg || w.start - prev.end > 0.7 || /[.!?…]$/u.test(prev.text));
    if (brk) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    len += (cur.length ? 1 : 0) + w.text.length;
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Слова сцены в шкале готового ролика (с учётом обрезки, склейки и скорости). */
export function timelineWords(plan: VariantPlan, clips: ReadonlyMap<string, ClipInput>): TimedWord[] {
  const out: TimedWord[] = [];
  let offset = 0;
  for (const [seg, scene] of plan.scenes.entries()) {
    const words: readonly Word[] = clips.get(scene.clipId)?.transcript?.words ?? [];
    for (const w of words) {
      if (w.end <= scene.trim.start || w.start >= scene.trim.end) continue;
      const s = Math.max(w.start, scene.trim.start) - scene.trim.start;
      const e = Math.min(w.end, scene.trim.end) - scene.trim.start;
      // обрезок слова на склейке (хвост прошлой фразы): в кадре его почти нет — в субтитры не берём
      const kept = e - s;
      const clipped = w.start < scene.trim.start || w.end > scene.trim.end;
      if (clipped && (kept < 0.12 || kept < 0.5 * (w.end - w.start))) continue;
      out.push({ seg, text: w.text.trim(), start: (offset + s) / plan.speed, end: (offset + e) / plan.speed });
    }
    offset += scene.trim.end - scene.trim.start;
  }
  return out.filter((w) => w.text !== "");
}

function captionEvents(words: readonly TimedWord[], st: CaptionStyle): Event[] {
  const events: Event[] = [];
  const chunks = chunkWords(words, Math.max(1, st.maxWords), st.maxChars);
  chunks.forEach((chunk, ci) => {
    const first = chunk[0] as TimedWord;
    const last = chunk[chunk.length - 1] as TimedWord;
    const nextStart = chunks[ci + 1]?.[0]?.start ?? Infinity;
    const chunkEnd = Math.min(last.end + 0.15, nextStart);
    if (!st.karaoke) {
      // не заходить на следующий кусок: два субтитра одновременно libass ставит стопкой, и второй уезжает вверх (на лицо)
      const end = Math.min(Math.max(chunkEnd, first.start + 0.1), nextStart);
      if (end > first.start) events.push({ start: first.start, end, style: "Caption", text: shape(chunk.map((w) => w.text).join(" "), st) });
      return;
    }
    // подсветка текущего слова: одна реплика на слово, весь блок виден, активное слово цветное
    chunk.forEach((w, wi) => {
      const next = chunk[wi + 1];
      const start = w.start;
      const end = next ? next.start : chunkEnd;
      const text = chunk
        .map((x, xi) => {
          const t = shape(x.text, st);
          return xi === wi ? `{\\c${assOverrideColor(st.highlight)}}${t}{\\r}` : t;
        })
        .join(" ");
      const e = Math.min(Math.max(end, start + 0.08), next ? next.start : nextStart);
      if (e > start) events.push({ start, end: e, style: "Caption", text });
    });
  });
  return events;
}

/** Собирает файл ASS для варианта: хук, блоки-плашки и субтитры по словам расшифровки. */
export function buildAss(plan: VariantPlan, preset: Preset, clips: ReadonlyMap<string, ClipInput>): string {
  const { width, height } = plan.output;
  const lines: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    styleLine("Hook", preset.hook),
    styleLine("Caption", preset.caption),
    styleLine("Block", preset.block),
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];

  const events: Event[] = [];
  const hookEnd = Math.max(0.5, plan.hook.duration) / plan.speed;
  if (plan.hook.text.trim()) {
    events.push({ start: 0, end: hookEnd, style: "Hook", text: `{\\fad(180,260)}${shape(plan.hook.text, preset.hook)}` });
  }

  const starts: number[] = [];
  let offset = 0;
  for (const s of plan.scenes) {
    starts.push(offset);
    offset += s.trim.end - s.trim.start;
  }
  for (const b of plan.blocks) {
    const base = starts[b.sceneIndex];
    if (base === undefined) continue;
    const start = (base + b.offset) / plan.speed;
    events.push({ start, end: start + b.duration / plan.speed, style: "Block", text: `{\\fad(150,200)}${shape(b.text, preset.block)}` });
  }

  if (plan.captions) {
    // хук сверху, субтитры снизу — не пересекаются, идут по таймкодам слов
    events.push(...captionEvents(timelineWords(plan, clips), preset.caption));
  }

  events.sort((a, b) => a.start - b.start);
  for (const e of events) lines.push(dialogue(e));
  return lines.join("\n") + "\n";
}
