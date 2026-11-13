import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export interface Config {
  /** Каталог данных: база, сценки, ролики. */
  dataDir: string;
  /** Файл базы SQLite внутри каталога данных. */
  dbPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Папка входа: в ней папки сюжетов со сценками. По умолчанию <dataDir>/inbox. */
  inboxDir: string;
  /** Папка вывода готовых роликов. По умолчанию <dataDir>/out. */
  outputDir: string;
  /** Кодировщик: nvenc — видеокарта (ПК), cpu — libx264. */
  hw: "nvenc" | "cpu";
  /** Python окружения службы голосового ввода (faster-whisper) или null — без расшифровки. */
  sttPython: string | null;
  /** Каталог модели faster-whisper той же службы или null. */
  sttModel: string | null;
  /** Адрес веб-страницы ReelsMaker (apps/hub) без завершающего «/». */
  hubUrl: string;
  /** Часовой пояс для показа времени в интерфейсе. В базе время всегда UTC. */
  timezone: string;
  /** HTTP(S)-прокси для агента-монтажёра (Claude Code) к Anthropic или null — напрямую. */
  agentProxy: string | null;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Ошибка настройки (.env):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadConfigOptions {
  /** Переменные окружения. По умолчанию process.env. */
  env?: Record<string, string | undefined>;
  /** Путь к .env. По умолчанию ./.env; null — не читать файл. Нет файла — не ошибка. */
  envFile?: string | null;
}

export const DEFAULT_HUB_URL = "http://127.0.0.1:8787";
export const DEFAULT_TIMEZONE = "Europe/Moscow";

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, "utf8"));
  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Читает настройку из переменных окружения поверх файла .env и проверяет её.
 * Пустое значение (как в .env.example) = «не задано». Все ошибки собираются в одно сообщение.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fileValues = options.envFile === null ? {} : readEnvFile(options.envFile ?? join(process.cwd(), ".env"));
  const source = { ...fileValues, ...(options.env ?? process.env) };
  const get = (name: string): string | null => {
    const v = source[name]?.trim();
    return v ? v : null;
  };

  const problems: string[] = [];

  const dataDir = get("RF_DATA_DIR");
  if (!dataDir) problems.push("RF_DATA_DIR: не задан каталог данных (база, сценки, ролики)");

  const hubUrl = get("RF_HUB_URL") ?? DEFAULT_HUB_URL;
  if (!isUrl(hubUrl, ["http:", "https:"])) problems.push(`RF_HUB_URL: «${hubUrl}» — не адрес http(s)://хост:порт`);

  const hw = get("RF_HW") ?? "cpu";
  if (hw !== "nvenc" && hw !== "cpu") problems.push(`RF_HW: «${hw}» — допустимо nvenc или cpu`);

  const timezone = get("RF_TIMEZONE") ?? DEFAULT_TIMEZONE;
  if (!isTimezone(timezone)) problems.push(`RF_TIMEZONE: «${timezone}» — неизвестный часовой пояс (пример: Europe/Moscow)`);

  const agentProxy = get("RF_AGENT_PROXY");
  if (agentProxy && !isUrl(agentProxy, ["http:", "https:"])) problems.push(`RF_AGENT_PROXY: «${agentProxy}» — не адрес http(s)://хост:порт`);

  if (problems.length > 0 || !dataDir) throw new ConfigError(problems);

  return {
    dataDir,
    dbPath: join(dataDir, "rf.sqlite"),
    ffmpegPath: get("RF_FFMPEG_PATH") ?? "ffmpeg",
    ffprobePath: get("RF_FFPROBE_PATH") ?? "ffprobe",
    inboxDir: get("RF_INBOX_DIR") ?? join(dataDir, "inbox"),
    outputDir: get("RF_OUTPUT_DIR") ?? join(dataDir, "out"),
    hw: hw === "nvenc" ? "nvenc" : "cpu",
    sttPython: get("RF_STT_PYTHON"),
    sttModel: get("RF_STT_MODEL"),
    hubUrl: hubUrl.replace(/\/+$/, ""),
    timezone,
    agentProxy,
  };
}

const ENV_NAMES: Partial<Record<keyof Config, string>> = {
  sttPython: "RF_STT_PYTHON",
  sttModel: "RF_STT_MODEL",
};

/** Достаёт необязательную настройку, без которой конкретной программе не обойтись; нет — понятная ошибка. */
export function requireConfig<K extends "sttPython" | "sttModel">(config: Config, key: K): string {
  const value = config[key];
  if (!value) throw new ConfigError([`${ENV_NAMES[key]}: не задан, а эта программа без него не работает`]);
  return value;
}
