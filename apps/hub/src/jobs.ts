// Очередь задач интерфейса: по одной за раз (видеокарта одна — расшифровка и NVENC не толкаются).

export type JobKind = "transcribe" | "build";
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  kind: JobKind;
  story: string;
  status: JobStatus;
  createdAt: string;
  finishedAt: string | null;
  log: string[];
  progress: { done: number; total: number } | null;
  runId: string | null;
  error: string | null;
}

export interface JobContext {
  log(msg: string): void;
  progress(done: number, total: number): void;
  setRun(runId: string): void;
}

const MAX_LOG = 300;
const KEEP_JOBS = 50;

export function createJobQueue() {
  const jobs: Job[] = [];
  const pending: { job: Job; fn: (ctx: JobContext) => Promise<void> }[] = [];
  let running = false;
  let nextId = 1;

  async function pump(): Promise<void> {
    if (running) return;
    const item = pending.shift();
    if (!item) return;
    running = true;
    const { job, fn } = item;
    job.status = "running";
    const ctx: JobContext = {
      log: (msg) => {
        job.log.push(`${new Date().toLocaleTimeString("ru-RU")} ${msg}`);
        if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
      },
      progress: (done, total) => {
        job.progress = { done, total };
      },
      setRun: (runId) => {
        job.runId = runId;
      },
    };
    try {
      await fn(ctx);
      job.status = "done";
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      ctx.log(`ошибка: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      running = false;
      void pump();
    }
  }

  return {
    add(kind: JobKind, story: string, fn: (ctx: JobContext) => Promise<void>): Job {
      const job: Job = {
        id: nextId++,
        kind,
        story,
        status: "queued",
        createdAt: new Date().toISOString(),
        finishedAt: null,
        log: [],
        progress: null,
        runId: null,
        error: null,
      };
      jobs.push(job);
      if (jobs.length > KEEP_JOBS) jobs.splice(0, jobs.length - KEEP_JOBS);
      pending.push({ job, fn });
      void pump();
      return job;
    },
    get: (id: number) => jobs.find((j) => j.id === id) ?? null,
    list: () => [...jobs].reverse(),
    /** незавершённые задачи сюжета */
    activeFor: (story: string) => jobs.filter((j) => j.story === story && (j.status === "queued" || j.status === "running")),
  };
}

export type JobQueue = ReturnType<typeof createJobQueue>;
