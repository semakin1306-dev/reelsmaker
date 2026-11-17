import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveGraph, AFFTDN_DELAY } from "./voice-clean.ts";
import { defaultMicCleanConfig, planLive, readMicCleanConfig } from "./mic-clean.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rf-mic-"));

/** n секунд ровного «шума» ≈ −66 dBFS на частоте 16 кГц. */
const quiet = (sec: number) => {
  const out = new Float32Array(Math.round(sec * 16000));
  let s = 7;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * 0.001;
  }
  return out;
};

test("живая цепочка: образец шума → режекторы → afftdn по образцу → срез образца и задержки → гейт → усиление и лимитер, без loudnorm", () => {
  const g = buildLiveGraph({ noiseSeconds: 2, gate: 0.003, gainDb: 9 });
  assert.match(g, /^\[0:a\]aresample=48000,aformat=channel_layouts=mono\[n\];\[1:a\]aresample=48000,aformat=channel_layouts=mono\[s\];\[n\]\[s\]concat=n=2:v=0:a=1,highpass=f=80,bandreject=f=2000/);
  assert.ok(g.includes("asendcmd=c='0.05 afftdn sn start;1.95 afftdn sn stop'"));
  assert.ok(g.includes(`atrim=start_sample=${2 * 48000 + AFFTDN_DELAY}`), "срезается образец и задержка шумоподавителя");
  assert.ok(g.includes("agate=threshold=0.003:ratio=4:attack=8:release=260:range=0.06"));
  assert.ok(g.endsWith("volume=9dB,alimiter=limit=0.95:level=disabled[o]"));
  assert.ok(!/loudnorm|apad/.test(g), "поток бесконечный: ни выравнивания громкости, ни дополнения тишиной");
  assert.equal((g.match(/bandreject/g) ?? []).length, 19);
});

test("план запуска: очистка по образцу; без образца, коротким образцом или при выключенной обработке — звук без обработки с причиной", async () => {
  const dir = tmp();
  try {
    const sample = join(dir, "live.wav");
    writeFileSync(sample, "x");
    const cfg = { ...defaultMicCleanConfig(dir), noiseSample: sample };
    const decode = async () => ({ samples: quiet(2), rate: 16000 });
    const p = await planLive(cfg, {}, { decode });
    assert.equal(p.mode, "clean");
    assert.equal(p.noiseSeconds, 2);
    assert.ok(p.gate! > 0.0005 && p.gate! < 0.003, `порог ${p.gate}: от шума образца`);
    assert.deepEqual(p.args.slice(0, 5), ["-hide_banner", "-loglevel", "warning", "-nostdin", "-i"]);
    assert.equal(p.args[5], sample, "вход 0 — образец");
    assert.equal(p.args[p.args.indexOf("-i", 6) + 1], "audio=Микрофон (2- C-1U)", "вход 1 — микрофон DirectShow");
    assert.ok(p.args.includes("dshow") && p.args.includes("nobuffer") && p.args.includes("-filter_complex"));
    assert.deepEqual(p.args.slice(-9), ["-f", "s16le", "-ar", "48000", "-ac", "1", "-flush_packets", "1", "pipe:1"], "выход — сырой PCM в stdout");

    // для звонков: без обработки
    for (const q of [await planLive(cfg, { passthrough: true }, { decode }), await planLive({ ...cfg, processing: false }, {}, { decode })]) {
      assert.equal(q.mode, "passthrough");
      assert.ok(!q.args.includes("-filter_complex") && q.args.includes("-af"), "один вход, фильтр — только лимитер");
      assert.equal(q.note, "");
    }
    // образца нет → без обработки, а причина названа
    const none = await planLive({ ...cfg, noiseSample: join(dir, "нет.wav") }, {}, { decode });
    assert.equal(none.mode, "passthrough");
    assert.match(none.note, /нет образца шума микрофона — выберите в меню «Выучить шум»/);
    // слишком короткий образец
    const short = await planLive(cfg, {}, { decode: async () => ({ samples: quiet(0.2), rate: 16000 }) });
    assert.equal(short.mode, "passthrough");
    assert.match(short.note, /слишком короткий/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("настройки: умолчания, поверх них — файл; битый файл не роняет", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "micclean.json");
    const d = await readMicCleanConfig(file, dir);
    assert.deepEqual([d.input, d.output, d.gainDb, d.processing], ["Микрофон (2- C-1U)", "CABLE Input", 9, true]);
    assert.equal(d.noiseSample, join(dir, "noise", "live.wav"));
    writeFileSync(file, JSON.stringify({ gainDb: 12, processing: false, input: null }));
    const c = await readMicCleanConfig(file, dir);
    assert.deepEqual([c.gainDb, c.processing, c.input], [12, false, "Микрофон (2- C-1U)"], "null и пропуски — из умолчаний");
    writeFileSync(file, "{ не json");
    assert.equal((await readMicCleanConfig(file, dir)).gainDb, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
