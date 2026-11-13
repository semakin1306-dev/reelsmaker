import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, requireConfig, ConfigError } from "./config.ts";

test("без обязательного RF_DATA_DIR — понятная ошибка с именем поля", () => {
  assert.throws(
    () => loadConfig({ env: {}, envFile: null }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /RF_DATA_DIR/);
      assert.match(e.message, /не задан/);
      return true;
    },
  );
});

test("пустое значение (как в .env.example) считается незаданным", () => {
  assert.throws(() => loadConfig({ env: { RF_DATA_DIR: "   " }, envFile: null }), /RF_DATA_DIR/);
});

test("значения по умолчанию: ffmpeg и ffprobe из PATH, хаб на локальном адресе, Europe/Moscow", () => {
  const c = loadConfig({ env: { RF_DATA_DIR: "/srv/rf" }, envFile: null });
  assert.equal(c.ffmpegPath, "ffmpeg");
  assert.equal(c.ffprobePath, "ffprobe");
  assert.equal(c.sttPython, null);
  assert.equal(c.sttModel, null);
  assert.equal(c.hw, "cpu");
  assert.match(c.inboxDir.replaceAll("\\", "/"), /rf\/inbox$/);
  assert.match(c.outputDir.replaceAll("\\", "/"), /rf\/out$/);
  assert.equal(c.hubUrl, "http://127.0.0.1:8787");
  assert.equal(c.timezone, "Europe/Moscow");
  assert.match(c.dbPath.replaceAll("\\", "/"), /rf\/rf\.sqlite$/);
});

test("заданные значения читаются, пути не теряются", () => {
  const c = loadConfig({
    env: {
      RF_DATA_DIR: "/srv/rf",
      RF_FFMPEG_PATH: "/opt/ff/ffmpeg",
      RF_STT_PYTHON: "C:/stt/.venv/Scripts/python.exe",
      RF_STT_MODEL: "G:/models/turbo",
      RF_INBOX_DIR: "C:/ReelsMaker/inbox",
      RF_OUTPUT_DIR: "D:/ролики",
      RF_HW: "nvenc",
      RF_HUB_URL: "http://hub.lan:9000/",
      RF_TIMEZONE: "Europe/Samara",
    },
    envFile: null,
  });
  assert.equal(c.ffmpegPath, "/opt/ff/ffmpeg");
  assert.equal(c.sttPython, "C:/stt/.venv/Scripts/python.exe");
  assert.equal(c.sttModel, "G:/models/turbo");
  assert.equal(c.inboxDir, "C:/ReelsMaker/inbox");
  assert.equal(c.outputDir, "D:/ролики");
  assert.equal(c.hw, "nvenc");
  assert.equal(c.hubUrl, "http://hub.lan:9000");
  assert.equal(c.timezone, "Europe/Samara");
});

test("неверный адрес хаба и часовой пояс — все ошибки в одном сообщении", () => {
  assert.throws(
    () =>
      loadConfig({
        env: { RF_DATA_DIR: "/d", RF_HUB_URL: "не адрес", RF_HW: "gpu", RF_TIMEZONE: "Mars/Olympus" },
        envFile: null,
      }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /RF_HUB_URL/);
      assert.match(e.message, /RF_HW/);
      assert.match(e.message, /RF_TIMEZONE/);
      return true;
    },
  );
});

test(".env читается из файла, переменные окружения его перекрывают", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "RF_DATA_DIR=/from/file\nRF_HUB_URL=http://file.lan:1\n");
    const c = loadConfig({ env: { RF_HUB_URL: "http://env.lan:2" }, envFile: file });
    assert.equal(c.dataDir, "/from/file");
    assert.equal(c.hubUrl, "http://env.lan:2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("отсутствующий файл .env — не ошибка", () => {
  const c = loadConfig({ env: { RF_DATA_DIR: "/d" }, envFile: join(tmpdir(), "нет-такого", ".env") });
  assert.equal(c.dataDir, "/d");
});

test("requireConfig: нужная, но не заданная модель расшифровки — понятная ошибка", () => {
  const c = loadConfig({ env: { RF_DATA_DIR: "/d" }, envFile: null });
  assert.throws(() => requireConfig(c, "sttModel"), /RF_STT_MODEL/);
  const c2 = loadConfig({ env: { RF_DATA_DIR: "/d", RF_STT_PYTHON: "/p" }, envFile: null });
  assert.equal(requireConfig(c2, "sttPython"), "/p");
});
