import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  /** по истечении процесс убивается, результат с timedOut=true */
  timeoutMs?: number;
  /** поток stderr по мере поступления (журнал ffmpeg пишется отсюда) */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  /** хвост stderr (последние ~64 КБ); полный поток — через onStderr */
  stderr: string;
  timedOut: boolean;
}

export type RunFn = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const TAIL_LIMIT = 64 * 1024;

/**
 * Запуск внешней программы без оболочки: аргументы массивом.
 * Локальная реализация сборщика с cwd и потоком stderr; когда `packages/core` отдаст общую `run`
 * с теми же возможностями, подставляется через RunFn без правок остального кода.
 */
export const defaultRun: RunFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout = (stdout + d).slice(-TAIL_LIMIT);
    });
    child.stderr.on("data", (d: string) => {
      stderr = (stderr + d).slice(-TAIL_LIMIT);
      opts.onStderr?.(d);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`не удалось запустить ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
