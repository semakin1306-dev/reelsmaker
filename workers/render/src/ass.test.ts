import { test } from "node:test";
import assert from "node:assert/strict";
import { assColor, assTime, buildAss, escapeAssText, timelineWords } from "./ass.ts";
import { planVariants } from "./planner/rules.ts";
import type { CaptionStyle, Preset, TextStyle } from "./presets.ts";
import { fakeStory } from "./testing/fixtures.ts";

const baseStyle: TextStyle = {
  font: "Oswald", fontFile: "Oswald-Bold.ttf", size: 90, bold: true, italic: false, color: "#FFFFFF",
  outlineColor: "#000000", outline: 5, shadow: 1, borderStyle: 1, alignment: 2, marginV: 500, marginH: 60, uppercase: false, spacing: 0,
};
const caption: CaptionStyle = { ...baseStyle, maxWords: 2, maxChars: 0, karaoke: false, highlight: "#FFE14D" };
const preset: Preset = {
  id: "t", title: "t", grade: {},
  hook: { ...baseStyle, alignment: 8, marginV: 300 },
  caption,
  block: { ...baseStyle, borderStyle: 3, outlineColor: "#FFE14DF2" },
};

function plan(speed = 1) {
  const story = fakeStory();
  const p = planVariants(story, { presets: ["t"], count: 1 }).plans[0]!;
  p.speed = speed;
  return { story, p, clips: new Map(story.clips.map((c) => [c.id, c])) };
}

test("время ASS: H:MM:SS.cc", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(83.456), "0:01:23.46");
  assert.equal(assTime(3725.5), "1:02:05.50");
  assert.equal(assTime(-1), "0:00:00.00");
});

test("цвет ASS: BGR и инверсия прозрачности", () => {
  assert.equal(assColor("#FF8000"), "&H000080FF");
  assert.equal(assColor("#000000"), "&H00000000");
  assert.equal(assColor("#FFE14DF2"), "&H0D4DE1FF");
  assert.equal(assColor("#11223300"), "&HFF332211");
});

test("текст реплики: скобки, слэши и переводы строк не ломают теги", () => {
  assert.equal(escapeAssText("a {b} c"), "a (b) c");
  assert.equal(escapeAssText("раз\nдва"), "раз\\Nдва");
  assert.equal(escapeAssText("a\\b"), "a/b");
});

test("слова расшифровки переносятся в шкалу ролика: смещение сцен и скорость", () => {
  const { p, clips } = plan(1);
  const words = timelineWords(p, clips);
  assert.equal(words[0]?.text, "Привет");
  // слова хука идут в пределах первых 3 с, слова второй сцены — после её начала
  assert.ok((words[0]?.start ?? 9) >= 0.2 && (words[0]?.end ?? 0) <= 3);
  const second = words.find((w) => w.text === "Сначала");
  assert.ok(second && second.start >= 3, `Сначала на ${second?.start}`);
  const fast = plan(1.25);
  const w2 = timelineWords(fast.p, fast.clips).find((w) => w.text === "Сначала");
  assert.ok(w2 && Math.abs(w2.start - second!.start / 1.25) < 1e-9);
});

test("слова за границей обрезки сцены не попадают в субтитры", () => {
  const { p, clips } = plan(1);
  const scene = p.scenes[0]!;
  scene.trim = { start: 0, end: 1 };
  const words = timelineWords(p, clips);
  assert.ok(words.some((w) => w.text === "Привет"));
  assert.ok(!words.some((w) => w.text === "покажу"), "слово на 1.6 с при обрезке до 1 с отрезано");
  const second = words.find((w) => w.text === "Сначала");
  assert.ok(second && second.start >= 1 && second.start < 2, "вторая сцена теперь начинается с 1 с");
});

test("ASS: заголовок, три стиля, хук с затуханием, плашки и субтитры", () => {
  const { p, clips } = plan(1);
  p.blocks = [{ text: "Шаг 1", sceneIndex: 1, offset: 0.5, duration: 1.5 }];
  const ass = buildAss(p, preset, clips);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Hook,Oswald,90,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,1,8,60,60,300,1/);
  assert.match(ass, /Style: Block,.*,3,5,1,2,60,60,500,1/);
  const dialogs = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.ok(dialogs[0]?.includes(`,0:00:00.00,`) && dialogs[0]?.includes("{\\fad(180,260)}"), "хук первым с 0 секунды");
  assert.ok(dialogs.some((l) => l.includes(",Block,") && l.includes("Шаг 1") && l.includes(",0:00:03.50,")), "плашка в начале 2-й сцены +0.5 с");
  const caps = dialogs.filter((l) => l.includes(",Caption,"));
  assert.ok(caps.length >= 4);
  assert.ok(caps[0]?.includes("Привет друзья") || caps[0]?.includes("Привет"), "субтитры по словам");
  const starts = dialogs.map((l) => l.split(",")[1]);
  assert.deepEqual(starts, [...starts].sort(), "реплики отсортированы по времени");
});

test("ASS: капс и подсветка слов (караоке) — по реплике на слово", () => {
  const { p, clips } = plan(1);
  const up: Preset = { ...preset, caption: { ...caption, uppercase: true, karaoke: true, maxWords: 3 } };
  const ass = buildAss(p, up, clips);
  const caps = ass.split("\n").filter((l) => l.includes(",Caption,"));
  const first = caps.filter((l) => l.includes("ПРИВЕТ"));
  assert.ok(first.length >= 2, "слово «ПРИВЕТ» есть и в своей реплике, и в соседних");
  assert.ok(caps.some((l) => l.includes("{\\c&H4DE1FF&}")), "цвет подсветки #FFE14D в формате BGR");
});

test("ASS: captions=false — только хук и плашки", () => {
  const { p, clips } = plan(1);
  p.captions = false;
  const ass = buildAss(p, preset, clips);
  assert.ok(!ass.includes(",Caption,"));
  assert.ok(ass.includes(",Hook,"));
});

test("субтитры не склеивают слова разных сцен, даже если пауза между ними мала", () => {
  const { p, clips } = plan(1);
  const [hook, second] = [p.scenes[0]!, p.scenes[1]!];
  p.scenes = [hook, second];
  p.blocks = [];
  hook.trim = { start: 0, end: 3 };
  second.trim = { start: 0, end: 3 };
  clips.get(hook.clipId)!.transcript = { text: "конец сцены", words: [{ text: "конец", start: 2.4, end: 2.9 }, { text: "сцены", start: 2.9, end: 3 }] };
  clips.get(second.clipId)!.transcript = { text: "начало", words: [{ text: "начало", start: 0, end: 0.4 }] };
  const wide: Preset = { ...preset, caption: { ...caption, maxWords: 5 } };
  const caps = buildAss(p, wide, clips).split("\n").filter((l) => l.includes(",Caption,"));
  assert.equal(caps.length, 2);
  assert.ok(caps[0]?.endsWith("конец сцены") && caps[1]?.endsWith("начало"));
});

test("субтитры: кусок не длиннее maxChars — одна строка, длинная фраза делится раньше maxWords", () => {
  const { p, clips } = plan(1);
  const sc = p.scenes[0]!;
  p.scenes = [sc];
  p.blocks = [];
  sc.trim = { start: 0, end: 4 };
  const words = ["шардированное", "тестирование,", "чтобы", "у", "меня"].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.45 }));
  clips.get(sc.clipId)!.transcript = { text: "", words };
  const caps = (maxChars: number) =>
    buildAss(p, { ...preset, caption: { ...caption, maxWords: 3, maxChars } }, clips).split("\n").filter((l) => l.includes(",Caption,")).map((l) => l.split(",").slice(9).join(","));
  assert.deepEqual(caps(0), ["шардированное тестирование, чтобы", "у меня"], "без предела — по 3 слова");
  assert.deepEqual(caps(24), ["шардированное", "тестирование, чтобы у", "меня"], "не длиннее 24 символов");
  for (const c of caps(24)) assert.ok(c.length <= 24, c);
});

test("субтитры: обрезок слова на склейке не показывается, куски не наезжают друг на друга (иначе libass ставит их стопкой)", () => {
  const { p, clips } = plan(1);
  const sc = p.scenes[0]!;
  p.scenes = [sc];
  p.blocks = [];
  sc.trim = { start: 10.75, end: 14 };
  // «тестировалась.» почти целиком до начала отрезка — в кадре 0,06 с хвоста
  const words = [
    { text: "тестировалась.", start: 9.97, end: 10.81 },
    { text: "Получилось", start: 10.81, end: 11.3 },
    { text: "настроить", start: 11.3, end: 11.9 },
    { text: "экономию", start: 11.95, end: 12.5 },
  ];
  clips.get(sc.clipId)!.transcript = { text: "", words };
  const ass = buildAss(p, { ...preset, caption: { ...caption, maxWords: 2 } }, clips);
  const caps = ass.split("\n").filter((l) => l.includes(",Caption,"));
  assert.ok(!caps.some((l) => l.includes("тестировалась")), "хвост прошлой фразы не попал");
  const t = (x: string) => { const [h, m, sec] = x.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(sec); };
  const spans = caps.map((l) => l.split(",")).map((c) => [t(c[1]!), t(c[2]!)] as const);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i - 1]![1] <= spans[i]![0], `кусок ${i} начинается до конца предыдущего: ${caps[i - 1]} / ${caps[i]}`);
});
