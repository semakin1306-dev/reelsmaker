import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeError, createClaudeClient, DEFAULT_CLAUDE_MODEL } from "./claude.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
}

function fakeFetch(responses: (Response | Error)[], calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("лишний запрос");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const okBody = (text: string) => ({ content: [{ type: "text", text }] });
const noSleep = async () => {};

test("запрос к Messages API: адрес, заголовки, тело; ответ — склеенный текст", async () => {
  const calls: Call[] = [];
  const client = createClaudeClient({
    apiKey: "test-key",
    fetch: fakeFetch([json(200, { content: [{ type: "text", text: "раз " }, { type: "tool_use" }, { type: "text", text: "два" }] })], calls),
  });
  const text = await client.complete({ system: "S", prompt: "P", maxTokens: 321 });
  assert.equal(text, "раз два");
  assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0]?.headers["x-api-key"], "test-key");
  assert.equal(calls[0]?.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(calls[0]?.body, { model: DEFAULT_CLAUDE_MODEL, max_tokens: 321, system: "S", messages: [{ role: "user", content: "P" }] });
});

test("модель и адрес настраиваются", async () => {
  const calls: Call[] = [];
  const client = createClaudeClient({ apiKey: "k", model: "claude-haiku-5-5", baseUrl: "http://proxy.local/", fetch: fakeFetch([json(200, okBody("ok"))], calls) });
  await client.complete({ system: "s", prompt: "p" });
  assert.equal(calls[0]?.url, "http://proxy.local/v1/messages");
  assert.equal(calls[0]?.body.model, "claude-haiku-5-5");
});

test("429 и 5xx повторяются, retry-after учитывается, затем успех", async () => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const client = createClaudeClient({
    apiKey: "k",
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: fakeFetch([json(429, { error: { message: "slow" } }, { "retry-after": "2" }), json(529, {}), json(200, okBody("готово"))], calls),
  });
  assert.equal(await client.complete({ system: "s", prompt: "p" }), "готово");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]);
});

test("сетевая ошибка повторяется; после лимита повторов — ClaudeError", async () => {
  const client = createClaudeClient({
    apiKey: "k",
    maxRetries: 1,
    sleep: noSleep,
    fetch: fakeFetch([new Error("ECONNRESET"), new Error("ECONNRESET")]),
  });
  await assert.rejects(client.complete({ system: "s", prompt: "p" }), (e: unknown) => e instanceof ClaudeError && e.status === null && /ECONNRESET/.test(e.message));
});

test("400/401 не повторяются, в ошибке сообщение API и без ключа", async () => {
  const calls: Call[] = [];
  const client = createClaudeClient({ apiKey: "secret-key-123", sleep: noSleep, fetch: fakeFetch([json(401, { error: { message: "invalid x-api-key" } })], calls) });
  await assert.rejects(client.complete({ system: "s", prompt: "p" }), (e: unknown) => {
    return e instanceof ClaudeError && e.status === 401 && /invalid x-api-key/.test(e.message) && !e.message.includes("secret-key-123");
  });
  assert.equal(calls.length, 1);
});

test("пустой ответ — ошибка; пустой ключ — ошибка создания", async () => {
  const client = createClaudeClient({ apiKey: "k", fetch: fakeFetch([json(200, { content: [] })]) });
  await assert.rejects(client.complete({ system: "s", prompt: "p" }), /пустой ответ/);
  assert.throws(() => createClaudeClient({ apiKey: "  " }), /apiKey/);
});
