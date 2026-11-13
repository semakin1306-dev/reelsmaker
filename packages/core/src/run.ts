import { spawn } from "node:child_process";

export interface RunOptions {
  /** Предел времени, мс. По истечении процесс убивается. По умолчанию 10 минут. */
  timeout?: number;
  cwd?: string;
  /** Добавляется к окружению текущего процесса. */
  env?: Record<string, string>;
  /** Что подать в stdin. */
  input?: string;
  /** Предел накопленного вывода (stdout и stderr по отдельности), символов. По умолчанию 10 МБ. */
  maxOutput?: number;
  /** true — ненулевой код и таймаут превращаются в RunError. */
  check?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ok: boolean;
  timedOut: boolean;
  /** Вывод был длиннее maxOutput и обрезан. */
  truncated: boolean;
  durationMs: number;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunError";
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;
const STDERR_TAIL = 500;

/**
 * Единственная обёртка запуска внешних программ (ffmpeg, ffprobe, whisper): программа и аргументы
 * отдельно, без оболочки — метасимволы в аргументах не исполняются. Путь к программе берут из конфига.
 * Не найденная программа — RunError. Ненулевой код возвращается в результате, если не задан check.
 */
export function run(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutput) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > maxOutput) {
        truncated = true;
        return next.slice(0, maxOutput);
      }
      return next;
    };
    child.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout)
        : null;

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new RunError(`Не удалось запустить «${command}»: ${e.code ?? e.message}`, undefined, { cause: e }));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result: RunResult = {
        code,
        signal,
        stdout,
        stderr,
        ok: code === 0 && !timedOut,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      };
      if (options.check && !result.ok) {
        const why = timedOut ? `таймаут ${timeout} мс` : `код ${code ?? signal}`;
        const tail = stderr.trim().slice(-STDERR_TAIL);
        reject(new RunError(`«${command}» завершился неуспешно (${why})${tail ? `: ${tail}` : ""}`, result));
        return;
      }
      resolve(result);
    });

    // Запись в stdin уже закрывшегося процесса не должна ронять наш процесс.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
