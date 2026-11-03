import { createServer } from "node:http";

// Ein Server wie das Haupt-Repo, so weit das Programm ihn sieht: dieselben Routen, Statuscodes und `kind`.
// Echtes HTTP, damit fetch, Kopfzeilen und Strom wirklich laufen. Die Tests stellen `state` ein und lesen
// in `requests`, was angekommen ist.
export async function startStub(overrides = {}) {
  const state = {
    tokenSteps: [{ status: 200, body: { status: "approved", session: session("a1", "r1") } }],
    me: { email: "du@beispiel.ch", plan: "free", hasOwnKey: true, needsOwnKey: false, needsConsent: false },
    chat: [],
    validTokens: new Set(["a1", "a2"]),
    validRefresh: new Map([["r1", session("a2", "r2")]]),
    deviceInterval: 0,
    verificationUri: null,
    ...overrides,
  };
  const requests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (state.redirect) {
      res.writeHead(302, { location: state.redirect });
      res.end();
      return;
    }
    if (req.url === "/api/cli/device") {
      return send(200, {
        deviceCode: "device-code-geheim",
        userCode: "BCDF-GHJK",
        verificationUri: state.verificationUri ?? `http://${req.headers.host}/cli`,
        expiresIn: 600,
        interval: state.deviceInterval,
      });
    }
    if (req.url === "/api/cli/token") {
      const step = state.tokenSteps.length > 1 ? state.tokenSteps.shift() : state.tokenSteps[0];
      return send(step.status, step.body);
    }
    if (req.url === "/api/cli/refresh") {
      const next = state.validRefresh.get(body.refreshToken);
      if (state.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
      if (state.refreshDown) return send(503, { kind: "unavailable", detail: "down" });
      if (!next) return send(401, { kind: "invalid_token", detail: "bad refresh" });
      state.validRefresh.delete(body.refreshToken);
      state.validTokens.add(next.access_token);
      return send(200, { session: next });
    }
    if (req.url === "/api/cli/logout") {
      if (state.logoutDown) return send(503, { kind: "unavailable", detail: "down" });
      if (!state.validTokens.has(token)) return send(401, { kind: "unauthorized", detail: "no" });
      state.validTokens.delete(token);
      return send(200, { ok: true });
    }
    if (req.url === "/api/cli/me") {
      if (state.meStatus) return send(state.meStatus, { detail: "nope" });
      if (!state.validTokens.has(token)) return send(401, { kind: "unauthorized", detail: "no" });
      return send(200, state.me);
    }
    if (req.url === "/api/chat") {
      if (!state.validTokens.has(token)) return send(401, { detail: "Bitte anmelden." });
      const turn = state.chat.shift();
      if (!turn) return send(500, { detail: "kein Zug vorbereitet" });
      if (turn.status) return send(turn.status, turn.body ?? {});
      res.writeHead(200, { "content-type": "text/event-stream", "x-ai-generated": "true" });
      for (const part of turn.raw ?? []) {
        res.write(part);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (turn.hang) return;
      res.end();
      return;
    }
    send(404, { detail: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export function session(access, refresh, expiresInSeconds = 3600) {
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    expires_in: expiresInSeconds,
  };
}

export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Ein vollständiger Zug: meta, Text als Stücke, done. */
export function turn(chunks, { conversationId = "c0000000-0000-4000-8000-000000000001" } = {}) {
  return {
    raw: [
      sse("meta", { conversationId, userMessageId: "u1" }),
      ...chunks.map((text) => sse("delta", { text })),
      sse("done", { mode: "generated", conversationId, assistantMessageId: "a1" }),
    ],
  };
}
