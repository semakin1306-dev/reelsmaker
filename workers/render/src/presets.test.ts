import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPresets, validatePreset } from "./presets.ts";
import { SAFE_AREA } from "./types.ts";

const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

test("один пресет default: без цветокора; заголовок Home Video рыжий, субтитры Montserrat белые с обводкой", () => {
  const presets = loadPresets(presetsDir);
  assert.deepEqual(presets.map((p) => p.id), ["default"], "решение владельца: оформление одно на все варианты");
  const p = presets[0]!;
  assert.equal(p.grade.eq, undefined);
  assert.equal(p.grade.lut, undefined);
  assert.equal(p.grade.curves, undefined);
  assert.ok(!p.grade.vignette && !p.grade.sharpen && !p.grade.grain);
  assert.deepEqual([p.hook.font, p.hook.fontFile, p.hook.color], ["Home Video", "HomeVideo-Bold.otf", "#EC5B0E"]);
  assert.deepEqual([p.caption.font, p.caption.fontFile, p.caption.color, p.caption.outlineColor], ["Montserrat", "Montserrat-Bold.ttf", "#FFFFFF", "#000000"]);
  assert.ok(p.caption.outline >= 3, "обводка субтитров");
  assert.equal(p.hook.color, "#EC5B0E", "насыщенный рыжий");
  // субтитры — у нижней границы зоны (уровень груди/живота), а не посреди кадра на лице
  assert.ok(p.caption.alignment === 2 && p.caption.marginV - p.caption.outline - SAFE_AREA.bottom <= 20, "субтитры прижаты к низу зоны");
  assert.ok(p.caption.maxChars > 0 && p.caption.maxChars <= 26, "одна строка: перенос поднял бы субтитры на лицо");
});

test("весь текст пресетов — в охранной зоне Reels (сверху 220, снизу 450, по бокам 35 px)", () => {
  for (const p of loadPresets(presetsDir)) {
    for (const [name, st] of [["hook", p.hook], ["caption", p.caption], ["block", p.block]] as const) {
      const pad = st.borderStyle === 3 ? st.outline : st.outline + st.shadow; // плашка/обводка выступают за буквы
      assert.ok(st.marginH - pad >= SAFE_AREA.side, `${p.id}.${name}: по бокам ${st.marginH} − ${pad} < ${SAFE_AREA.side}`);
      const v = Math.floor((st.alignment - 1) / 3); // 0 — низ, 1 — середина, 2 — верх (раскладка numpad)
      if (v === 0) assert.ok(st.marginV - pad >= SAFE_AREA.bottom, `${p.id}.${name}: снизу ${st.marginV} − ${pad} < ${SAFE_AREA.bottom}`);
      if (v === 2) assert.ok(st.marginV - pad >= SAFE_AREA.top, `${p.id}.${name}: сверху ${st.marginV} − ${pad} < ${SAFE_AREA.top}`);
    }
  }
});

test("файлы шрифтов и LUT из пресетов лежат в репо, лицензия шрифта рядом", () => {
  for (const p of loadPresets(presetsDir)) {
    for (const st of [p.hook, p.caption, p.block]) {
      assert.ok(existsSync(join(presetsDir, "fonts", st.fontFile)), `${p.id}: шрифт ${st.fontFile}`);
    }
    if (p.grade.lut) assert.ok(existsSync(join(presetsDir, "luts", p.grade.lut)), `${p.id}: LUT ${p.grade.lut}`);
  }
  assert.ok(existsSync(join(presetsDir, "fonts", "FONTS.txt")), "откуда шрифты и их лицензии");
  assert.ok(existsSync(join(presetsDir, "fonts", "OFL-Montserrat.txt")), "лицензия Montserrat");
});

test("ошибка пресета называет поле", () => {
  assert.throws(() => validatePreset({ id: "Bad Id" }), /\$\.id/);
  assert.throws(() => validatePreset({ id: "x", caption: {} }), /\$\.caption\.font/);
  const ok = {
    id: "x",
    hook: { font: "F", fontFile: "f.ttf", size: 80 },
    caption: { font: "F", fontFile: "f.ttf", size: 80 },
    block: { font: "F", fontFile: "f.ttf", size: 80, color: "красный" },
  };
  assert.throws(() => validatePreset(ok), /\$\.block\.color/);
  ok.block.color = "#FFFFFF";
  assert.equal(validatePreset(ok).caption.maxWords, 3);
  assert.throws(() => validatePreset({ ...ok, grade: { lut: "../x.cube" } }), /\$\.grade\.lut/);
});
