// Mutationstests (Hausregel): macht je eine Schranke kaputt, lässt die Tests laufen und stellt die Datei
// wieder her. Aufruf: npm run mutation [Teil des Namens]. Jede Zeile muss "erkannt" sein. Dateirechte
// gibt es unter Windows nicht, diese Zeilen laufen nur anderswo (in der CI unter Linux).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const POSIX = "posix";
const filter = process.argv[2];
const mutations = [
  ["src/text.mjs", "Steuerfolgen bleiben", '.replace(ESCAPE_SEQUENCE, "")', ""],
  ["src/text.mjs", "Steuerzeichen bleiben", '.replace(UNSAFE, "")', ""],
  ["src/chat.mjs", "Modelltext unbereinigt", "const clean = sanitize(parsed.data.text);", "const clean = parsed.data.text;"],
  ["src/chat.mjs", "Fehlertext unbereinigt", "detail: sanitize(parsed.data.detail)", "detail: parsed.data.detail"],
  ["src/chat.mjs", "Verlauf ohne Grenze", ".slice(-MAX_TRANSCRIPT_MESSAGES)", ""],
  ["src/chat.mjs", "leere Antwort im Verlauf", "if (content) messages.push", "messages.push"],
  ["src/chat.mjs", "unbekanntes Ereignis bricht ab", 'if (parsed.kind === "unknown") continue;', 'if (parsed.kind === "unknown") return { kind: "protocol", text: reply };'],
  ["src/chat.mjs", "kaputtes Ereignis übergangen", 'if (parsed.kind === "invalid") return { kind: "protocol", text: reply };', 'if (parsed.kind === "invalid") continue;'],
  ["src/chat.mjs", "Gespräch nicht weitergeführt", "if (id) body.conversationId = id;", ""],
  ["src/api.mjs", "folgt Umleitungen", 'redirect: "error",', 'redirect: "follow",'],
  ["src/api.mjs", "Servertext unbereinigt", "sanitize(body.detail)", "body.detail"],
  ["src/config.mjs", "http überall erlaubt", 'url.protocol !== "https:" && !(url.protocol === "http:" && local)', "false"],
  ["src/config.mjs", "fremder Host zählt als lokal", 'url.hostname.endsWith(".localhost")', 'url.hostname.includes("localhost")'],
  ["src/session.mjs", "Sitzung für jeden Server", "parsed.server === server ? parsed : null", "parsed"],
  ["src/session.mjs", "Temp-Datei für alle lesbar", 'open(tmp, "wx", 0o600)', 'open(tmp, "wx", 0o644)', POSIX],
  ["src/session.mjs", "Ordner für alle lesbar", "await mkdir(dir, { recursive: true, mode: 0o700 });\n    const tmp", "await mkdir(dir, { recursive: true });\n    const tmp", POSIX],
  ["src/session.mjs", "neues Token nicht gespeichert", "return (await store.save(refreshed.session)).access_token;", "return refreshed.session.access_token;"],
  ["src/session.mjs", "abgelehntes Token bleibt liegen", "if (err instanceof ApiError && err.status === 401) {\n          await store.clear();", "if (err instanceof ApiError && err.status === 401) {"],
  ["src/session.mjs", "Ausfall löscht die Sitzung", "if (err instanceof ApiError && err.status === 401) {\n          await store.clear();", "if (err instanceof ApiError) {\n          await store.clear();"],
  ["src/session.mjs", "kein erneutes Lesen unter der Sperre", "if (renewedElsewhere && isFresh(current)) return current.access_token;", ""],
  ["src/session.mjs", "ohne Reserve vor dem Ablauf", "session.expires_at - nowSeconds() > EXPIRY_MARGIN_S", "session.expires_at - nowSeconds() > -100000"],
  ["src/session.mjs", "kein zweiter Versuch nach 401", "const renewed = await accessToken({ rejected: token });", "throw new NotLoggedInError();\n    const renewed = await accessToken({ rejected: token });"],
  ["src/session.mjs", "Sperre wirkungslos", 'if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;\n        if (await isStale(lockPath, now)) {', 'if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;\n        if (true) {'],
  ["src/login.mjs", "fremde Adresse geöffnet", "if (url.origin === api.server) return url.href;", "return url.href;"],
  ["src/login.mjs", "Abfragepause nicht verlängert", "interval = Math.max(interval + 5, err.interval ?? 0);", ""],
  ["src/login.mjs", "Netzfehler beendet die Anmeldung", "if (err instanceof NetworkError) continue;", ""],
  ["src/login.mjs", "Sitzung nicht gespeichert", "await store.save(answer.session);", ""],
  ["src/login.mjs", "Warnung fehlt", 'print.step("loginWarning");', ""],
  ["src/system.mjs", "Speichern überschreibt", '{ flag: "wx" });\n      return { kind: "saved", path };', '{ flag: "w" });\n      return { kind: "saved", path };'],
  ["src/system.mjs", "Speichern ohne Kennzeichnung", "`${AI_GENERATED_MARKER}\\n\\n${prompt}\\n`", "`${prompt}\\n`"],
  ["src/system.mjs", "Browser öffnet alles", 'if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;', ""],
  ["src/system.mjs", "Zwischenablage nicht als UTF-8", 'pipeTo(candidate, Buffer.from(text, "utf8"), spawn)', 'pipeTo(candidate, Buffer.from(text, "utf16le"), spawn)'],
  ["src/render.mjs", "Abschluss am Zeilenende übersehen", 'if (run >= length && char === "`") {', "if (false) {"],
  ["src/render.mjs", "offener Block bleibt offen", "if (this.open) this.closeFrame();", ""],
  ["src/extract-prompt.mjs", "erster statt letzter Block", "text[text.length - 1].body", "text[0].body"],
  ["src/banner.mjs", "Bild auch in der Pipe", "!term.isTTY || ", ""],
  ["src/terminal.mjs", "NO_COLOR übergangen", " && !env.NO_COLOR", ""],
  ["src/account.mjs", "Mailadresse unbereinigt", 'sanitize(String(me.email ?? "?"))', 'String(me.email ?? "?")'],
  ["src/account.mjs", "Abmelden behält die Datei", "await store.clear();\n  return result;", "return result;"],
  ["src/cli.mjs", "Pipe wartet auf den Browser", 'if (!term.isTTY) {\n      say(t("loginRequired"));\n      return 1;\n    }', ""],
  ["src/repl.mjs", "/pp führt das Gespräch fort", 'case "/pp":\n        conversation.reset();', 'case "/pp":'],
  ["src/repl.mjs", "zu lange Nachricht geht raus", "if (text.length > MAX_USER_MESSAGE_CHARS) {", "if (false) {"],
  ["src/repl.mjs", "Strg+C beendet statt abzubrechen", 'rl.on("SIGINT", () => {\n      if (turn) turn.abort();\n      else rl.close();', 'rl.on("SIGINT", () => {\n      rl.close();'],
  ["src/repl.mjs", "Anmeldung nicht abbrechbar", "await login(turn.signal);", "await login(new AbortController().signal);"],
  ["src/repl.mjs", "eingefügte Zeilen einzeln", 'queue.push(pasted.join("\\n"));', "queue.push(...pasted);"],
  ["src/repl.mjs", "Befehl im eingefügten Text ausgeführt", 'trimmed.startsWith("/") && !trimmed.includes("\\n")', 'trimmed.startsWith("/")'],
  ["src/repl.mjs", "Wartehinweis bleibt stehen", "write(term.clearLine);", ""],
  ["src/repl.mjs", "Kontext aus der Pipe gesammelt", 'if (!term.isTTY || !input.isTTY) return { refusal: t("kontextNoTerminal") };', ""],
  ["src/repl.mjs", "Kontext: nur die Ausgabe als Terminal geprüft", "!term.isTTY || !input.isTTY", "!term.isTTY"],
  ["src/repl.mjs", "Kontext ohne Key gesammelt", "if (me.needsOwnKey || me.needsConsent) {", "if (false) {"],
  ["src/repl.mjs", "Kontext: jede Antwort sendet", 'if (answer?.trim().toLowerCase() !== t("kontextYes")) {', "if (answer === null) {"],
  ["src/repl.mjs", "Kontext: Strg+C an der Frage beendet das Programm", "turn = new AbortController();\n      const { signal } = turn;", "const { signal } = new AbortController();"],
  ["src/repl.mjs", "Kontext: abgebrochene Frage nimmt die nächste Zeile", "rl.question(query, { signal }, finish);", "rl.question(query, finish);"],
  ["src/repl.mjs", "Kontext: Vorschau ohne die Nachricht", "for (const part of wrapLine(line, width)) say(", "for (const part of []) say("],
  ["src/repl.mjs", "Kontext: falscher Empfänger", 't(me.hasOwnKey ? "kontextToOwn" : "kontextToServer")', 't("kontextToOwn")'],
  ["src/repl.mjs", "Kontext: Chat-Verlauf verschwiegen", 'say(t("kontextStored"));', ""],
  ["src/project-context.mjs", "Kontext ungeschwärzt", '.split("\\n").map(redactText).join("\\n")', ""],
  ["src/project-context.mjs", "Kontext unbereinigt", "const clean = (text) => sanitize(text).split", "const clean = (text) => text.split"],
  ["src/project-context.mjs", "Kontext erst geschwärzt, dann bereinigt", 'sanitize(text).split("\\n").map(redactText).join("\\n")', 'text.split("\\n").map(redactText).map(sanitize).join("\\n")'],
  ["src/project-context.mjs", "Kontext ohne Grenze", "const budget = max - head.length;", "const budget = max;"],
  ["src/project-context.mjs", "Stummel statt Absage", 'if (budget < MIN_CONTEXT_CHARS) return { kind: "noRoom" };', ""],
];

let missed = 0;
for (const [file, name, from, to, only] of mutations) {
  if (filter && !name.includes(filter)) continue;
  if (only === POSIX && process.platform === "win32") {
    console.log(`übersprungen  ${file}: ${name}`);
    continue;
  }
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) {
    console.log(`NICHT GEFUNDEN  ${file}: ${name}`);
    missed++;
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  let result;
  try {
    result = spawnSync(process.execPath, ["--test", "--test-timeout=30000", "test/*.test.mjs"], { encoding: "utf8", timeout: 180_000 });
  } finally {
    writeFileSync(file, original);
  }
  const caught = result.status !== 0;
  if (!caught) missed++;
  console.log(`${caught ? "erkannt " : "ÜBERLEBT"}  ${file}: ${name}`);
}
console.log(`${mutations.length} Mutationen, ${missed} nicht erkannt`);
process.exit(missed === 0 ? 0 : 1);
