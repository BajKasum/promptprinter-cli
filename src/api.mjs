import { sanitize } from "./text.mjs";

/** Eine Absage des Servers, in der Form von `problem()` im Haupt-Repo (`kind`, `detail`, `retryAfter`). */
export class ApiError extends Error {
  constructor(status, body = {}) {
    super(typeof body.detail === "string" ? sanitize(body.detail) : `HTTP ${status}`);
    this.status = status;
    this.kind = typeof body.kind === "string" ? body.kind : null;
    this.retryAfter = typeof body.retryAfter === "number" ? body.retryAfter : null;
    this.interval = typeof body.interval === "number" ? body.interval : null;
    this.limit = typeof body.limit === "number" ? body.limit : null;
  }
}

/** Der Server war nicht erreichbar oder hat nicht geantwortet. Sagt nichts über das Konto. */
export class NetworkError extends Error {}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Der Zugang zum Server, eine Methode je Route. `redirect: "error"`: dieses Programm schickt ein Token im
 * Kopf und folgt deshalb keiner Umleitung, wohin auch immer sie führt.
 */
export function createApi({ server, version, lang, fetch: doFetch = globalThis.fetch }) {
  const baseHeaders = {
    "user-agent": `promptprinter-cli/${version}`,
    // Die Sprache der Fehlertexte: der Server liest nur dieses Cookie, es meldet niemanden an.
    cookie: `pp-locale=${lang}`,
  };

  async function send(method, path, { token, body, signal } = {}) {
    const headers = { ...baseHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await doFetch(`${server}${path}`, {
        method,
        headers,
        redirect: "error",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === "AbortError" && signal?.aborted && !isTimeout(signal)) throw err;
      throw new NetworkError(err?.message ?? "fetch failed", { cause: err });
    }
  }

  async function json(method, path, options = {}) {
    const res = await send(method, path, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body ?? {});
    return body;
  }

  return {
    server,
    requestDevice: (clientName) => json("POST", "/api/cli/device", { body: { clientName } }),
    pollToken: (deviceCode) => json("POST", "/api/cli/token", { body: { deviceCode } }),
    refresh: (refreshToken) => json("POST", "/api/cli/refresh", { body: { refreshToken } }),
    logout: (token) => json("POST", "/api/cli/logout", { token }),
    me: (token) => json("GET", "/api/cli/me", { token }),
    /** Gespeicherte Prompts, neueste zuerst (für den MCP-Server). */
    savedPrompts: (token, { query = "", limit = 20 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (query) params.set("q", query);
      return json("GET", `/api/cli/prompts?${params}`, { token });
    },
    savedPrompt: (token, id) => json("GET", `/api/cli/prompts/${encodeURIComponent(id)}`, { token }),
    /** Gibt die Antwort mit offenem Strom zurück. Eine Absage wirft, bevor ein Wort gelesen wird. */
    async chat(token, body, signal) {
      const res = await send("POST", "/api/chat", { token, body, signal });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
      return res;
    },
  };
}

function isTimeout(signal) {
  return signal.reason?.name === "TimeoutError";
}
