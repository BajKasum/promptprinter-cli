import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { createApi } from "../src/api.mjs";
import { createMcpServer, LEGACY_VERSIONS, MODERN_VERSIONS } from "../src/mcp.mjs";
import { translator } from "../src/messages.mjs";
import { createAuth, createSessionStore } from "../src/session.mjs";
import { session, sse, startStub, turn } from "./support/stub-server.mjs";

const BIN = fileURLToPath(new URL("../bin/promptprinter.mjs", import.meta.url));
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0],
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};
const ID = "11111111-2222-4333-8444-555555555555";

let stub;
let dir;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pp-mcp-"));
  stub = await startStub();
});
afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function server({ signedIn = true } = {}) {
  const store = createSessionStore({ dir, server: stub.url });
  if (signedIn) await store.save(session("a1", "r1"));
  const api = createApi({ server: stub.url, version: "0", lang: "de" });
  const logs = [];
  const mcp = createMcpServer({ api, auth: createAuth({ store, api }), t: translator("de"), version: "9.9.9", log: (l) => logs.push(l) });
  let next = 1;
  const legacy = async () => mcp.handle({ jsonrpc: "2.0", id: next++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const call = (name, args, meta) =>
    mcp.handle({ jsonrpc: "2.0", id: next++, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } });
  return { mcp, legacy, call, logs };
}

const chats = () => stub.requests.filter((r) => r.url === "/api/chat");

test("MCP älterer Art: initialize, initialized, ping, tools/list", async () => {
  const { mcp } = await server();
  const init = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, "promptprinter");
  assert.equal(init.result.resultType, undefined);
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await mcp.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).result, {});
  const list = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["create_prompt", "list_saved_prompts", "get_saved_prompt"]);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object");

  // Eine Version, die der Server nicht kennt: er antwortet mit seiner neuesten älteren.
  const other = await mcp.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(other.result.protocolVersion, LEGACY_VERSIONS[0]);
});

test("MCP neuer Art (2026-07-28): server/discover, _meta je Anfrage, resultType, falsche Version", async () => {
  const { mcp } = await server();
  const discover = await mcp.handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: MODERN_META } });
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, [...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
  assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].version, "9.9.9");

  const list = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_META } });
  assert.equal(list.result.resultType, "complete");
  assert.equal(list.result.tools.length, 3);

  const old = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { ...MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } });
  assert.equal(old.error.code, -32022);
  assert.equal(old.error.data.requested, "1900-01-01");

  const bare = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(bare.error.code, -32602, "ohne initialize und ohne _meta");
  const noCaps = await mcp.handle({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0] } } });
  assert.equal(noCaps.error.code, -32602);

  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 5, method: "gibts/nicht", params: { _meta: MODERN_META } })).error.code, -32601);
  assert.equal((await mcp.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rm", _meta: MODERN_META } })).error.code, -32602);
  assert.equal((await mcp.handle([{ jsonrpc: "2.0", id: 7, method: "ping" }])).error.code, -32600);
  assert.equal((await mcp.handle({ id: 8, method: "ping" })).error.code, -32600);
});

test("create_prompt: Rückfrage mit conversation_id, Antwort darauf mit Verlauf, dann der fertige Prompt", async () => {
  const conversationId = "c0000000-0000-4000-8000-000000000009";
  stub.state.chat.push(turn(["Wer liest die Seite?"], { conversationId }));
  stub.state.chat.push(turn(["Hier:\n\n```text\nSchreib eine Landingpage.\n```\n"], { conversationId }));
  const { legacy, call } = await server();
  await legacy();

  const first = await call("create_prompt", { idea: "Landingpage Coiffeur" });
  assert.equal(first.result.isError, false);
  assert.equal(first.result.structuredContent.status, "question");
  assert.equal(first.result.structuredContent.conversation_id, conversationId);
  assert.match(first.result.content[0].text, /Wer liest die Seite\?/);

  const second = await call("create_prompt", { idea: "Leute aus dem Quartier", conversation_id: conversationId });
  assert.equal(second.result.structuredContent.status, "prompt");
  assert.equal(second.result.structuredContent.prompt, "Schreib eine Landingpage.");
  assert.match(second.result.content[0].text, /^Schreib eine Landingpage\./);

  const [, again] = chats();
  assert.equal(again.body.conversationId, conversationId);
  assert.deepEqual(again.body.messages.map((m) => m.content), ["Landingpage Coiffeur", "Wer liest die Seite?", "Leute aus dem Quartier"]);

  const unknown = await call("create_prompt", { idea: "x", conversation_id: "gibt-es-nicht" });
  assert.equal(unknown.result.isError, true);
  assert.equal(chats().length, 2);
});

test("Werkzeuge ohne Anmeldung: klarer Werkzeugfehler, keine Anfrage, keine Anmeldung im MCP-Modus", async () => {
  const { legacy, call } = await server({ signedIn: false });
  await legacy();
  for (const [name, args] of [["create_prompt", { idea: "x" }], ["list_saved_prompts", {}], ["get_saved_prompt", { id: ID }]]) {
    const res = await call(name, args);
    assert.equal(res.result.isError, true, name);
    assert.match(res.result.content[0].text, /Starte einmal `promptprinter`/, name);
  }
  assert.equal(stub.requests.length, 0);
});

test("Fehler des Servers werden verständliche Werkzeugfehler: Key, Zustimmung, Kontingent, 429, Sitzung weg", async () => {
  const { legacy, call } = await server();
  await legacy();
  const cases = [
    [{ status: 403, body: { kind: "byokRequired", detail: "x" } }, /eigenen KI-Key/],
    [{ status: 403, body: { kind: "consentRequired", detail: "x" } }, /stimme bitte im Browser zu/],
    [{ status: 429, body: { kind: "chatMessages", limit: 30, detail: "x" } }, /Kontingent.*30 Antworten/],
    [{ status: 429, body: { kind: "rate_limited", retryAfter: 12, detail: "x" } }, /in 12 Sekunden/],
  ];
  for (const [step, pattern] of cases) {
    stub.state.chat.push(step);
    const res = await call("create_prompt", { idea: "x" });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, pattern);
  }
  stub.state.validTokens.clear();
  stub.state.validRefresh.clear();
  const gone = await call("create_prompt", { idea: "x" });
  assert.match(gone.result.content[0].text, /Starte einmal `promptprinter`/);
});

test("list_saved_prompts und get_saved_prompt: Suche, Grenze, fremde id, Steuerzeichen", async () => {
  stub.state.prompts = [
    { id: ID, title: "Coiffeur \u001b[31mrot", createdAt: "2026-11-07T10:00:00Z", content: "Schreib eine Landingpage." },
    { id: "22222222-2222-4333-8444-555555555555", title: "Newsletter", createdAt: "2026-11-01T10:00:00Z", content: "Schreib einen Newsletter." },
  ];
  const { legacy, call } = await server();
  await legacy();

  const all = await call("list_saved_prompts", {});
  assert.equal(all.result.structuredContent.prompts.length, 2);
  assert.doesNotMatch(all.result.content[0].text, /\u001b/);
  const found = await call("list_saved_prompts", { query: "newsletter", limit: 5 });
  assert.deepEqual(found.result.structuredContent.prompts.map((p) => p.title), ["Newsletter"]);
  const listed = stub.requests.filter((r) => r.url.startsWith("/api/cli/prompts?"));
  assert.equal(new URL(listed[1].url, "http://x").searchParams.get("q"), "newsletter");
  assert.equal(new URL(listed[1].url, "http://x").searchParams.get("limit"), "5");
  assert.equal(listed[1].headers.authorization, "Bearer a1");

  assert.equal((await call("list_saved_prompts", { limit: 0 })).result.isError, true);
  assert.equal((await call("list_saved_prompts", { query: "x".repeat(201) })).result.isError, true);

  const one = await call("get_saved_prompt", { id: ID });
  assert.equal(one.result.content[0].text, "Schreib eine Landingpage.");
  const missing = await call("get_saved_prompt", { id: "33333333-2222-4333-8444-555555555555" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /gibt es nicht/);

  const before = stub.requests.length;
  const bad = await call("get_saved_prompt", { id: "../me" });
  assert.equal(bad.result.isError, true);
  assert.equal(stub.requests.length, before, "eine ungültige id geht nicht an den Server");
});

test("promptprinter mcp als Prozess: stdout nur JSON-RPC, eine Nachricht je Zeile, Ende mit der Eingabe", async () => {
  stub.state.chat.push(turn(["Eine Frage?"]));
  await createSessionStore({ dir, server: stub.url }).save(session("a1", "r1"));
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_prompt", arguments: { idea: "Zeile eins\nZeile zwei" } } },
  ];
  const { code, out, err } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mcp"], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PROMPTPRINTER_URL: stub.url, PROMPTPRINTER_CONFIG_DIR: dir, PROMPTPRINTER_LANG: "de" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (exit) => resolve({ code: exit, out: stdout, err: stderr }));
    child.stdin.end(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n{kaputt\n`);
  });
  assert.equal(code, 0, err);
  const replies = out.trimEnd().split("\n").map((line) => JSON.parse(line));
  const byId = new Map(replies.map((r) => [r.id, r]));
  assert.equal(byId.get(1).result.protocolVersion, "2025-11-25");
  assert.equal(byId.get(2).result.tools.length, 3);
  assert.equal(byId.get(3).result.structuredContent.status, "question");
  assert.equal(byId.get(null).error.code, -32700);
  assert.equal(replies.length, 4);
  assert.doesNotMatch(out, /PROMPT|PromptPrinter \d/, "kein Startbild auf stdout");
});

test("ein abgebrochener Aufruf bekommt keine Antwort mehr", async () => {
  stub.state.chat.push({ raw: [sse("delta", { text: "halb" })], hang: true });
  const { mcp, legacy } = await server();
  await legacy();
  const pending = mcp.handle({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "create_prompt", arguments: { idea: "x" } } });
  for (let i = 0; i < 200 && chats().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } }), null);
  assert.equal(await pending, null);
});
