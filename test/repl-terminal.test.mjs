import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";
import { createApi } from "../src/api.mjs";
import { translator } from "../src/messages.mjs";
import { runRepl } from "../src/repl.mjs";
import { createAuth, createSessionStore } from "../src/session.mjs";
import { detectTerminal } from "../src/terminal.mjs";
import { session, sse, startStub, turn } from "./support/stub-server.mjs";

// Die Eingabezeile im Terminalmodus von readline: Tasten kommen als Bytes, Strg+C als \x03. Das ist es,
// was eine Pipe im Programmtest nicht zeigen kann.
const CTRL_C = "\u0003";
let stub;
let dir;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pp-repl-"));
  stub = await startStub();
});
afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function start({ login = async () => true } = {}) {
  const store = createSessionStore({ dir, server: stub.url });
  await store.save(session("a1", "r1"));
  const api = createApi({ server: stub.url, version: "0", lang: "de" });
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  let screen = "";
  output.on("data", (d) => (screen += d));
  const term = detectTerminal(output, { LANG: "de_CH.UTF-8", NO_COLOR: "1" }, "linux");
  const finished = runRepl({
    input,
    output,
    term,
    t: translator("de"),
    api,
    auth: createAuth({ store, api }),
    store,
    login,
    copy: async () => true,
    save: async () => ({ kind: "failed", reason: "nicht im Test" }),
  });
  return { input, finished, screen: () => screen };
}

async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`nicht eingetreten: ${what}`);
}

const chats = () => stub.requests.filter((r) => r.url === "/api/chat");

test("Strg+C bricht einen laufenden Zug ab, das Programm läuft weiter, Strg+C an der leeren Zeile beendet es", async () => {
  stub.state.chat.push({ raw: [sse("delta", { text: "halb" })], hang: true });
  stub.state.chat.push(turn(["zweiter Zug"]));
  const repl = await start();

  repl.input.write("/pp Idee\r");
  await until(() => repl.screen().includes("halb"), "Antwort beginnt");
  repl.input.write(CTRL_C);
  await until(() => repl.screen().includes("Abgebrochen."), "Abbruch gemeldet");

  repl.input.write("weiter\r");
  await until(() => repl.screen().includes("zweiter Zug"), "nächster Zug läuft");
  // Erst wenn die Eingabezeile wieder da ist, gilt Strg+C dem Programm und nicht mehr dem Zug.
  await until(() => {
    const screen = repl.screen();
    return screen.slice(screen.lastIndexOf("zweiter Zug")).includes("> ");
  }, "Eingabezeile zurück");

  repl.input.write(CTRL_C);
  await repl.finished;
});

test("Strg+C bricht auch das Warten auf die Anmeldung ab", async () => {
  let aborted = false;
  const repl = await start({
    login: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(false);
        });
      }),
  });
  repl.input.write("/login\r");
  await sleep(50);
  repl.input.write(CTRL_C);
  await until(() => aborted, "Abbruch erreicht die Anmeldung");
  repl.input.write("/exit\r");
  await repl.finished;
});

test("eingefügter Text mit mehreren Zeilen wird eine Nachricht, keine drei", async () => {
  stub.state.chat.push(turn(["ok"]));
  const repl = await start();
  repl.input.write("Zeile eins\rZeile zwei\rZeile drei\r");
  await until(() => repl.screen().includes("Finn: ok"), "Antwort kommt");
  assert.equal(chats().length, 1);
  assert.equal(chats()[0].body.messages[0].content, "Zeile eins\nZeile zwei\nZeile drei");
  repl.input.write("/exit\r");
  await repl.finished;
});

test("einzeln getippte Zeilen bleiben einzelne Nachrichten", async () => {
  stub.state.chat.push(turn(["eins"]));
  stub.state.chat.push(turn(["zwei"]));
  const repl = await start();
  repl.input.write("erste\r");
  await until(() => repl.screen().includes("Finn: eins"), "erste Antwort");
  repl.input.write("zweite\r");
  await until(() => repl.screen().includes("Finn: zwei"), "zweite Antwort");
  assert.equal(chats().length, 2);
  repl.input.write("/exit\r");
  await repl.finished;
});

test("ein Befehl im eingefügten Text wird nicht ausgeführt", async () => {
  stub.state.chat.push(turn(["ok"]));
  const repl = await start();
  repl.input.write("/exit\rund noch was\r");
  await until(() => chats().length === 1, "geht an Finn");
  assert.equal(chats()[0].body.messages[0].content, "/exit\nund noch was");
  await until(() => repl.screen().includes("Finn: ok"), "Antwort kommt");
  repl.input.write("/exit\r");
  await repl.finished;
});

test("während des Wartens steht ein Hinweis, der mit dem ersten Wort verschwindet", async () => {
  stub.state.chat.push({
    raw: [sse("status", { phase: "retrying", attempt: 2, maxAttempts: 3 }), sse("delta", { text: "da" }), sse("done", {})],
  });
  const repl = await start();
  repl.input.write("hallo\r");
  await until(() => repl.screen().includes("Finn: da"), "Antwort kommt");
  assert.match(repl.screen(), /Finn denkt nach/);
  assert.match(repl.screen(), /neuer Versuch \(2 von 3\)/);
  const afterHint = repl.screen().slice(repl.screen().lastIndexOf("neuer Versuch"));
  assert.ok(afterHint.includes("\r\u001b[K"), "die Zeile wird gelöscht");
  repl.input.write("/exit\r");
  await repl.finished;
});
