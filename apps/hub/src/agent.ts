// Агент-монтажёр сюжета: тот же Claude Code, что в окне VS Code (claude.exe расширения или claude из PATH, протокол
// stream-json), без окна. Авторизация — вход Claude Code пользователя (подписка), ключа API нет. К Anthropic — напрямую
// или через HTTP(S)-прокси из настроек (RF_AGENT_PROXY), если он отвечает. Один процесс на сюжет, сессия — через --resume.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve, sep } from "node:path";
import { WORK_DIR } from "@reels-factory/pc-agent";

export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const;
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export type ItemKind = "user" | "assistant" | "tool" | "perm" | "status" | "result";

export interface AgentItem {
  rev: number;
  id: string;
  t: ItemKind;
  at: number;
  text?: string;
  /** инструмент */
  name?: string;
  line?: string;
  desc?: string;
  status?: "run" | "ok" | "err" | "wait" | "allowed" | "denied";
  result?: string;
  reqId?: string;
  ok?: boolean;
  bad?: boolean;
  live?: boolean;
}

interface PendingReq {
  tool_name: string;
  input: Record<string, unknown>;
}

export interface StoryAgent {
  story: string;
  dir: string;
  proc: ChildProcessWithoutNullStreams | null;
  items: AgentItem[];
  rev: number;
  busy: boolean;
  /** когда начался текущий ход (мс), для таймера на странице */
  busySince: number | null;
  dead: boolean;
  sessionId: string | null;
  model: string;
  viaProxy: boolean;
  pending: Map<string, PendingReq>;
  live: AgentItem | null;
  lastErr: string | null;
  stopping: boolean;
}

/** claude.exe расширения Claude Code для VS Code, иначе claude из PATH. */
export function claudeBinary(): string | null {
  const ext = join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? "", ".vscode", "extensions");
  try {
    const d = readdirSync(ext)
      .filter((x) => x.startsWith("anthropic.claude-code-"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    const p = d && join(ext, d, "resources", "native-binary", process.platform === "win32" ? "claude.exe" : "claude");
    if (p && existsSync(p)) return p;
  } catch {
    // расширения нет
  }
  return null;
}

/** Отвечает ли прокси (TCP-подключение к его хосту и порту). */
export function proxyUp(proxy: string): Promise<boolean> {
  let host: string, port: number;
  try {
    const u = new URL(proxy);
    host = u.hostname;
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((res) => {
    const s = connect(port, host);
    s.setTimeout(800);
    s.on("connect", () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.on("timeout", () => {
      s.destroy();
      res(false);
    });
  });
}

const short = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export function toolSummary(name: string, input: Record<string, unknown> = {}): Pick<AgentItem, "line" | "desc"> {
  switch (name) {
    case "Bash":
      return { line: short(input["command"], 400), desc: input["description"] ? short(input["description"], 140) : "" };
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { line: String(input["file_path"] ?? "") };
    case "Grep":
    case "Glob":
      return { line: String(input["pattern"] ?? "") };
    default:
      return { line: short(input, 300) };
  }
}

/**
 * Что агент делает без вопроса: чтение и поиск везде; правка — только внутри папки сюжета; Bash — только команда rm
 * (API ReelsMaker) и безобидное чтение. Остальное — карточка «Разрешить / Запретить» на странице.
 */
export function autoDecide(req: PendingReq, storyDir: string, cliPath: string): "allow" | null {
  const name = req.tool_name;
  const inp = req.input ?? {};
  if (/^(Read|Glob|Grep|TodoWrite|LS)$/.test(name)) return "allow";
  if (/^(Edit|Write|MultiEdit)$/.test(name)) {
    const root = resolve(storyDir).toLowerCase();
    const p = resolve(String(inp["file_path"] ?? "")).toLowerCase();
    return p === root || p.startsWith(root + sep) ? "allow" : null;
  }
  if (name === "Bash") {
    const cmd = String(inp["command"] ?? "");
    const cli = cliPath.replace(/\\/g, "/").toLowerCase();
    const segs = cmd.split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean);
    const ok = (seg: string) => {
      const norm = seg.replace(/\\/g, "/").replace(/"/g, "").toLowerCase();
      if (/[|>`$]/.test(seg)) return false;
      return norm.startsWith(`node ${cli}`) || /^(cd|ls|dir|cat|type|head|tail|wc|pwd|echo)\b/.test(norm) || /^ffprobe\b/.test(norm);
    };
    return segs.length > 0 && segs.every(ok) ? "allow" : null;
  }
  return null;
}

export interface AgentHubOptions {
  cliPath: string;
  hubUrl: string;
  systemPrompt: (story: string, dir: string) => string;
  /** подмена запуска (тесты) */
  spawnProc?: (args: string[], cwd: string, env: Record<string, string>) => ChildProcessWithoutNullStreams;
  bin?: () => string | null;
  /** HTTP(S)-прокси к Anthropic (RF_AGENT_PROXY); нет — напрямую */
  proxy?: string | null;
  /** подмена проверки прокси (тесты) */
  proxyCheck?: (proxy: string) => Promise<boolean>;
}

const SESSION_FILE = "agent.json";
/** История окна агента: переживает перезапуск интерфейса (сама сессия — у Claude Code, --resume). */
const CHAT_FILE = "chat.json";

export function createAgentHub(opts: AgentHubOptions) {
  const agents = new Map<string, StoryAgent>();

  const push = (a: StoryAgent, item: Omit<AgentItem, "rev" | "at"> & { at?: number }): AgentItem => {
    const it: AgentItem = { ...item, rev: ++a.rev, at: item.at ?? Date.now() };
    a.items.push(it);
    if (a.items.length > 800) a.items.splice(0, a.items.length - 800);
    return it;
  };
  const touch = (a: StoryAgent, it: AgentItem) => {
    it.rev = ++a.rev;
  };
  const byId = (a: StoryAgent, id: string) => a.items.find((x) => x.id === id);
  const sessionPath = (dir: string) => join(dir, WORK_DIR, SESSION_FILE);

  async function loadSession(dir: string): Promise<{ sessionId?: string; model?: string }> {
    try {
      return JSON.parse(await readFile(sessionPath(dir), "utf8"));
    } catch {
      return {};
    }
  }
  function persist(a: StoryAgent): void {
    const items = a.items.filter((x) => !x.live).slice(-300);
    void mkdir(join(a.dir, WORK_DIR), { recursive: true })
      .then(() => writeFile(join(a.dir, WORK_DIR, CHAT_FILE), JSON.stringify(items)))
      .catch(() => {});
  }

  /** Агент, которого нет в памяти (перезапуск интерфейса): история и сессия — с диска, процесс не запускается. */
  async function dormant(story: string, dir: string): Promise<StoryAgent> {
    const have = agents.get(story);
    if (have) return have;
    const saved = await loadSession(dir);
    let items: AgentItem[] = [];
    try {
      items = JSON.parse(await readFile(join(dir, WORK_DIR, CHAT_FILE), "utf8")) as AgentItem[];
    } catch {
      items = [];
    }
    const a: StoryAgent = {
      story, dir, proc: null, items, rev: items.reduce((m, x) => Math.max(m, x.rev), 0), busy: false, busySince: null, dead: true,
      sessionId: saved.sessionId ?? null, model: saved.model ?? DEFAULT_MODEL, viaProxy: false, pending: new Map(),
      live: null, lastErr: null, stopping: false,
    };
    agents.set(story, a);
    return a;
  }

  async function saveSession(a: StoryAgent): Promise<void> {
    await mkdir(join(a.dir, WORK_DIR), { recursive: true });
    await writeFile(sessionPath(a.dir), JSON.stringify({ sessionId: a.sessionId, model: a.model }, null, 2));
  }

  function write(a: StoryAgent, obj: unknown): void {
    if (!a.proc || a.dead) throw new Error("агент не запущен");
    a.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  function onMsg(a: StoryAgent, m: Record<string, any>): void {
    if (m["type"] === "system" && m["subtype"] === "init") {
      a.sessionId = m["session_id"];
      a.model = m["model"] ?? a.model;
      void saveSession(a);
      push(a, { id: `init-${a.rev}`, t: "status", text: `Сессия ${String(m["session_id"]).slice(0, 8)} · модель ${a.model}` });
    } else if (m["type"] === "stream_event") {
      const e = m["event"] ?? {};
      if (e.type === "message_start" && e.message) a.live = push(a, { id: e.message.id, t: "assistant", text: "", live: true });
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && a.live) {
        a.live.text = (a.live.text ?? "") + e.delta.text;
        touch(a, a.live);
      }
    } else if (m["type"] === "assistant" && m["message"]) {
      const msg = m["message"];
      const text = (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const it = byId(a, msg.id);
      if (it) {
        if (text) it.text = text;
        it.live = false;
        touch(a, it);
      } else if (text) push(a, { id: msg.id, t: "assistant", text });
      for (const b of msg.content ?? []) {
        if (b.type === "tool_use" && !byId(a, b.id)) push(a, { id: b.id, t: "tool", name: b.name, ...toolSummary(b.name, b.input), status: "run" });
      }
    } else if (m["type"] === "user" && Array.isArray(m["message"]?.content)) {
      for (const b of m["message"].content) {
        if (b.type !== "tool_result") continue;
        const it = byId(a, b.tool_use_id);
        if (!it) continue;
        it.status = b.is_error ? "err" : "ok";
        const c = b.content;
        it.result = short(typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : x?.type === "image" ? "[кадр]" : "")).join("") : "", 900);
        touch(a, it);
      }
    } else if (m["type"] === "result") {
      a.busy = false;
      a.live = null;
      for (const it of a.items) if (it.t === "tool" && it.status === "run") {
        it.status = "ok";
        touch(a, it);
      }
      const ok = m["subtype"] === "success" && !m["is_error"];
      push(a, { id: `res-${a.rev}`, t: "result", ok, text: ok ? `${Math.round((m["duration_ms"] ?? 0) / 1000)} с` : String(m["subtype"] ?? "ошибка") });
      persist(a);
    } else if (m["type"] === "control_request" && m["request"]?.subtype === "can_use_tool") {
      const req = m["request"] as PendingReq;
      if (autoDecide(req, a.dir, opts.cliPath) === "allow") {
        write(a, { type: "control_response", response: { subtype: "success", request_id: m["request_id"], response: { behavior: "allow", updatedInput: req.input } } });
        return;
      }
      a.pending.set(m["request_id"], req);
      persist(a);
      push(a, { id: `perm-${m["request_id"]}`, t: "perm", reqId: m["request_id"], name: req.tool_name, ...toolSummary(req.tool_name, req.input), status: "wait" });
    }
  }

  async function start(story: string, dir: string, model?: string): Promise<StoryAgent> {
    const old = await dormant(story, dir);
    if (!old.dead && old.proc) return old;
    const saved = await loadSession(dir);
    const a: StoryAgent = {
      story,
      dir,
      proc: null,
      items: old.items,
      rev: old.rev,
      busy: false,
      busySince: null,
      dead: false,
      sessionId: saved.sessionId ?? null,
      model: model || saved.model || DEFAULT_MODEL,
      viaProxy: false,
      pending: new Map(),
      live: null,
      lastErr: null,
      stopping: false,
    };
    agents.set(story, a);
    const args = [
      "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      "--permission-prompt-tool=stdio", "--setting-sources=user,project,local", "--permission-mode=acceptEdits",
      "--include-partial-messages",
      // MCP-серверы пользователя — тысячи токенов описаний на каждый ход; монтажёру не нужны
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--model", a.model,
      "--append-system-prompt", opts.systemPrompt(story, dir),
    ];
    if (a.sessionId) args.push(`--resume=${a.sessionId}`);
    const up = opts.proxy ? await (opts.proxyCheck ?? proxyUp)(opts.proxy) : false;
    const env: Record<string, string> = {
      CLAUDE_CODE_ENTRYPOINT: "reelsmaker",
      RM_STORY: story,
      RM_HUB: opts.hubUrl,
      ...(up
        ? { HTTPS_PROXY: opts.proxy!, HTTP_PROXY: opts.proxy!, NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
        : {}),
    };
    a.viaProxy = up;
    let proc: ChildProcessWithoutNullStreams;
    if (opts.spawnProc) proc = opts.spawnProc(args, dir, env);
    else {
      const bin = (opts.bin ?? claudeBinary)();
      if (!bin) {
        a.dead = true;
        push(a, { id: `err-${a.rev}`, t: "status", text: "Не найден claude.exe расширения Claude Code для VS Code", bad: true });
        throw new Error("не найден claude.exe расширения VS Code");
      }
      proc = spawn(bin, args, { cwd: dir, windowsHide: true, env: { ...process.env, ...env } });
    }
    a.proc = proc;
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onMsg(a, JSON.parse(line));
        } catch {
          // не JSON
        }
      }
    });
    proc.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) a.lastErr = short(s, 300);
    });
    proc.on("error", (e) => {
      a.dead = true;
      push(a, { id: `err-${a.rev}`, t: "status", text: `Не удалось запустить агента: ${e.message}`, bad: true });
    });
    proc.on("close", (code) => {
      a.dead = true;
      a.busy = false;
      a.pending.clear();
      push(a, {
        id: `end-${a.rev}`,
        t: "status",
        text:
          code === 0 || a.stopping
            ? "Агент остановлен. Сессия сохранена — следующее сообщение продолжит её."
            : `Агент завершился (код ${code})${a.lastErr ? ": " + a.lastErr : ""}`,
        bad: !(code === 0 || a.stopping),
      });
      persist(a);
    });
    write(a, { type: "control_request", request_id: `init_${Date.now()}`, request: { subtype: "initialize", hooks: null } });
    push(a, {
      id: `start-${a.rev}`,
      t: "status",
      text: `${a.sessionId ? `Продолжаю сессию ${a.sessionId.slice(0, 8)}…` : "Новая сессия…"} Модель ${a.model}. Выход к Anthropic: ${up ? `через прокси ${opts.proxy}` : opts.proxy ? `напрямую (прокси ${opts.proxy} не отвечает)` : "напрямую"}.`,
    });
    return a;
  }

  return {
    async send(story: string, dir: string, text: string, model?: string): Promise<StoryAgent> {
      let a = agents.get(story);
      if (a && !a.dead && model && model !== a.model) {
        // смена модели — новый процесс с той же сессией
        a.stopping = true;
        a.proc?.kill();
        await new Promise((r) => setTimeout(r, 300));
      }
      a = await start(story, dir, model);
      push(a, { id: `u-${a.rev}`, t: "user", text });
      persist(a);
      a.busy = true;
      a.busySince = Date.now();
      write(a, { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
      return a;
    },
    decide(story: string, reqId: string, allow: boolean): void {
      const a = agents.get(story);
      const req = a?.pending.get(reqId);
      if (!a || !req) throw new Error("нет такого запроса разрешения");
      a.pending.delete(reqId);
      write(a, {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: allow ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "Отклонено владельцем в ReelsMaker" },
        },
      });
      const it = byId(a, `perm-${reqId}`);
      if (it) {
        it.status = allow ? "allowed" : "denied";
        touch(a, it);
      }
    },
    stop(story: string): void {
      const a = agents.get(story);
      if (!a || a.dead) return;
      a.stopping = true;
      try {
        write(a, { type: "control_request", request_id: `x${Date.now()}`, request: { subtype: "interrupt" } });
      } catch {
        // уже закрыт
      }
      setTimeout(() => a.proc?.kill(), 400);
    },
    /** Новая беседа: процесс останавливается, сохранённая сессия забывается. */
    async reset(story: string, dir: string): Promise<void> {
      const a = agents.get(story);
      if (a && !a.dead) {
        a.stopping = true;
        a.proc?.kill();
      }
      agents.delete(story);
      await mkdir(join(dir, WORK_DIR), { recursive: true });
      await writeFile(sessionPath(dir), "{}");
      await writeFile(join(dir, WORK_DIR, CHAT_FILE), "[]");
    },
    async view(story: string, since = 0, dir?: string) {
      const a = dir ? await dormant(story, dir) : agents.get(story);
      if (!a) return { alive: false, busy: false, busySince: null as number | null, model: null as string | null, sessionId: null as string | null, viaProxy: false, rev: 0, items: [] as AgentItem[] };
      return {
        alive: !a.dead && !!a.proc,
        busy: a.busy,
        busySince: a.busy ? a.busySince : null,
        model: a.model,
        sessionId: a.sessionId,
        viaProxy: a.viaProxy,
        rev: a.rev,
        items: a.items.filter((x) => x.rev > since),
      };
    },
    /** сюжеты, где монтажёр сейчас работает */
    busyStories(): string[] {
      return [...agents.values()].filter((a) => a.busy).map((a) => a.story);
    },
    stopAll(): void {
      for (const a of agents.values()) if (!a.dead) a.proc?.kill();
    },
  };
}

export type AgentHub = ReturnType<typeof createAgentHub>;
