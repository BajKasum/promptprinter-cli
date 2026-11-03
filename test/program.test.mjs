import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { createSessionStore } from "../src/session.mjs";
import { session, startStub, turn } from "./support/stub-server.mjs";

// Das echte Programm als eigener Prozess gegen den Stub, mit Eingabe über eine Pipe.
const BIN = fileURLToPath(new URL("../bin/promptprinter.mjs", import.meta.url));
let stub;
let dir;
let cwd;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pp-program-"));
  cwd = mkdtempSync(join(tmpdir(), "pp-cwd-"));
  stub = await startStub({ deviceInterval: 1 });
});
afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function run(args, lines = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        PROMPTPRINTER_URL: stub.url,
        PROMPTPRINTER_CONFIG_DIR: dir,
        PROMPTPRINTER_LANG: "de",
        PROMPTPRINTER_NO_BROWSER: "1",
        ...extraEnv,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(lines.length ? `${lines.join("\n")}\n` : "");
  });
}

const signIn = () => createSessionStore({ dir, server: stub.url }).save(session("a1", "r1"));

test("--version und --help antworten ohne Server und ohne Anmeldung", async () => {
  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.out.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /promptprinter \[Befehl\]/);
  assert.equal(stub.requests.length, 0);
});

test("ein unbekannter Befehl zeigt die Hilfe und endet mit 2", async () => {
  const result = await run(["gibtsnicht"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /Aufruf:/);
});

test("eine unsichere Server-Adresse wird abgelehnt, bevor etwas gesendet wird", async () => {
  await signIn();
  const result = await run(["whoami"], [], { PROMPTPRINTER_URL: "http://example.com" });
  assert.equal(result.code, 1);
  assert.match(result.out, /https/);
});

test("login, whoami, logout: der ganze Weg, ohne ein Token auszugeben", async () => {
  const login = await run(["login"]);
  assert.equal(login.code, 0, login.out);
  assert.match(login.out, /BCDF-GHJK/);
  assert.match(login.out, /\/cli/);
  assert.match(login.out, /Angemeldet\./);
  assert.equal(login.out.includes("device-code-geheim"), false);
  assert.equal(login.out.includes("a1"), false);
  assert.equal(login.out.includes("r1"), false);

  const again = await run(["login"]);
  assert.match(again.out, /schon angemeldet/);

  const who = await run(["whoami"]);
  assert.equal(who.code, 0);
  assert.match(who.out, /Angemeldet als du@beispiel\.ch, Free, eigener Key/);

  const logout = await run(["logout"]);
  assert.equal(logout.code, 0);
  assert.match(logout.out, /abgemeldet/);
  assert.equal(stub.state.validTokens.has("a1"), false);

  const gone = await run(["whoami"]);
  assert.equal(gone.code, 1);
  assert.match(gone.out, /nicht angemeldet/);
});

test("eine abgelehnte Anmeldung endet mit 1 und ohne Sitzung", async () => {
  stub.state.tokenSteps = [{ status: 403, body: { kind: "denied", detail: "no" } }];
  const result = await run(["login"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /abgelehnt/);
  assert.equal(readdirSync(dir).includes("session.json"), false);
});

test("aus einer Pipe ohne Anmeldung: klare Meldung statt Warten auf den Browser", async () => {
  const result = await run([], ["/pp Idee"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /promptprinter login/);
  assert.equal(stub.requests.length, 0);
});

test("Start aus einer Pipe zeigt nur Name und Version, keine Steuerfolgen", async () => {
  await signIn();
  const result = await run([], ["/exit"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /^PromptPrinter \d+\.\d+\.\d+\n/);
  assert.equal(result.out.includes("██"), false);
  assert.equal(result.out.includes("\u001b"), false);
  assert.match(result.out, /Finn ist eine KI/);
  assert.match(result.out, /Angemeldet als du@beispiel\.ch/);
});

test("/pp: Rückfrage, Antwort, gerahmter Prompt, /save speichert genau ihn", async () => {
  await signIn();
  stub.state.chat.push(turn(["Kurz: Wer liest es?"]));
  stub.state.chat.push(turn(["Hier ist dein Prompt.\n```text\nSchreib eine Landingpage.\n```"]));
  const result = await run([], ["/pp Landingpage für einen Coiffeur", "Leute aus dem Quartier", "/save coiffeur", "/exit"]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Finn: Kurz: Wer liest es\?/);
  assert.match(result.out, /┌─ Prompt|\+- Prompt/);
  assert.match(result.out, /(│|\|) Schreib eine Landingpage\./);
  assert.match(result.out, /\/copy kopieren/);
  assert.equal(result.out.includes("```"), false);

  const chats = stub.requests.filter((r) => r.url === "/api/chat");
  assert.equal(chats.length, 2);
  assert.equal(chats[0].body.conversationId, undefined);
  assert.equal(chats[1].body.conversationId, "c0000000-0000-4000-8000-000000000001");
  assert.equal(chats[1].body.messages.length, 3);

  const saved = readFileSync(join(cwd, "coiffeur.md"), "utf8");
  assert.match(saved, /^<!-- ai-generated: true/);
  assert.match(saved, /Schreib eine Landingpage\./);
  assert.equal(saved.includes("Hier ist dein Prompt"), false);
});

test("/pp beginnt immer ein neues Gespräch", async () => {
  await signIn();
  stub.state.chat.push(turn(["eins"]));
  stub.state.chat.push(turn(["zwei"]));
  await run([], ["/pp erste Idee", "/pp zweite Idee", "/exit"]);
  const chats = stub.requests.filter((r) => r.url === "/api/chat");
  assert.equal(chats[1].body.conversationId, undefined);
  assert.equal(chats[1].body.messages.length, 1);
});

test("/copy und /save ohne Prompt, unbekannter Befehl, zu lange Nachricht: Hinweis, nichts geht raus", async () => {
  await signIn();
  const long = "x".repeat(8001);
  const result = await run([], ["/copy", "/save", "/foo", long, "/help", "/new", "/pp", "/exit"]);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.out.match(/Noch kein Prompt/g).length, 2);
  assert.match(result.out, /Unbekannter Befehl: \/foo/);
  assert.match(result.out, /8001 Zeichen/);
  assert.match(result.out, /Befehle im Programm/);
  assert.match(result.out, /Was soll der Prompt leisten/);
  assert.equal(stub.requests.some((r) => r.url === "/api/chat"), false);
});

test("/save überschreibt nichts", async () => {
  await signIn();
  writeFileSync(join(cwd, "da.md"), "wichtig");
  stub.state.chat.push(turn(["```text\nP\n```"]));
  const result = await run([], ["/pp x", "/save da", "/exit"]);
  assert.match(result.out, /gibt es schon/);
  assert.equal(readFileSync(join(cwd, "da.md"), "utf8"), "wichtig");
});

test("Free ohne Key: Hinweis schon beim Start und beim Versuch, mit Adresse", async () => {
  await signIn();
  stub.state.me = { email: "du@beispiel.ch", plan: "free", hasOwnKey: false, needsOwnKey: true, needsConsent: false };
  stub.state.chat.push({ status: 403, body: { kind: "byokRequired", plan: "free", detail: "Key" } });
  const result = await run([], ["/pp Idee", "/exit"]);
  assert.match(result.out, /Free, kein Key/);
  assert.equal(result.out.match(/\/settings/g).length, 2);
});

test("eine widerrufene Sitzung: Hinweis zum Neuanmelden, die Datei ist weg", async () => {
  await signIn();
  const store = createSessionStore({ dir, server: stub.url });
  await store.save(session("widerrufen", "r-tot"));
  const result = await run([], ["/exit"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /promptprinter login/);
  assert.equal(await store.load(), null);
});

test("Ausfall beim Start: das Programm läuft weiter und sagt es", async () => {
  await signIn();
  stub.state.meStatus = 503;
  stub.state.chat.push(turn(["geht doch"]));
  const result = await run([], ["hallo", "/exit"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /Das ging nicht/);
  assert.match(result.out, /Finn: geht doch/);
});

test("eine Sitzung für einen anderen Server wird nie dorthin geschickt", async () => {
  await createSessionStore({ dir, server: "https://promptprinter.app" }).save(session("prod-token", "prod-refresh"));
  const result = await run(["whoami"]);
  assert.equal(result.code, 1);
  assert.equal(stub.requests.length, 0);
});
