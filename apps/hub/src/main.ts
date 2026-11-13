// Запуск локального интерфейса: npm run ui (из корня). --open — открыть окно-приложение Chrome (не браузер по умолчанию).
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "@reels-factory/core";
import { loadPresets, PRESETS_DIR } from "@reels-factory/render";
import { createHub } from "./server.ts";

/** Окно-приложение Chrome с отдельным лёгким профилем; браузер по умолчанию не трогаем (тяжёлый). */
function openAppWindow(url: string, profile: string): void {
  const pf = process.env["ProgramFiles"] ?? "C:/Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] ?? "";
  const bin = [
    join(pf, "Google/Chrome/Application/chrome.exe"),
    join(pf86, "Google/Chrome/Application/chrome.exe"),
    join(local, "Google/Chrome/Application/chrome.exe"),
    join(pf86, "Microsoft/Edge/Application/msedge.exe"),
  ].find((p) => existsSync(p));
  if (!bin) {
    console.log(`Chrome не найден — откройте ${url} вручную`);
    return;
  }
  spawn(
    bin,
    [
      `--app=${url}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--disable-translate", "--disable-background-mode", "--disable-background-networking",
      "--disable-component-update", "--disable-breakpad", "--disable-features=Translate,MediaRouter,OptimizationHints", "--disk-cache-size=52428800",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
}

function main(): void {
  let cfg;
  try {
    // .env лежит в корне репозитория, а npm -w запускает из папки пакета
    cfg = loadConfig({ envFile: fileURLToPath(new URL("../../../.env", import.meta.url)) });
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    console.error("Скопируйте .env.example в .env в корне репозитория и заполните.");
    process.exit(2);
  }
  mkdirSync(cfg.inboxDir, { recursive: true });
  mkdirSync(cfg.outputDir, { recursive: true });

  const stt = cfg.sttPython && cfg.sttModel ? { python: cfg.sttPython, model: cfg.sttModel } : null;
  // NVENC: на GTX 1660 Super два кодирования параллельно — фильтры (ASS, LUT, зерно) всё равно на процессоре
  const concurrency = cfg.hw === "nvenc" ? 2 : Math.max(1, Math.floor(availableParallelism() / 2));
  const { server } = createHub({
    inboxDir: cfg.inboxDir,
    outputDir: cfg.outputDir,
    ffmpegPath: cfg.ffmpegPath,
    ffprobePath: cfg.ffprobePath,
    presetsDir: PRESETS_DIR,
    presets: loadPresets(PRESETS_DIR),
    stt,
    hw: cfg.hw,
    concurrency,
    dataDir: cfg.dataDir,
    agentProxy: cfg.agentProxy,
  });

  const url = new URL(cfg.hubUrl);
  const port = Number(url.port || 8787);
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Порт ${port} занят — интерфейс уже запущен? Откройте ${cfg.hubUrl}` : e);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`ReelsMaker: ${cfg.hubUrl}`);
    console.log(`  вход:   ${cfg.inboxDir}`);
    console.log(`  вывод:  ${cfg.outputDir}`);
    console.log(`  расшифровка: ${stt ? `${stt.python} + ${stt.model}` : "не настроена (RF_STT_PYTHON, RF_STT_MODEL)"}`);
    console.log(`  кодировщик: ${cfg.hw}, параллельно ${concurrency}`);
    if (process.argv.includes("--open")) openAppWindow(cfg.hubUrl + "/", join(cfg.dataDir, ".browser"));
  });
}

main();
