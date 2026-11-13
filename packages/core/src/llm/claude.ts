// Клиент Claude (Messages API) для planner: хуки, подписи, порядок сцен по смыслу расшифровки.
// Без ключа клиент не создаётся — planner работает на правилах (Р9 эпика). Ключ — только из .env, в git его нет.
// Сеть: из России запросы могут не проходить — передайте свой `fetch` с прокси (например undici ProxyAgent).

export interface ClaudeRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface ClaudeClient {
  complete(req: ClaudeRequest): Promise<string>;
}

export interface ClaudeOptions {
  apiKey: string;
  /** по умолчанию claude-sonnet-5-5; из настройки RF_LLM_MODEL */
  model?: string;
  baseUrl?: string;
  /** подмена fetch: прокси в проде, фейк в тестах */
  fetch?: typeof fetch;
  /** повторов при 429/5xx/сетевой ошибке (по умолчанию 3) */
  maxRetries?: number;
  /** пауза между повторами; в тестах — мгновенная */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class ClaudeError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
  }
}

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra, 30) * 1000;
  return Math.min(500 * 2 ** attempt, 8000);
}

export function createClaudeClient(opts: ClaudeOptions): ClaudeClient {
  if (!opts.apiKey || !opts.apiKey.trim()) throw new Error("createClaudeClient: не задан apiKey");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const maxRetries = opts.maxRetries ?? 3;
  const model = opts.model || DEFAULT_CLAUDE_MODEL;

  return {
    async complete(req) {
      const body = JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1500,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      });
      let lastError: ClaudeError | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let res: Response;
        try {
          res = await doFetch(`${base}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": opts.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
          });
        } catch (e) {
          lastError = new ClaudeError(`сеть: ${(e as Error).message}`, null);
          if (attempt < maxRetries) {
            await sleep(backoffMs(attempt, null));
            continue;
          }
          throw lastError;
        }
        if (res.ok) {
          const json = (await res.json()) as { content?: { type: string; text?: string }[] };
          const text = (json.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("");
          if (!text) throw new ClaudeError("пустой ответ модели", res.status);
          return text;
        }
        let detail = "";
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          detail = j.error?.message ?? "";
        } catch {
          detail = "";
        }
        lastError = new ClaudeError(`Claude API ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
        if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(backoffMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        throw lastError;
      }
      throw lastError ?? new ClaudeError("неизвестная ошибка", null);
    },
  };
}
