// Командная строка для Python-части виртуального микрофона (apps/mic-clean/micclean.py): план запуска ffmpeg одним источником правды.
//   node --import tsx apps/pc-agent/src/mic-clean-cli.ts plan --config <папка данных>/micclean.json [--passthrough]   → JSON {mode, args, gate, noiseSeconds, note}
//   node --import tsx apps/pc-agent/src/mic-clean-cli.ts sample <wav> [--ffmpeg <путь>]              → JSON {seconds, floorDb, quietRatioDb}
import { dirname } from "node:path";
import { readMicCleanConfig, planLive } from "./mic-clean.ts";
import { analyzeNoise, decodeMono } from "./voice-clean.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

async function main() {
  const cmd = argv[0];
  if (cmd === "plan") {
    const file = flag("--config");
    if (!file) throw new Error("plan: укажите --config <папка данных>/micclean.json");
    const cfg = await readMicCleanConfig(file, dirname(file));
    console.log(JSON.stringify(await planLive(cfg, { passthrough: argv.includes("--passthrough") })));
    return;
  }
  if (cmd === "sample") {
    const wav = argv[1];
    if (!wav) throw new Error("sample: укажите wav");
    const { samples, rate } = await decodeMono(flag("--ffmpeg") ?? "ffmpeg", wav);
    const a = analyzeNoise(samples, rate);
    // разброс по 50-мс кускам: ровный шум — 3–5 дБ; в образец попали слова, щелчки — больше
    const n = Math.floor(rate * 0.05);
    const db: number[] = [];
    for (let f = 0; f + n <= samples.length; f += n) {
      let sum = 0;
      for (let i = f; i < f + n; i++) sum += (samples[i] as number) ** 2;
      db.push(20 * Math.log10(Math.max(Math.sqrt(sum / n), 1e-6)));
    }
    db.sort((x, y) => x - y);
    const spread = db.length ? (db[Math.floor(db.length * 0.95)] as number) - (db[Math.floor(db.length * 0.1)] as number) : 0;
    console.log(JSON.stringify({ seconds: Math.round((samples.length / rate) * 100) / 100, floorDb: a.floorDb, spreadDb: Math.round(spread * 10) / 10 }));
    return;
  }
  throw new Error("команды: plan, sample");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
