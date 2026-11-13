// Локальный интерфейс ReelsMaker: слушает только 127.0.0.1. Без внешних зависимостей (node:http).
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  grabFrame,
  isSafeName,
  listStoryDirs,
  readMeta,
  scanMontage,
  scanStory,
  transcribeStory,
  transcribeTalk,
  writeMeta,
  SOURCE_ROLES,
  VIDEO_RE,
  WORK_DIR,
  type MontageScan,
  type SourceRole,
} from "@reels-factory/pc-agent";
import { cleanCrop, FONT_RE, fontFamily, listFonts, type EditList, type FontInfo, type HwMode, type Preset } from "@reels-factory/render";
import { applyStyle, cleanStyle, layerView, LAYERS, readStyle, writeStyle, type StyleOverride } from "./style.ts";
import { buildStory, listRuns, type BuildEnv, type BuildHooks } from "./build.ts";
import { createAgentHub, MODELS, type AgentHub } from "./agent.ts";
import { editorPrompt } from "./editor-prompt.ts";
import { buildMontage, checkEdit, montageLabel, storyKind } from "./montage.ts";
import { createJobQueue, type JobQueue } from "./jobs.ts";
import { PAGE_HTML } from "./page.ts";

export interface HubOptions extends BuildEnv {
  hw: HwMode;
  /** одновременных рендеров по умолчанию */
  concurrency: number;
  /** для тестов: подмена рендера и расшифровки */
  hooks?: Pick<BuildHooks, "renderVariant" | "transcribe" | "probe">;
  /** открыть папку в проводнике; по умолчанию explorer.exe */
  openFolder?: (path: string) => void;
  /** адрес интерфейса — агенту для команды rm */
  hubUrl?: string;
  /** подмена агентов (тесты) */
  agents?: AgentHub;
  /** папка данных: оформление владельца (style.json) и свои шрифты (fonts/); нет — оформление только встроенное */
  dataDir?: string;
  /** HTTP(S)-прокси агента к Anthropic (RF_AGENT_PROXY) */
  agentProxy?: string | null;
}

/** Разметка сообщений агента (markdown) — отдельный файл, без экранирования внутри шаблона страницы. */
const MD_JS = readFileSync(fileURLToPath(new URL("../public/md.js", import.meta.url)), "utf8");

/** Команда rm для агента-монтажёра и владельца. */
export const RM_CLI = fileURLToPath(new URL("../cli/rm.mjs", import.meta.url));

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store" });
  res.end(data);
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "слишком большой файл");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "слишком большой запрос");
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    throw new HttpError(400, "тело запроса — не JSON");
  }
}

/** Отдаёт файл; для видео — с Range, чтобы в плеере работала перемотка. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let st;
  try {
    st = await stat(file);
  } catch {
    throw new HttpError(404, "нет файла");
  }
  if (!st.isFile()) throw new HttpError(404, "нет файла");
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${st.size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": st.size, "accept-ranges": "bytes", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

/** Путь внутри base из сегментов адреса; «..», разделители и выход за base — 400. */
export function safeJoin(base: string, segments: string[]): string {
  if (segments.length === 0 || !segments.every(isSafeName)) throw new HttpError(400, "неверный путь");
  const root = resolve(base);
  const full = resolve(root, ...segments);
  if (!full.startsWith(root + sep)) throw new HttpError(400, "неверный путь");
  return full;
}

/**
 * Дешёвый отпечаток сюжета без ffprobe: файлы папки (имя, размер, время) и прогоны (время run.json).
 * Страница сравнивает его каждые пару секунд и перерисовывает сюжет, только когда что-то поменялось.
 * Рабочая папка .rm (кадры, чат) не входит: она меняется постоянно и на вид сюжета не влияет.
 */
export async function storyStamp(storyDir: string, outDir: string): Promise<string> {
  const parts: string[] = [];
  for (const e of await readdir(storyDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const st = await stat(join(storyDir, e.name)).catch(() => null);
    if (st) parts.push(`${e.name}:${st.size}:${Math.round(st.mtimeMs)}`);
  }
  for (const e of await readdir(outDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const st = await stat(join(outDir, e.name, "run.json")).catch(() => null);
    if (st) parts.push(`run/${e.name}:${Math.round(st.mtimeMs)}`);
  }
  return parts.sort().join("|");
}

async function storyList(opts: HubOptions, busy: readonly string[] = []) {
  const out = [];
  for (const id of await listStoryDirs(opts.inboxDir)) {
    const files = await readdir(join(opts.inboxDir, id)).catch(() => [] as string[]);
    const runs = await listRuns(opts.outputDir, id);
    const last = runs[0];
    out.push({
      id,
      kind: await storyKind(join(opts.inboxDir, id)),
      clips: files.filter((f) => VIDEO_RE.test(f)).length,
      transcripts: files.filter((f) => f.endsWith(".transcript.json")).length,
      agentBusy: busy.includes(id),
      lastRun: last
        ? { id: last.id, ready: last.variants.filter((v) => v.status === "ready").length, count: last.count, finished: last.finishedAt !== null }
        : null,
    });
  }
  return out;
}

function intIn(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function createHub(opts: HubOptions): { server: Server; jobs: JobQueue; agents: AgentHub } {
  const jobs = createJobQueue();
  const agents =
    opts.agents ??
    createAgentHub({ cliPath: RM_CLI, hubUrl: opts.hubUrl ?? "http://127.0.0.1:8787", proxy: opts.agentProxy ?? null, systemPrompt: (s, d) => editorPrompt(s, d, RM_CLI) });
  const scanOpts = { ffprobePath: opts.ffprobePath, probe: opts.hooks?.probe };
  const presetIds = () => opts.presets.map((p) => p.id);
  const fwd = (p: string) => p.replace(/\\/g, "/");

  // оформление владельца поверх встроенного пресета (одно на все варианты): шрифты, размеры, цвета
  const basePresets = opts.presets.map((p) => structuredClone(p));
  const userFonts = opts.dataDir ? join(opts.dataDir, "fonts") : null;
  const styleFile = opts.dataDir ? join(opts.dataDir, "style.json") : null;
  const fonts = (): FontInfo[] =>
    listFonts([{ dir: join(opts.presetsDir, "fonts"), source: "builtin" }, ...(userFonts ? [{ dir: userFonts, source: "user" as const }] : [])]);
  let style: StyleOverride = {};
  const applyAll = () => {
    const list = fonts();
    (opts.presets as Preset[]).splice(0, opts.presets.length, ...basePresets.map((p) => applyStyle(p, style, list)));
  };
  const styleReady = styleFile
    ? readStyle(styleFile).then((st) => {
        style = st;
        applyAll();
      })
    : Promise.resolve();
  const styleView = () => {
    const list = fonts();
    const p = opts.presets[0]!;
    return {
      enabled: styleFile !== null,
      layers: Object.fromEntries(LAYERS.map((l) => [l, layerView(p[l], list)])),
      saved: style,
      fonts: list.map((x) => ({ file: x.file, family: x.family, source: x.source, url: `/fonts/${encodeURIComponent(x.file)}` })),
    };
  };
  const runsWithDir = async (id: string) => (await listRuns(opts.outputDir, id)).map((r) => ({ ...r, dir: fwd(join(opts.outputDir, id, r.id)) }));
  /** сводка монтажа для страницы и команды rm */
  const montageView = (m: MontageScan) => ({
    dir: fwd(m.dir),
    sources: m.sources.map((s) => ({ name: s.name, role: s.role, probe: s.probe, crop: s.crop })),
    roles: Object.fromEntries(Object.entries(m.roles).map(([k, v]) => [k, v?.name])),
    screens: m.screens.map((x) => x.name),
    count: m.count,
    transcribed: m.transcript !== null,
    transcriptFresh: m.transcriptFresh,
    replicas: m.replicas,
    edit: m.edit,
    editError: m.editError,
    problems: m.problems,
  });
  const openFolder =
    opts.openFolder ?? ((path: string) => spawn("explorer.exe", [path], { detached: true, stdio: "ignore", windowsHide: false }).unref());

  async function requireStory(id: string): Promise<string> {
    if (!isSafeName(id) || !(await listStoryDirs(opts.inboxDir)).includes(id)) throw new HttpError(404, `нет сюжета «${id}»`);
    return id;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const method = req.method ?? "GET";
    await styleReady;

    if (method === "GET" && parts.length === 0) {
      const html = Buffer.from(PAGE_HTML);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length, "cache-control": "no-store" });
      res.end(html);
      return;
    }
    // кадры для агента и страницы: /in/<сюжет>/.rm/frames/<файл>
    if (method === "GET" && parts[0] === "in" && parts[2] === WORK_DIR && parts[3] === "frames" && parts.length === 5) {
      await sendFile(req, res, safeJoin(opts.inboxDir, parts.slice(1)));
      return;
    }
    if (method === "GET" && parts.length === 1 && (parts[0] === "icon.svg" || parts[0] === "icon-192.png")) {
      await sendFile(req, res, fileURLToPath(new URL(`../public/${parts[0]}`, import.meta.url)));
      return;
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "md.js") {
      const js = Buffer.from(MD_JS);
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": js.length, "cache-control": "no-store" });
      res.end(js);
      return;
    }
    if (method === "GET" && parts[0] === "out") {
      await sendFile(req, res, safeJoin(opts.outputDir, parts.slice(1)));
      return;
    }
    // шрифты для образца в окне «Оформление»: /fonts/<файл>
    if (method === "GET" && parts[0] === "fonts" && parts.length === 2) {
      const f = fonts().find((x) => x.file === parts[1]);
      if (!f) throw new HttpError(404, "нет такого шрифта");
      await sendFile(req, res, f.path);
      return;
    }
    if (parts[0] !== "api") throw new HttpError(404, "нет такой страницы");

    // GET /api/style — оформление (шрифт, размер, цвета слоёв) и доступные шрифты
    if (method === "GET" && parts[1] === "style" && parts.length === 2) {
      sendJson(res, 200, styleView());
      return;
    }
    // POST /api/style {hook?, caption?, block?} | {reset: true}
    if (method === "POST" && parts[1] === "style" && parts.length === 2) {
      if (!styleFile) throw new HttpError(409, "папка данных не задана — оформление не сохранить");
      const body = await readJson(req);
      let next: StyleOverride;
      try {
        next = body["reset"] === true ? {} : cleanStyle(body, fonts());
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await mkdir(opts.dataDir!, { recursive: true });
      await writeStyle(styleFile, next);
      style = next;
      applyAll();
      sendJson(res, 200, styleView());
      return;
    }
    // POST /api/fonts?name=<файл.ttf|otf> (тело — файл шрифта) — свой шрифт в папку данных
    if (method === "POST" && parts[1] === "fonts" && parts.length === 2) {
      if (!userFonts) throw new HttpError(409, "папка данных не задана — шрифт некуда сохранить");
      const name = (url.searchParams.get("name") ?? "").split(/[\\/]/).pop()!.trim();
      if (!FONT_RE.test(name) || !isSafeName(name)) throw new HttpError(400, "нужен файл .ttf или .otf с обычным именем");
      const buf = await readRaw(req, 20 * 1024 * 1024);
      const family = fontFamily(buf);
      if (!family) throw new HttpError(400, `«${name}» — не шрифт TrueType/OpenType`);
      await mkdir(userFonts, { recursive: true });
      await writeFile(join(userFonts, name), buf);
      applyAll();
      sendJson(res, 200, { file: name, family, source: "user" });
      return;
    }

    // GET /api/state
    if (method === "GET" && parts[1] === "state") {
      sendJson(res, 200, {
        inboxDir: opts.inboxDir,
        outputDir: opts.outputDir,
        hw: opts.hw,
        concurrency: opts.concurrency,
        stt: opts.stt !== null,
        presets: opts.presets.map((p) => ({ id: p.id, title: p.title })),
        models: MODELS,
        jobs: jobs.list().slice(0, 10),
      });
      return;
    }
    // GET /api/stories
    if (method === "GET" && parts[1] === "stories" && parts.length === 2) {
      sendJson(res, 200, await storyList(opts, agents.busyStories()));
      return;
    }
    // GET /api/stories/:id
    if (method === "GET" && parts[1] === "stories" && parts.length === 3) {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const kind = await storyKind(dir);
      const base = { kind, runs: await runsWithDir(id), jobs: jobs.activeFor(id) };
      if (kind === "montage") sendJson(res, 200, { ...base, montage: montageView(await scanMontage(dir, id, scanOpts)) });
      else sendJson(res, 200, { ...base, scan: await scanStory(dir, id, scanOpts) });
      return;
    }
    // GET /api/stories/:id/stamp — отпечаток сюжета и активные задачи (частый опрос страницы)
    if (method === "GET" && parts[1] === "stories" && parts[3] === "stamp") {
      const id = await requireStory(parts[2]!);
      sendJson(res, 200, {
        stamp: await storyStamp(join(opts.inboxDir, id), join(opts.outputDir, id)),
        jobs: jobs.activeFor(id).map((j) => j.id),
      });
      return;
    }
    // GET /api/stories/:id/runs — без ffprobe, для частого обновления во время сборки
    if (method === "GET" && parts[1] === "stories" && parts[3] === "runs") {
      const id = await requireStory(parts[2]!);
      sendJson(res, 200, await runsWithDir(id));
      return;
    }
    // GET /api/stories/:id/montage — исходники, роли, реплики, лист
    if (method === "GET" && parts[1] === "stories" && parts[3] === "montage") {
      const id = await requireStory(parts[2]!);
      sendJson(res, 200, montageView(await scanMontage(join(opts.inboxDir, id), id, scanOpts)));
      return;
    }
    // GET /api/stories/:id/words?from=&to= — слова основы со временем, чтобы резать внутри реплики
    if (method === "GET" && parts[1] === "stories" && parts[3] === "words") {
      const id = await requireStory(parts[2]!);
      const m = await scanMontage(join(opts.inboxDir, id), id, scanOpts);
      if (!m.transcript) throw new HttpError(409, "основа ещё не расшифрована");
      const num = (k: string, d: number) => (url.searchParams.has(k) && Number.isFinite(Number(url.searchParams.get(k))) ? Number(url.searchParams.get(k)) : d);
      const from = num("from", -Infinity);
      const to = num("to", Infinity);
      sendJson(res, 200, { words: m.transcript.words.filter((w) => w.end >= from && w.start <= to) });
      return;
    }
    // POST /api/stories/:id/frames {source: роль|файл, times?: [], grid?: N, width?, full?} — кадры с кропом (full — весь кадр)
    if (method === "POST" && parts[1] === "stories" && parts[3] === "frames") {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const body = await readJson(req);
      const m = await scanMontage(dir, id, scanOpts);
      const want = String(body["source"] ?? "");
      const src = m.roles[want as SourceRole] ?? m.sources.find((s) => s.name === want);
      if (!src) throw new HttpError(404, `нет исходника «${want}» (роли: ${SOURCE_ROLES.join(", ")}; файлы: ${m.sources.map((s) => s.name).join(", ")})`);
      const dur = src.probe?.duration ?? 0;
      const grid = intIn(body["grid"], 0, 24, 0);
      const times =
        grid > 0
          ? Array.from({ length: grid }, (_, i) => Math.round(((i + 0.5) * dur * 100) / grid) / 100)
          : (Array.isArray(body["times"]) ? body["times"] : []).map(Number).slice(0, 24);
      if (times.length === 0) throw new HttpError(400, "нужны times или grid");
      const width = intIn(body["width"], 160, 1080, 540);
      const frames = [];
      for (const t of times) {
        let path: string;
        try {
          path = await grabFrame(opts.ffmpegPath, dir, src, t, { width, full: body["full"] === true });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        const file = path.split(/[\\/]/).pop()!;
        frames.push({ t, path: fwd(path), url: `/in/${encodeURIComponent(id)}/${WORK_DIR}/frames/${encodeURIComponent(file)}` });
      }
      sendJson(res, 200, { source: src.name, role: src.role, frames });
      return;
    }
    // POST /api/stories/:id/roles {talk, wide, screen}
    if (method === "POST" && parts[1] === "stories" && parts[3] === "roles") {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const body = await readJson(req);
      const names = (await readdir(dir)).filter((f) => VIDEO_RE.test(f));
      const meta = await readMeta(dir);
      const sources = { ...meta.sources };
      for (const role of SOURCE_ROLES) {
        if (!(role in body)) continue;
        const v = body[role];
        // скринкастов может быть несколько: массив имён; основа и дальний — одно имя
        const list = (Array.isArray(v) && role === "screen" ? v : [v]).filter((x) => x !== null && x !== "");
        for (const x of list) if (typeof x !== "string" || !names.includes(x)) throw new HttpError(400, `${role}: нет видео «${String(x)}» в папке сюжета`);
        if (list.length === 0) delete sources[role];
        else sources[role] = list.length === 1 ? (list[0] as string) : (list as string[]);
      }
      await writeMeta(dir, { ...meta, sources });
      sendJson(res, 200, { roles: sources });
      return;
    }
    // POST /api/stories/:id/settings {count} — сколько вариантов нужно в итоге (null — не задано)
    if (method === "POST" && parts[1] === "stories" && parts[3] === "settings") {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const body = await readJson(req);
      const meta = await readMeta(dir);
      if ("count" in body) {
        if (body["count"] === null || body["count"] === "") delete meta.count;
        else {
          const n = Number(body["count"]);
          if (!Number.isInteger(n) || n < 1 || n > 30) throw new HttpError(400, "count: целое 1–30");
          meta.count = n;
        }
      }
      await writeMeta(dir, meta);
      sendJson(res, 200, { count: meta.count ?? null });
      return;
    }
    // POST /api/stories/:id/crop {source: роль|файл, crop: {x,y,w,h} в долях | null — весь кадр}
    if (method === "POST" && parts[1] === "stories" && parts[3] === "crop") {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const body = await readJson(req);
      const m = await scanMontage(dir, id, scanOpts);
      const want = String(body["source"] ?? "");
      const src = m.roles[want as SourceRole] ?? m.sources.find((x) => x.name === want);
      if (!src) throw new HttpError(404, `нет исходника «${want}»`);
      const crop = body["crop"] === null ? null : cleanCrop(body["crop"]);
      if (body["crop"] !== null && !crop && body["crop"] !== undefined) {
        const c = body["crop"] as Record<string, unknown> | undefined;
        // весь кадр (w=h=1) — это сброс кропа, а не ошибка
        if (!(c && Number(c["w"]) >= 0.999 && Number(c["h"]) >= 0.999)) throw new HttpError(400, "crop: нужны x, y, w, h в долях кадра (0…1)");
      }
      const meta = await readMeta(dir);
      const crops = { ...meta.crops };
      if (crop) crops[src.name] = crop;
      else delete crops[src.name];
      await writeMeta(dir, { ...meta, crops });
      sendJson(res, 200, { source: src.name, crop });
      return;
    }
    // POST /api/stories/:id/check {edit?} — проверить лист (без edit — файл edit.json)
    if (method === "POST" && parts[1] === "stories" && parts[3] === "check") {
      const id = await requireStory(parts[2]!);
      const body = await readJson(req, 2 * 1024 * 1024);
      const m = await scanMontage(join(opts.inboxDir, id), id, scanOpts);
      if (m.editError && !body["edit"]) throw new HttpError(422, m.editError);
      const edit = (body["edit"] as EditList | undefined) ?? m.edit;
      if (!edit) throw new HttpError(404, "монтажного листа edit.json ещё нет");
      let r;
      try {
        r = checkEdit(m, edit, presetIds());
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
      if (m.count && edit.variants?.length !== m.count)
        r.warnings.push(`в листе ${edit.variants?.length ?? 0} вариантов, владелец просит ${m.count} — ${(edit.variants?.length ?? 0) < m.count ? "допишите" : "сократите"} лист`);
      sendJson(res, 200, {
        errors: r.errors,
        warnings: r.warnings,
        variants: r.plans.map((p, i) => ({
          id: edit.variants[i]?.id ?? String(p.index),
          hook: p.hook.text,
          preset: p.preset,
          label: montageLabel(p, m.replicas, m.screens.length),
          duration: p.scenes.reduce((sum, x) => sum + x.trim.end - x.trim.start, 0) / p.speed,
        })),
      });
      return;
    }
    // POST /api/stories/:id/build-edit {variants?, hw?, concurrency?} — собрать по монтажному листу
    if (method === "POST" && parts[1] === "stories" && parts[3] === "build-edit") {
      const id = await requireStory(parts[2]!);
      const body = await readJson(req);
      const hw: HwMode = body["hw"] === "cpu" || body["hw"] === "nvenc" ? body["hw"] : opts.hw;
      const build = {
        hw,
        concurrency: intIn(body["concurrency"], 1, 8, opts.concurrency),
        variants: Array.isArray(body["variants"]) ? body["variants"].filter((x): x is string => typeof x === "string") : [],
      };
      const job = jobs.add("build", id, async (ctx) => {
        const t0 = Date.now();
        ctx.log(`сборка по листу: ${build.variants.length ? build.variants.join(", ") : "все варианты"}, ${hw === "nvenc" ? "видеокарта" : "процессор"}`);
        const run = await buildMontage(id, build, opts, { ...opts.hooks, log: ctx.log, progress: ctx.progress, onRun: ctx.setRun });
        const ready = run.variants.filter((v) => v.status === "ready").length;
        ctx.log(`готово ${ready} из ${run.count} за ${((Date.now() - t0) / 1000).toFixed(0)} с → ${join(opts.outputDir, id, run.id)}`);
        if (ready === 0) throw new Error("ни один вариант не собран — смотрите ffmpeg.log варианта");
      });
      sendJson(res, 202, job);
      return;
    }
    // агент-монтажёр: GET /api/stories/:id/agent?since=rev
    if (method === "GET" && parts[1] === "stories" && parts[3] === "agent" && parts.length === 4) {
      const id = await requireStory(parts[2]!);
      sendJson(res, 200, await agents.view(id, Number(url.searchParams.get("since") ?? 0), join(opts.inboxDir, id)));
      return;
    }
    // POST /api/stories/:id/agent/<send|perm|stop|reset>
    if (method === "POST" && parts[1] === "stories" && parts[3] === "agent" && parts.length === 5) {
      const id = await requireStory(parts[2]!);
      const dir = join(opts.inboxDir, id);
      const body = await readJson(req, 256 * 1024);
      const act = parts[4];
      if (act === "send") {
        const text = String(body["text"] ?? "").trim();
        if (!text) throw new HttpError(400, "пустое сообщение");
        const model = typeof body["model"] === "string" && (MODELS as readonly string[]).includes(body["model"]) ? body["model"] : undefined;
        try {
          await agents.send(id, dir, text, model);
        } catch (e) {
          throw new HttpError(503, (e as Error).message);
        }
      } else if (act === "perm") {
        try {
          agents.decide(id, String(body["reqId"] ?? ""), body["allow"] === true);
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
      } else if (act === "stop") agents.stop(id);
      else if (act === "reset") await agents.reset(id, dir);
      else throw new HttpError(404, "нет такого действия агента");
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /api/stories/:id/transcribe {force}
    if (method === "POST" && parts[1] === "stories" && parts[3] === "transcribe") {
      const id = await requireStory(parts[2]!);
      const body = await readJson(req);
      const stt = opts.stt;
      if (!stt) throw new HttpError(409, "расшифровка не настроена: задайте RF_STT_PYTHON и RF_STT_MODEL в .env");
      const dir = join(opts.inboxDir, id);
      if ((await storyKind(dir)) === "montage") {
        const job = jobs.add("transcribe", id, async (ctx) => {
          const did = await transcribeTalk(await scanMontage(dir, id, scanOpts), { stt, force: body["force"] === true, log: ctx.log });
          if (!did) ctx.log("расшифровка основы свежая — нечего делать");
        });
        sendJson(res, 202, job);
        return;
      }
      const job = jobs.add("transcribe", id, async (ctx) => {
        const t0 = Date.now();
        const r = await (opts.hooks?.transcribe ?? transcribeStory)(join(opts.inboxDir, id), id, {
          ffprobePath: opts.ffprobePath,
          probe: opts.hooks?.probe,
          stt,
          force: body["force"] === true,
          log: ctx.log,
        });
        ctx.log(`расшифровано ${r.done.length}, ошибок ${r.failed.length}, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
        if (r.done.length === 0 && r.failed.length === 0) ctx.log("все расшифровки свежие — нечего делать");
      });
      sendJson(res, 202, job);
      return;
    }
    // POST /api/stories/:id/build {count, presets, hw, concurrency}
    if (method === "POST" && parts[1] === "stories" && parts[3] === "build") {
      const id = await requireStory(parts[2]!);
      const body = await readJson(req);
      const hw: HwMode = body["hw"] === "cpu" || body["hw"] === "nvenc" ? body["hw"] : opts.hw;
      const build = {
        count: intIn(body["count"], 1, 30, 10),
        presets: Array.isArray(body["presets"]) ? body["presets"].filter((x): x is string => typeof x === "string") : [],
        hw,
        concurrency: intIn(body["concurrency"], 1, 8, opts.concurrency),
      };
      const job = jobs.add("build", id, async (ctx) => {
        const t0 = Date.now();
        ctx.log(`сборка: ${build.count} вариантов, ${build.hw === "nvenc" ? "видеокарта (NVENC)" : "процессор (libx264)"}, параллельно ${build.concurrency}`);
        const run = await buildStory(id, build, opts, {
          ...opts.hooks,
          log: ctx.log,
          progress: ctx.progress,
          onRun: ctx.setRun,
        });
        const ready = run.variants.filter((v) => v.status === "ready").length;
        ctx.log(`готово ${ready} из ${run.count} за ${((Date.now() - t0) / 1000).toFixed(0)} с → ${join(opts.outputDir, id, run.id)}`);
        if (ready === 0) throw new Error("ни один вариант не собран — смотрите ffmpeg.log варианта");
      });
      sendJson(res, 202, job);
      return;
    }
    // GET /api/jobs/:id
    if (method === "GET" && parts[1] === "jobs" && parts.length === 3) {
      const job = jobs.get(Number(parts[2]));
      if (!job) throw new HttpError(404, "нет такой задачи");
      sendJson(res, 200, job);
      return;
    }
    // POST /api/open {story, run?}
    if (method === "POST" && parts[1] === "open") {
      const body = await readJson(req);
      const story = await requireStory(String(body["story"] ?? ""));
      const segs = typeof body["run"] === "string" && body["run"] ? [story, body["run"]] : [story];
      const path = body["where"] === "inbox" ? safeJoin(opts.inboxDir, [story]) : safeJoin(opts.outputDir, segs);
      openFolder(path);
      sendJson(res, 200, { ok: true, path });
      return;
    }
    throw new HttpError(404, "нет такого метода");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
      else res.end();
    });
  });
  return { server, jobs, agents };
}
