import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplyRenderer } from "../src/render.mjs";

function render(parts, termOverrides = {}) {
  let out = "";
  const term = { unicode: true, wrapWidth: Infinity, accent: (s) => s, ...termOverrides };
  const renderer = new ReplyRenderer({ write: (s) => (out += s), term, labels: { prompt: "Prompt" } });
  for (const part of parts) renderer.feed(part);
  renderer.finish();
  return out;
}

test("Fliesstext geht unverändert durch und endet mit einem Umbruch", () => {
  assert.equal(render(["Kurz zwei Dinge: ", "Wer liest es?"]), "Kurz zwei Dinge: Wer liest es?\n");
  assert.equal(render(["Eine Zeile\nund noch eine\n"]), "Eine Zeile\nund noch eine\n");
});

test("Fliesstext erscheint sofort, nicht erst am Zeilenende", () => {
  let out = "";
  const term = { unicode: true, wrapWidth: Infinity, accent: (s) => s };
  const renderer = new ReplyRenderer({ write: (s) => (out += s), term, labels: { prompt: "Prompt" } });
  renderer.feed("Hallo");
  assert.equal(out, "Hallo");
});

test("ein Block wird gerahmt, die Backticks stehen nicht in der Ausgabe", () => {
  const out = render(["Hier ist dein Prompt.\n```text\nZeile eins\n\nZeile zwei\n```\nFertig."]);
  const lines = out.split("\n");
  assert.equal(lines[0], "Hier ist dein Prompt.");
  assert.match(lines[1], /^┌─ Prompt ─+$/);
  assert.equal(lines[2], "│ Zeile eins");
  assert.equal(lines[3], "│");
  assert.equal(lines[4], "│ Zeile zwei");
  assert.match(lines[5], /^└─+$/);
  assert.equal(lines[6], "Fertig.");
  assert.equal(out.includes("```"), false);
});

test("der Rahmen hält auch, wenn Stücke mitten in den Backticks enden", () => {
  const out = render(["``", "`te", "xt\nInh", "alt\n`", "``\n"]);
  assert.match(out, /^┌─ Prompt/);
  assert.match(out, /│ Inhalt\n/);
  assert.match(out, /└─+\n$/);
  assert.equal(out.includes("`"), false);
});

test("der Abschluss am Ende einer Inhaltszeile schliesst den Block (glm-4.5-air)", () => {
  const out = render(["```text\nfür Buchungsanfragen.```\nDanach Text."]);
  assert.match(out, /│ für Buchungsanfragen\.\n└─+\nDanach Text\.\n$/);
  assert.equal(out.includes("`"), false);
});

test("ein Block ohne Abschluss wird am Ende trotzdem geschlossen", () => {
  const out = render(["```text\nabgerissen\nnoch mehr"]);
  assert.match(out, /│ abgerissen\n│ noch mehr\n└─+\n$/);
});

test("ein anderer Block trägt seine Sprache im Rahmen, Backticks mitten im Text bleiben Text", () => {
  assert.match(render(['```json\n{"a":1}\n```\n']), /^┌─ json ─+\n│ {"a":1}\n/);
  assert.equal(render(["Nimm `npm test` und ```so``` dazu."]), "Nimm `npm test` und ```so``` dazu.\n");
  assert.equal(render(["`code` am Zeilenanfang"]), "`code` am Zeilenanfang\n");
});

test("lange Zeilen werden im Rahmen umbrochen, jede mit Rand", () => {
  const out = render(["```text\neins zwei drei vier\n```\n"], { wrapWidth: 12 });
  const content = out.split("\n").filter((line) => line.startsWith("│"));
  assert.deepEqual(content, ["│ eins zwei", "│ drei vier"]);
});

test("ohne Unicode ein ASCII-Rahmen", () => {
  const out = render(["```text\nx\n```\n"], { unicode: false });
  assert.match(out, /^\+- Prompt -+\n\| x\n\+-+\n$/);
});
