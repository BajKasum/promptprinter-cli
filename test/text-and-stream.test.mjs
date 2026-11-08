import assert from "node:assert/strict";
import { test } from "node:test";
import { banner, BANNER_WIDTH } from "../src/banner.mjs";
import { ConfigError, configDir, DEFAULT_SERVER, serverUrl } from "../src/config.mjs";
import { extractPrompt } from "../src/extract-prompt.mjs";
import { detectLang, translator } from "../src/messages.mjs";
import { parseSse, readChatEvent } from "../src/sse.mjs";
import { detectTerminal } from "../src/terminal.mjs";
import { sanitize, wrapLine } from "../src/text.mjs";

const plainTerm = (overrides = {}) => ({
  isTTY: true,
  unicode: true,
  columns: 100,
  accent: (s) => s,
  dim: (s) => s,
  ...overrides,
});

async function* chunks(...parts) {
  for (const part of parts) yield typeof part === "string" ? Buffer.from(part) : part;
}
async function collect(generator) {
  const out = [];
  for await (const item of generator) out.push(item);
  return out;
}

test("sanitize nimmt Steuerfolgen und Steuerzeichen, lässt Text, Umbruch und Tabulator", () => {
  assert.equal(sanitize("Hallo\u001b[31m rot\u001b[0m"), "Hallo rot");
  assert.equal(sanitize("\u001b]0;Titel\u0007Text"), "Text");
  assert.equal(sanitize("\u001b]52;c;Z2VoZWlt\u001b\\Text"), "Text");
  assert.equal(sanitize("a\u0000b\u0007c\u009bd"), "abcd");
  assert.equal(sanitize("links\u202Erechts\u2066"), "linksrechts");
  assert.equal(sanitize("Zeile\r\nzwei\tTab"), "Zeile\nzwei\tTab");
  assert.equal(sanitize("üöä ñ 日本語"), "üöä ñ 日本語");
});

test("ein Escape, das auf zwei Stücke fällt, wird trotzdem unschädlich", () => {
  assert.equal(sanitize("\u001b").includes("\u001b"), false);
  assert.equal(sanitize("[31mrot"), "[31mrot");
});

test("wrapLine bricht an Wortgrenzen und teilt nur, was nicht passt", () => {
  assert.deepEqual(wrapLine("eins zwei drei", 9), ["eins zwei", "drei"]);
  assert.deepEqual(wrapLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapLine("kurz", 80), ["kurz"]);
  assert.deepEqual(wrapLine("", 80), [""]);
  assert.deepEqual(wrapLine("lang lang lang", Infinity), ["lang lang lang"]);
});

test("parseSse liest Ereignisse über Stückgrenzen, auch mitten im Zeichen", async () => {
  const raw = Buffer.from('event: delta\ndata: {"text":"Grüße"}\n\nevent: done\ndata: {}\n\n');
  const split = raw.indexOf(0xc3) + 1;
  const events = await collect(parseSse(chunks(raw.subarray(0, split), raw.subarray(split))));
  assert.deepEqual(events, [
    { event: "delta", data: '{"text":"Grüße"}' },
    { event: "done", data: "{}" },
  ]);
});

test("parseSse kennt CRLF und Kommentare, ein unvollständiges Ereignis am Ende fällt weg", async () => {
  const events = await collect(parseSse(chunks(': ping\n\nevent: delta\r\ndata: {"text":"a"}\r\n\r\nevent: delta\ndata: {"te')));
  assert.deepEqual(events, [{ event: "delta", data: '{"text":"a"}' }]);
});

test("readChatEvent: bekannt, unbekannt, kaputt", () => {
  assert.equal(readChatEvent("delta", '{"text":"x"}').kind, "event");
  assert.deepEqual(readChatEvent("zukunft", "{kein json"), { kind: "unknown", event: "zukunft" });
  assert.equal(readChatEvent("toString", "{}").kind, "unknown");
  assert.equal(readChatEvent("delta", "{}").kind, "invalid");
  assert.equal(readChatEvent("delta", '{"text":5}').kind, "invalid");
  assert.equal(readChatEvent("delta", "null").kind, "invalid");
  assert.equal(readChatEvent("delta", "{kaputt").kind, "invalid");
  assert.equal(readChatEvent("error", "{}").kind, "invalid");
  assert.equal(readChatEvent("meta", '{"conversationId":7}').kind, "invalid");
  assert.equal(readChatEvent("done", "{}").kind, "event");
  assert.equal(readChatEvent("status", '{"phase":"retrying","attempt":2,"maxAttempts":3}').kind, "event");
});

test("extractPrompt nimmt den letzten text-Block, sonst den längsten, und findet den Abschluss mitten in der Zeile", () => {
  assert.equal(extractPrompt("nur eine Frage?"), null);
  assert.equal(extractPrompt("```text\neins\n```\nund\n```text\nzwei\n```"), "zwei");
  assert.equal(extractPrompt('```json\n{"a":1}\n```\n```\nder längere Block\n```'), "der längere Block");
  assert.equal(extractPrompt('```text\nPrompt\n```\n```json\n{"lang":"ganz langer Block ohne Bezug"}\n```'), "Prompt");
  assert.equal(extractPrompt("```text\nfür Buchungsanfragen.```\nFertig."), "für Buchungsanfragen.");
  assert.equal(extractPrompt("```text\n\n```"), null);
});

test("Startbild: Blockschrift ohne Rahmenlinien, eine Zeile ab 71 Spalten, zwei ab 60, darunter nur der Name", () => {
  const plain = "PromptPrinter 1.2.3";
  const art = (text) => text.split("\n").filter((line) => line.includes("█"));
  const wide = banner(plainTerm({ columns: BANNER_WIDTH + 2 }), "1.2.3");
  assert.equal(art(wide).length, 5);
  assert.match(wide, /PromptPrinter 1\.2\.3$/);
  // Nur volle Blöcke und Leerzeichen: Rahmenlinien zerfallen in Windows Terminal.
  assert.match(art(wide).join(""), /^[█ ]+$/);
  for (const line of art(wide)) assert.ok([...line].length <= BANNER_WIDTH, line);
  assert.ok(BANNER_WIDTH <= 78, "passt in 80 Spalten");

  const narrow = banner(plainTerm({ columns: BANNER_WIDTH + 1 }), "1.2.3");
  assert.equal(art(narrow).length, 10);
  for (const line of art(narrow)) assert.ok([...line].length < 60, line);
  assert.equal(art(banner(plainTerm({ columns: 60 }), "1.2.3")).length, 10);

  assert.equal(banner(plainTerm({ columns: 59 }), "1.2.3"), plain);
  assert.equal(banner(plainTerm({ isTTY: false }), "1.2.3"), plain);
  assert.equal(banner(plainTerm({ unicode: false }), "1.2.3"), plain);
});

test("Terminal: Farbe nur im echten Terminal und ohne NO_COLOR", () => {
  const stream = { isTTY: true, columns: 90 };
  assert.equal(detectTerminal(stream, { LANG: "de_CH.UTF-8" }, "linux").color, true);
  assert.equal(detectTerminal(stream, { LANG: "de_CH.UTF-8", NO_COLOR: "1" }, "linux").color, false);
  assert.equal(detectTerminal(stream, { TERM: "dumb" }, "linux").color, false);
  assert.equal(detectTerminal({ isTTY: false }, {}, "linux").color, false);
  assert.equal(detectTerminal(stream, { LANG: "de_CH.UTF-8", NO_COLOR: "1" }, "linux").accent("x"), "x");
  assert.equal(detectTerminal(stream, { LANG: "C" }, "linux").unicode, false);
  assert.equal(detectTerminal(stream, { LANG: "de_CH.UTF-8" }, "linux").unicode, true);
  assert.equal(detectTerminal(stream, {}, "win32").unicode, true);
  assert.equal(detectTerminal(stream, { LANG: "de_CH.UTF-8" }, "linux").wrapWidth, 88);
  assert.equal(detectTerminal({ isTTY: false }, {}, "linux").wrapWidth, Infinity);
});

test("Server-Adresse: https überall, http nur auf diesem Rechner", () => {
  assert.equal(serverUrl({}), DEFAULT_SERVER);
  assert.equal(serverUrl({ PROMPTPRINTER_URL: "https://staging.example.com/pfad" }), "https://staging.example.com");
  assert.equal(serverUrl({ PROMPTPRINTER_URL: "http://localhost:3000" }), "http://localhost:3000");
  assert.equal(serverUrl({ PROMPTPRINTER_URL: "http://127.0.0.1:3000" }), "http://127.0.0.1:3000");
  assert.equal(serverUrl({ PROMPTPRINTER_URL: "http://app.localhost:3000" }), "http://app.localhost:3000");
  assert.throws(() => serverUrl({ PROMPTPRINTER_URL: "http://example.com" }), ConfigError);
  assert.throws(() => serverUrl({ PROMPTPRINTER_URL: "http://localhost.example.com" }), ConfigError);
  assert.throws(() => serverUrl({ PROMPTPRINTER_URL: "ftp://localhost" }), ConfigError);
  assert.throws(() => serverUrl({ PROMPTPRINTER_URL: "kaputt" }), ConfigError);
});

test("Konfigurationsordner je Plattform", () => {
  assert.equal(configDir({ PROMPTPRINTER_CONFIG_DIR: "/x" }, "linux"), "/x");
  assert.match(configDir({ APPDATA: "C:\\Users\\k\\AppData" }, "win32"), /AppData.promptprinter$/);
  assert.match(configDir({ XDG_CONFIG_HOME: "/cfg" }, "linux"), /cfg.promptprinter$/);
  assert.match(configDir({}, "linux"), /\.config.promptprinter$/);
});

test("Sprache: deutsch nur bei deutschem Gebietsschema, sonst englisch", () => {
  assert.equal(detectLang({ PROMPTPRINTER_LANG: "de" }), "de");
  assert.equal(detectLang({ LANG: "de_CH.UTF-8" }), "de");
  assert.equal(detectLang({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(detectLang({ LANG: "fr_CH.UTF-8" }), "en");
  assert.equal(detectLang({ LANG: "dex_XX" }), "en");
  assert.equal(translator("de")("tooLong", { length: 9, max: 8 }), "Das sind 9 Zeichen, höchstens 8 gehen in einer Nachricht.");
  assert.equal(translator("en")("copied"), "Prompt copied.");
});

test("beide Sprachen kennen dieselben Texte", async () => {
  const source = (await import("node:fs")).readFileSync(new URL("../src/messages.mjs", import.meta.url), "utf8");
  const keys = (block) => [...block.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]).sort();
  const [de, en] = source.split(/^ {2}en: \{/m);
  assert.deepEqual(keys(de), keys(en));
});
