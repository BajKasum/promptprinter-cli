import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { describeAccount, fetchAccount, signOut } from "../src/account.mjs";
import { ApiError, createApi, NetworkError } from "../src/api.mjs";
import { createConversation, MAX_USER_MESSAGE_CHARS, runTurn } from "../src/chat.mjs";
import { describeError } from "../src/errors.mjs";
import { runLogin } from "../src/login.mjs";
import { translator } from "../src/messages.mjs";
import { createAuth, createSessionStore, NotLoggedInError, SessionBusyError } from "../src/session.mjs";
import { copyToClipboard, openBrowser, savePrompt } from "../src/system.mjs";
import { session, sse, startStub, turn } from "./support/stub-server.mjs";

const t = translator("de");
let stub;
let dir;
let store;
let api;
let auth;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pp-client-"));
  stub = await startStub();
  store = createSessionStore({ dir, server: stub.url });
  api = createApi({ server: stub.url, version: "9.9.9", lang: "de" });
  auth = createAuth({ store, api });
});
afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

const noWait = async () => {};
const silent = { step: () => {} };

test("api: schickt Programmname und Sprache, ein Token nur, wo es hingehört", async () => {
  await api.requestDevice("Laptop");
  const device = stub.requests.at(-1);
  assert.equal(device.headers["user-agent"], "promptprinter-cli/9.9.9");
  assert.equal(device.headers.cookie, "pp-locale=de");
  assert.equal(device.headers.authorization, undefined);
  await api.me("a1");
  assert.equal(stub.requests.at(-1).headers.authorization, "Bearer a1");
});

test("api: eine Absage wird zu ApiError mit kind, detail und Wartezeit, und der Text ist bereinigt", async () => {
  stub.state.chat.push({ status: 429, body: { kind: "rate_limited", retryAfter: 30, detail: "\u001b[31mlangsam" } });
  await assert.rejects(api.chat("a1", { messages: [] }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    assert.equal(err.kind, "rate_limited");
    assert.equal(err.retryAfter, 30);
    assert.equal(err.message, "langsam");
    return true;
  });
});

test("api: folgt keiner Umleitung, das Token geht nirgends sonst hin", async () => {
  const other = await startStub();
  stub.state.redirect = `${other.url}/api/cli/me`;
  await assert.rejects(api.me("a1"), NetworkError);
  assert.equal(other.requests.length, 0);
  await other.close();
});

test("api: ist der Server weg, kommt NetworkError ohne Einzelheiten nach aussen", async () => {
  await stub.close();
  await assert.rejects(api.requestDevice("x"), NetworkError);
  stub = await startStub();
});

test("login: wartet, holt die Sitzung ab, speichert sie und zeigt den Code ohne ihn in die Adresse zu schreiben", async () => {
  stub.state.tokenSteps = [
    { status: 200, body: { status: "pending", interval: 5 } },
    { status: 200, body: { status: "approved", session: session("a1", "r1") } },
  ];
  const printed = [];
  let opened;
  const result = await runLogin({
    api,
    store,
    wait: noWait,
    print: { step: (key, vars) => printed.push({ key, vars }) },
    open: (url) => (opened = url),
  });
  assert.equal(result, "done");
  assert.equal((await store.load()).refresh_token, "r1");
  assert.equal(printed.find((p) => p.key === "loginCode").vars.code, "BCDF-GHJK");
  assert.equal(opened, `${stub.url}/cli`);
  assert.equal(printed.some((p) => p.key === "loginWarning"), true);
  assert.equal(JSON.stringify(printed).includes("device-code-geheim"), false);
  assert.match(stub.requests[0].body.clientName, /promptprinter/);
  assert.deepEqual(stub.requests[1].body, { deviceCode: "device-code-geheim" });
});

test("login: öffnet nur Adressen des eigenen Servers", async () => {
  stub.state.verificationUri = "https://boese.example.com/cli";
  let opened;
  await runLogin({ api, store, wait: noWait, print: silent, open: (url) => (opened = url) });
  assert.equal(opened, `${stub.url}/cli`);
  await store.clear();
  stub.state.verificationUri = "kein url";
  await runLogin({ api, store, wait: noWait, print: silent, open: (url) => (opened = url) });
  assert.equal(opened, `${stub.url}/cli`);
});

for (const [body, status, expected] of [
  [{ kind: "denied", detail: "x" }, 403, "denied"],
  [{ kind: "expired", detail: "x" }, 410, "expired"],
  [{ kind: "invalid", detail: "x" }, 400, "invalid"],
  [{ kind: "session_failed", detail: "x" }, 503, "failed"],
]) {
  test(`login: ${body.kind} endet als ${expected}, ohne Sitzung`, async () => {
    stub.state.tokenSteps = [{ status, body }];
    assert.equal(await runLogin({ api, store, wait: noWait, print: silent }), expected);
    assert.equal(await store.load(), null);
  });
}

test("login: slow_down verlängert die Pause, und das Warten lässt sich abbrechen", async () => {
  stub.state.tokenSteps = [
    { status: 429, body: { kind: "slow_down", interval: 5 } },
    { status: 200, body: { status: "approved", session: session("a1", "r1") } },
  ];
  const waits = [];
  assert.equal(await runLogin({ api, store, print: silent, wait: async (ms) => waits.push(ms) }), "done");
  assert.ok(waits[1] > waits[0], `${waits}`);

  await store.clear();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runLogin({ api, store, print: silent, signal: controller.signal });
  assert.equal(cancelled, "cancelled");
});

test("login: ein Netzfehler beim Abfragen beendet die Anmeldung nicht", async () => {
  let calls = 0;
  const flaky = {
    ...api,
    pollToken: async () => {
      calls++;
      if (calls === 1) throw new NetworkError("weg");
      return { status: "approved", session: session("a1", "r1") };
    },
  };
  assert.equal(await runLogin({ api: flaky, store, wait: noWait, print: silent }), "done");
});

test("login: läuft die Zeit ab, ist es expired", async () => {
  stub.state.tokenSteps = [{ status: 200, body: { status: "pending", interval: 5 } }];
  let clock = 0;
  const result = await runLogin({ api, store, wait: noWait, print: silent, now: () => (clock += 400_000) });
  assert.equal(result, "expired");
});

async function chatTurn(text, { conversation = createConversation(), signal } = {}) {
  await store.save(session("a1", "r1"));
  let shown = "";
  const statuses = [];
  const result = await runTurn({
    auth,
    api,
    conversation,
    text,
    signal,
    onDelta: (chunk) => (shown += chunk),
    onStatus: (status) => statuses.push(status),
  });
  return { result, shown, statuses, conversation };
}

test("chat: ein Zug liefert Text und merkt sich Verlauf und Gespräch", async () => {
  stub.state.chat.push(turn(["Hallo ", "Welt"]));
  const { result, shown, conversation } = await chatTurn("Hi");
  assert.equal(result.kind, "done");
  assert.equal(result.text, "Hallo Welt");
  assert.equal(shown, "Hallo Welt");
  assert.equal(stub.requests.at(-1).headers.authorization, "Bearer a1");
  assert.deepEqual(stub.requests.at(-1).body, { messages: [{ role: "user", content: "Hi" }] });

  stub.state.chat.push(turn(["Zweite"]));
  await runTurn({ auth, api, conversation, text: "Nochmal" });
  const second = stub.requests.at(-1).body;
  assert.equal(second.conversationId, "c0000000-0000-4000-8000-000000000001");
  assert.deepEqual(second.messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hallo Welt" },
    { role: "user", content: "Nochmal" },
  ]);
});

test("chat: Steuerfolgen aus dem Modell erreichen weder Anzeige noch Verlauf", async () => {
  stub.state.chat.push(turn(["sauber\u001b]52;c;Z2VoZWlt\u0007", "\u001b[2J Text"]));
  const { result, shown, conversation } = await chatTurn("Hi");
  assert.equal(shown.includes("\u001b"), false);
  assert.equal(result.text.includes("\u001b"), false);
  assert.equal(JSON.stringify(conversation.request("x")).includes("\\u001b"), false);
});

test("chat: status und unbekannte Ereignisse stören nicht", async () => {
  stub.state.chat.push({
    raw: [
      sse("status", { phase: "retrying", attempt: 2, maxAttempts: 3 }),
      sse("zukunft", { neu: true }),
      sse("delta", { text: "ok" }),
      sse("done", { mode: "generated", conversationId: "c1" }),
    ],
  });
  const { result, statuses } = await chatTurn("Hi");
  assert.equal(result.kind, "done");
  assert.equal(statuses[0].attempt, 2);
});

test("chat: ein error-Ereignis, ein kaputtes Ereignis, ein abgerissener Strom", async () => {
  stub.state.chat.push({ raw: [sse("delta", { text: "halb" }), sse("error", { detail: "Modell \u001b[1mweg" })] });
  const failed = await chatTurn("a");
  assert.deepEqual([failed.result.kind, failed.result.detail], ["error", "Modell weg"]);
  assert.equal(failed.conversation.request("x").messages.length, 1, "ein gescheiterter Zug bleibt nicht im Verlauf");

  stub.state.chat.push({ raw: ["event: delta\ndata: {kaputt\n\n"] });
  assert.equal((await chatTurn("b")).result.kind, "protocol");

  stub.state.chat.push({ raw: [sse("delta", { text: "halb" })] });
  const dropped = await chatTurn("c");
  assert.deepEqual([dropped.result.kind, dropped.result.text], ["dropped", "halb"]);
});

test("chat: Abbrechen stoppt den Strom", async () => {
  stub.state.chat.push({ raw: [sse("delta", { text: "halb" })], hang: true });
  const controller = new AbortController();
  await store.save(session("a1", "r1"));
  const running = runTurn({
    auth,
    api,
    conversation: createConversation(),
    text: "x",
    signal: controller.signal,
    onDelta: () => controller.abort(),
  });
  assert.equal((await running).kind, "stopped");
});

test("chat: eine Absage vor dem Strom wirft, ein abgelaufenes Token wird erneuert", async () => {
  await store.save(session("a1", "r1"));
  stub.state.chat.push({ status: 403, body: { kind: "byokRequired", plan: "free", detail: "Key" } });
  await assert.rejects(
    runTurn({ auth, api, conversation: createConversation(), text: "x" }),
    (err) => err.kind === "byokRequired"
  );

  stub.state.validTokens.delete("a1");
  stub.state.chat.push(turn(["nach Erneuerung"]));
  const result = await runTurn({ auth, api, conversation: createConversation(), text: "x" });
  assert.equal(result.text, "nach Erneuerung");
  assert.equal((await store.load()).refresh_token, "r2");
});

test("chat: der Verlauf bleibt unter der Grenze des Servers, die neueste Nachricht zuletzt", () => {
  const conversation = createConversation();
  for (let i = 0; i < 20; i++) conversation.commit(`frage ${i}`, `antwort ${i}`);
  const { messages } = conversation.request("neu");
  assert.equal(messages.length, 24);
  assert.deepEqual(messages.at(-1), { role: "user", content: "neu" });
  conversation.commit("leer", "   ");
  assert.equal(conversation.request("x").messages.at(-2).content, "leer", "eine leere Antwort geht nie zurück an den Server");
  conversation.reset();
  assert.equal(conversation.request("x").messages.length, 1);
  assert.equal(conversation.id, undefined);
  assert.equal(MAX_USER_MESSAGE_CHARS, 8000);
});

test("Konto: Zeile und Hinweise je Zustand, Text vom Server bereinigt", () => {
  const server = "https://promptprinter.app";
  const own = describeAccount({ email: "a@b.ch", plan: "free", hasOwnKey: true, needsOwnKey: false, needsConsent: false }, { t, server });
  assert.equal(own.line, "Angemeldet als a@b.ch, Free, eigener Key");
  assert.deepEqual(own.hints, []);

  const none = describeAccount({ email: "a\u001b[1m@b.ch", plan: "free", hasOwnKey: false, needsOwnKey: true, needsConsent: false }, { t, server });
  assert.equal(none.line, "Angemeldet als a@b.ch, Free, kein Key");
  assert.match(none.hints[0], /https:\/\/promptprinter\.app\/settings/);

  const pro = describeAccount({ email: "a@b.ch", plan: "pro", hasOwnKey: false, needsOwnKey: false, needsConsent: true }, { t, server });
  assert.equal(pro.line, "Angemeldet als a@b.ch, Pro, Server-Key");
  assert.match(pro.hints[0], /chats\/new/);
});

test("Konto: ein Server ohne die Route ist kein Fehler, andere Fehler gehen weiter", async () => {
  await store.save(session("a1", "r1"));
  assert.equal((await fetchAccount({ auth, api })).email, "du@beispiel.ch");
  stub.state.meStatus = 404;
  assert.equal(await fetchAccount({ auth, api }), null);
  stub.state.meStatus = 503;
  await assert.rejects(fetchAccount({ auth, api }), ApiError);
});

test("Abmelden: beendet die Sitzung auf dem Server und löscht die Datei", async () => {
  assert.equal(await signOut({ auth, api, store }), "none");
  await store.save(session("a1", "r1"));
  assert.equal(await signOut({ auth, api, store }), "out");
  assert.equal(stub.state.validTokens.has("a1"), false);
  assert.equal(await store.load(), null);
});

test("Abmelden: ohne Server geht die Datei trotzdem und das Ergebnis sagt es", async () => {
  await store.save(session("a1", "r1"));
  stub.state.logoutDown = true;
  assert.equal(await signOut({ auth, api, store }), "local");
  assert.equal(await store.load(), null);
});

test("Abmelden: eine schon tote Sitzung ist auch ein Abmelden", async () => {
  await store.save(session("tot", "r-tot"));
  assert.equal(await signOut({ auth, api, store }), "out");
  assert.equal(await store.load(), null);
});

test("Fehlertexte nennen den Weg weiter", () => {
  const server = "https://promptprinter.app";
  const say = (err) => describeError(err, { t, server });
  assert.match(say(new ApiError(403, { kind: "byokRequired" })), /promptprinter\.app\/settings/);
  assert.match(say(new ApiError(403, { kind: "consentRequired" })), /promptprinter\.app\/chats\/new/);
  assert.match(say(new ApiError(403, { kind: "chatMessages", limit: 400 })), /400/);
  assert.match(say(new ApiError(409, { kind: "byokUnreadable" })), /settings/);
  assert.match(say(new ApiError(429, { retryAfter: 30 })), /30 Sekunden/);
  assert.match(say(new ApiError(401, {})), /\/login/);
  assert.match(say(new NotLoggedInError()), /\/login/);
  assert.match(say(new SessionBusyError()), /Fenster/);
  assert.match(say(new NetworkError("ECONNREFUSED 10.0.0.1")), /nicht erreichbar/);
  assert.equal(say(new NetworkError("ECONNREFUSED 10.0.0.1")).includes("10.0.0.1"), false);
  assert.match(say(new ApiError(503, { detail: "Tagesbudget erreicht" })), /Tagesbudget/);
});

function fakeSpawn(behaviour) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      chunks.push(data);
      setImmediate(() => {
        const outcome = behaviour(command);
        if (outcome === "missing") child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        else child.emit("close", outcome);
      });
    };
    child.kill = () => {};
    child.unref = () => {};
    calls.push({ command, args, options, chunks });
    return child;
  };
  return { spawn, calls };
}

test("Zwischenablage: Windows bekommt UTF-16 mit BOM, nie über eine Shell", async () => {
  const { spawn, calls } = fakeSpawn(() => 0);
  assert.equal(await copyToClipboard("Grüße", { platform: "win32", env: {}, spawn }), true);
  assert.equal(calls[0].command, "clip");
  assert.equal(calls[0].options.shell, undefined);
  const data = calls[0].chunks[0];
  assert.deepEqual([data[0], data[1]], [0xff, 0xfe]);
  assert.equal(data.subarray(2).toString("utf16le"), "Grüße");
});

test("Zwischenablage: Linux probiert der Reihe nach, ohne Programm false", async () => {
  const works = fakeSpawn((command) => (command === "xsel" ? 0 : "missing"));
  assert.equal(await copyToClipboard("x", { platform: "linux", env: {}, spawn: works.spawn }), true);
  assert.deepEqual(works.calls.map((c) => c.command), ["xclip", "xsel"]);

  const wayland = fakeSpawn(() => 0);
  await copyToClipboard("x", { platform: "linux", env: { WAYLAND_DISPLAY: "w" }, spawn: wayland.spawn });
  assert.equal(wayland.calls[0].command, "wl-copy");

  const nothing = fakeSpawn(() => "missing");
  assert.equal(await copyToClipboard("x", { platform: "linux", env: {}, spawn: nothing.spawn }), false);
  assert.equal(nothing.calls.at(-1).command, "clip.exe");

  const mac = fakeSpawn(() => 0);
  await copyToClipboard("Grüße", { platform: "darwin", env: {}, spawn: mac.spawn });
  assert.equal(mac.calls[0].command, "pbcopy");
  assert.equal(mac.calls[0].chunks[0].toString("utf8"), "Grüße");
});

test("Speichern: mit KI-Kennzeichnung, nie überschreibend", async () => {
  const when = new Date("2026-11-02T09:05:00Z");
  const first = await savePrompt("Mein Prompt", { cwd: dir, now: when });
  assert.equal(first.kind, "saved");
  assert.match(first.path, /prompt-20261102-0905\.md$/);
  const content = readFileSync(first.path, "utf8");
  assert.ok(content.startsWith("<!-- ai-generated: true; generator: PromptPrinter (Finn) -->\n\n"));
  assert.ok(content.includes("Mein Prompt"));

  const second = await savePrompt("Anderer", { cwd: dir, now: when });
  assert.match(second.path, /prompt-20261102-0905-2\.md$/);
  assert.ok(readFileSync(first.path, "utf8").includes("Mein Prompt"));

  const named = await savePrompt("Benannt", { cwd: dir, name: "bewerbung" });
  assert.match(named.path, /bewerbung\.md$/);
  writeFileSync(join(dir, "vorhanden.txt"), "wichtig");
  const taken = await savePrompt("Neu", { cwd: dir, name: "vorhanden.txt" });
  assert.equal(taken.kind, "exists");
  assert.equal(readFileSync(join(dir, "vorhanden.txt"), "utf8"), "wichtig");
  const failed = await savePrompt("x", { cwd: dir, name: join("fehlt", "ordner", "a.md") });
  assert.equal(failed.kind, "failed");
});

test("Browser: nur http und https, jede Plattform mit ihrem Programm, ohne Shell", () => {
  const { spawn, calls } = fakeSpawn(() => 0);
  assert.equal(openBrowser("file:///etc/passwd", { platform: "linux", spawn }), false);
  assert.equal(openBrowser("javascript:alert(1)", { platform: "win32", spawn }), false);
  assert.equal(calls.length, 0);
  openBrowser("https://promptprinter.app/cli", { platform: "win32", spawn });
  openBrowser("https://promptprinter.app/cli", { platform: "darwin", spawn });
  openBrowser("https://promptprinter.app/cli", { platform: "linux", spawn });
  assert.deepEqual(calls.map((c) => c.command), ["rundll32", "open", "xdg-open"]);
  assert.equal(calls.every((c) => c.options.shell === undefined), true);
});
