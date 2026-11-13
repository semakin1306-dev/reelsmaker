import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS_DIR } from "./presets.ts";
import { fontFamily, listFonts } from "./fonts.ts";

test("семейство шрифта читается из файла — по нему libass находит шрифт", () => {
  assert.equal(fontFamily(readFileSync(join(PRESETS_DIR, "fonts", "HomeVideo-Bold.otf"))), "Home Video");
  assert.equal(fontFamily(readFileSync(join(PRESETS_DIR, "fonts", "Montserrat-Bold.ttf"))), "Montserrat");
  assert.equal(fontFamily(Buffer.from("не шрифт вовсе")), null);
});

test("список шрифтов: встроенные, свой с тем же именем файла перекрывает встроенный", () => {
  const fonts = listFonts([{ dir: join(PRESETS_DIR, "fonts"), source: "builtin" }, { dir: "C:/нет-такой-папки", source: "user" }]);
  assert.deepEqual(fonts.map((f) => [f.family, f.source]), [["Home Video", "builtin"], ["Montserrat", "builtin"]]);
});
