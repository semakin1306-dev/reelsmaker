import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { autoDecide, createAgentHub, toolSummary } from "./agent.ts";
import { editorPrompt } from "./editor-prompt.ts";

const DIR = "C:/ReelsMaker/inbox/кофе";
const CLI = "C:/reels-factory/apps/hub/cli/rm.mjs";
const bash = (command: string) => ({ tool_name: "Bash", input: { command } });

test("разрешения: чтение везде, правка только в папке сюжета, Bash — только rm и чтение", () => {
  assert.equal(autoDecide({ tool_name: "Read", input: { file_path: "C:/что угодно.jpg" } }, DIR, CLI), "allow");
  assert.equal(autoDecide({ tool_name: "Write", input: { file_path: DIR + "/edit.json" } }, DIR, CLI), "allow");
  assert.equal(autoDecide({ tool_name: "Edit", input: { file_path: "C:/ReelsMaker/inbox/кофе2/edit.json" } }, DIR, CLI), null, "соседний сюжет с похожим именем");
  assert.equal(autoDecide({ tool_name: "Write", input: { file_path: "C:/reels-factory/apps/hub/src/x.ts" } }, DIR, CLI), null);
  assert.equal(autoDecide(bash(`node "${CLI}" brief`), DIR, CLI), "allow");
  assert.equal(autoDecide(bash(`cd /tmp && node C:\\reels-factory\\apps\\hub\\cli\\rm.mjs frames wide 1 2`), DIR, CLI), "allow");
  assert.equal(autoDecide(bash("ls -la && cat edit.json"), DIR, CLI), "allow");
  assert.equal(autoDecide(bash(`node "${CLI}" brief | sh`), DIR, CLI), null, "конвейер в оболочку");
  assert.equal(autoDecide(bash("rm -rf C:/ReelsMaker"), DIR, CLI), null);
  assert.equal(autoDecide(bash("node other.mjs"), DIR, CLI), null);
  assert.equal(autoDecide(bash("echo x > C:/a.txt"), DIR, CLI), null, "перенаправление в файл");
  assert.equal(autoDecide({ tool_name: "WebFetch", input: {} }, DIR, CLI), null);
});

test("подсказка монтажёра: сюжет, команда rm с путём, формат листа и требование разных вариантов", () => {
  const p = editorPrompt("кофе", "C:\\ReelsMaker\\inbox\\кофе", "C:\\reels-factory\\apps\\hub\\cli\\rm.mjs");
  assert.match(p, /Сюжет «кофе»/);
  assert.match(p, /node "C:\/reels-factory\/apps\/hub\/cli\/rm\.mjs" brief/);
  assert.match(p, /edit\.json/);
  assert.match(p, /ОБЯЗАНЫ различаться/);
  assert.deepEqual(toolSummary("Bash", { command: "node x", description: "кадры" }), { line: "node x", desc: "кадры" });
});

/** Подменный claude: пишет в stdout то, что скажет тест, и запоминает stdin. */
function fakeClaude() {
  const sent: any[] = [];
  let proc: any;
  let spawnArgs: { args: string[]; cwd: string; env: Record<string, string> } | null = null;
  const spawnProc = (args: string[], cwd: string, env: Record<string, string>) => {
    spawnArgs = { args, cwd, env };
    const stdin = new PassThrough();
    stdin.on("data", (d) => {
      for (const line of String(d).split("\n").filter(Boolean)) sent.push(JSON.parse(line));
    });
    proc = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => proc.emit("close", 0) });
    return proc as ChildProcessWithoutNullStreams;
  };
  const say = (obj: unknown) => proc.stdout.write(JSON.stringify(obj) + "\n");
  return { sent, spawnProc, say, get spawn() { return spawnArgs; } };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

test("агент: запуск Claude Code, прокси из настроек, ход, инструмент, вопрос разрешения, сессия сохраняется", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-agent-"));
  try {
    const f = fakeClaude();
    const hub = createAgentHub({ cliPath: CLI, hubUrl: "http://127.0.0.1:8787", systemPrompt: () => "ПОДСКАЗКА", spawnProc: f.spawnProc, proxy: "http://127.0.0.1:3128", proxyCheck: async () => true });
    await hub.send("кофе", dir, "собери 3 варианта");
    const sp = f.spawn!;
    assert.equal(sp.cwd, dir);
    for (const a of ["--input-format", "stream-json", "--permission-prompt-tool=stdio", "--strict-mcp-config", "--append-system-prompt", "ПОДСКАЗКА", "claude-sonnet-5-5"]) assert.ok(sp.args.includes(a), a);
    assert.equal(sp.env["HTTPS_PROXY"], "http://127.0.0.1:3128", "прокси из настроек");
    assert.equal(sp.env["RM_STORY"], "кофе");
    assert.equal(f.sent[0].request.subtype, "initialize");
    assert.deepEqual(f.sent[1].message, { role: "user", content: "собери 3 варианта" });

    f.say({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-5-5" });
    f.say({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Смотрю исходники" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: `node "${CLI}" brief` } }] } });
    f.say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Реплики (10)" }] } });
    f.say({ type: "control_request", request_id: "q1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `node "${CLI}" frames wide 3` } } });
    f.say({ type: "control_request", request_id: "q2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push" } } });
    await tick();
    const auto = f.sent.find((m) => m.type === "control_response" && m.response.request_id === "q1");
    assert.equal(auto.response.response.behavior, "allow", "команда rm — без вопроса");
    let v = await hub.view("кофе");
    assert.equal(v.busy, true);
    assert.ok(v.busySince && Date.now() - v.busySince < 5000, "время начала хода — для таймера");
    assert.deepEqual(hub.busyStories(), ["кофе"]);
    assert.equal(v.sessionId, "sess-1");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".rm", "agent.json"), "utf8")), { sessionId: "sess-1", model: "claude-sonnet-5-5" });
    const tool = v.items.find((i) => i.id === "t1")!;
    assert.equal(tool.status, "ok");
    assert.equal(tool.result, "Реплики (10)");
    const perm = v.items.find((i) => i.t === "perm")!;
    assert.equal(perm.reqId, "q2");
    assert.equal(perm.status, "wait");

    hub.decide("кофе", "q2", false);
    await tick();
    const deny = f.sent.find((m) => m.type === "control_response" && m.response.request_id === "q2");
    assert.equal(deny.response.response.behavior, "deny");
    assert.throws(() => hub.decide("кофе", "q2", true), /нет такого запроса/);

    f.say({ type: "result", subtype: "success", duration_ms: 4200 });
    await tick();
    v = await hub.view("кофе", v.rev);
    assert.equal((await hub.view("кофе")).busy, false);
    assert.deepEqual(hub.busyStories(), []);
    assert.ok(v.items.some((i) => i.t === "result" && i.ok), "итог хода");
    assert.ok(v.items.some((i) => i.id === "perm-q2" && i.status === "denied"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("агент: следующий запуск продолжает сохранённую сессию; прокси не отвечает — напрямую; «новая беседа» забывает сессию", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rf-agent-"));
  try {
    const f1 = fakeClaude();
    const hub1 = createAgentHub({ cliPath: CLI, hubUrl: "h", systemPrompt: () => "", spawnProc: f1.spawnProc, proxy: "http://127.0.0.1:3128", proxyCheck: async () => false });
    await hub1.send("кофе", dir, "привет", "claude-opus-5-5");
    assert.equal(f1.spawn!.env["HTTPS_PROXY"], undefined);
    assert.ok(f1.spawn!.args.includes("claude-opus-5-5"));
    f1.say({ type: "system", subtype: "init", session_id: "s-7", model: "claude-opus-5-5" });
    await tick();
    hub1.stopAll();

    const f2 = fakeClaude();
    const hub2 = createAgentHub({ cliPath: CLI, hubUrl: "h", systemPrompt: () => "", spawnProc: f2.spawnProc, proxy: "http://127.0.0.1:3128", proxyCheck: async () => false });
    await tick();
    const restored = await hub2.view("кофе", 0, dir);
    assert.equal(restored.alive, false);
    assert.equal(restored.sessionId, "s-7");
    assert.ok(restored.items.some((i) => i.t === "user" && i.text === "привет"), "история окна пережила перезапуск");
    await hub2.send("кофе", dir, "продолжим");
    assert.ok(f2.spawn!.args.includes("--resume=s-7"));
    assert.ok(f2.spawn!.args.includes("claude-opus-5-5"), "модель прошлой сессии");

    await hub2.reset("кофе", dir);
    const f3 = fakeClaude();
    const hub3 = createAgentHub({ cliPath: CLI, hubUrl: "h", systemPrompt: () => "", spawnProc: f3.spawnProc, proxy: "http://127.0.0.1:3128", proxyCheck: async () => false });
    await hub3.send("кофе", dir, "заново");
    assert.ok(!f3.spawn!.args.some((a) => a.startsWith("--resume")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
