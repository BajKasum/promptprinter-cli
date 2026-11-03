import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { createApi } from "../src/api.mjs";
import { MAX_USER_MESSAGE_CHARS } from "../src/chat.mjs";
import { translator } from "../src/messages.mjs";
import { buildContextMessage, deriveTerms } from "../src/project-context.mjs";
import { runRepl } from "../src/repl.mjs";
import { createAuth, createSessionStore } from "../src/session.mjs";
import { detectTerminal } from "../src/terminal.mjs";
import { session, startStub, turn } from "./support/stub-server.mjs";

// `/pp --kontext`: was aus dem Ordner an den Server geht, und dass ohne ein getipptes "j" nichts geht.
const BIN = fileURLToPath(new URL("../bin/promptprinter.mjs", import.meta.url));
const CTRL_C = "\u0003";
const t = translator("de");
const temps = [];
let stub;
let dir;

after(() => {
  for (const temp of temps) rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pp-kontext-"));
  stub = await startStub();
});
afterEach(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(files, { commit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pp-repo-"));
  temps.push(root);
  git(root, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (commit) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  return root;
}

// Eingepflanzte Geheimnisse, erfunden. Zusammengesetzt, damit die Push Protection von GitHub sie nicht als
// echte Werte sperrt. Kein einziger darf in einer Anfrage stehen.
const JWT_PAYLOAD = "eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ";
const JWT_SIGNATURE = "FAKEsig_nature_FAKE_signature_1234567890ab";
const SECRET = {
  aws: "AKIA" + "IOSFODNN7FAKEXYZ",
  awsSecret: "wJalrXUtnFEMIK7MDENG" + "bPxRfiCYFAKEKEY",
  dbPassword: "S3cretPassw0rd",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + JWT_PAYLOAD + "." + JWT_SIGNATURE,
  keyBody: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj" + "AgEAAoIBAQC7FAKEFAKEFAKE",
  stripe: "sk_" + "live_" + "FAKEFAKEFAKEFAKE1234",
  // Kurz und ohne Muster: das Schwärzen fände es nicht, nur die Sperrliste hält .env zurück.
  sessionSecret: "Kurz-2026!",
};
const LEAKS = [SECRET.aws, SECRET.awsSecret, SECRET.dbPassword, JWT_PAYLOAD, JWT_SIGNATURE, SECRET.keyBody, SECRET.stripe, SECRET.sessionSecret];
const DB_URL = `postgres://admin:${SECRET.dbPassword}@db.internal:5432/app`;
const PRIVATE_KEY_HEAD = "-----BEGIN " + "PRIVATE KEY-----";

const secretsRepo = () => {
  const root = fixture({
    "package.json": JSON.stringify({ name: "laden", scripts: { test: "node --test" } }),
    "CLAUDE.md": "# Regeln\nKeine Geheimnisse ins Repo.\n",
    ".env": `DATABASE_URL=${DB_URL}\nSESSION_SECRET=${SECRET.sessionSecret}\nSUPABASE_SERVICE_ROLE_KEY=${SECRET.jwt}\n`,
    "deploy/server.key": `${PRIVATE_KEY_HEAD}\n${SECRET.keyBody}\n-----END PRIVATE KEY-----\n`,
    "src/db.ts": `export const DATABASE_URL = "${DB_URL}";\n`,
    "src/supabase.ts": `const serviceRole = "${SECRET.jwt}";\nexport default serviceRole;\n`,
    "src/aws.ts": `export const AWS_ACCESS_KEY_ID = "${SECRET.aws}";\nexport const AWS_SECRET_ACCESS_KEY = "${SECRET.awsSecret}";\n`,
    "src/keys.ts": `// ${PRIVATE_KEY_HEAD} für die Tests\nexport const privateKeyBody = "${SECRET.keyBody}";\n`,
    "docs/setup.md": `# Setup\n\n\`\`\`\nDATABASE_URL=${DB_URL}\nSTRIPE_SECRET_KEY=${SECRET.stripe}\n\`\`\`\n`,
  });
  git(root, "commit", "-q", "--allow-empty", "-m", `Zugang ${SECRET.aws}`);
  return root;
};
const SECRET_IDEA =
  "Prüfe DATABASE_URL, serviceRole, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, SESSION_SECRET, privateKeyBody und .env im Setup";

async function until(check, what, ms = 30_000) {
  for (const started = Date.now(); Date.now() - started < ms; ) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`nicht eingetreten: ${what}`);
}

/** Die Eingabezeile wie im echten Terminal (Tasten als Bytes), im Ordner `cwd`. */
async function start({ cwd, inputIsTTY = true } = {}) {
  const store = createSessionStore({ dir, server: stub.url });
  await store.save(session("a1", "r1"));
  const api = createApi({ server: stub.url, version: "0", lang: "de" });
  const input = new PassThrough();
  input.isTTY = inputIsTTY;
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
    t,
    api,
    auth: createAuth({ store, api }),
    store,
    login: async () => true,
    copy: async () => true,
    save: async () => ({ kind: "failed", reason: "nicht im Test" }),
    cwd,
  });
  return { input, finished, screen: () => screen };
}

const chats = () => stub.requests.filter((r) => r.url === "/api/chat");
const asked = (repl) => until(() => repl.screen().includes("[j/N]"), "Frage nach dem Senden");

describe("Suchbegriffe", () => {
  test("Bezeichner zuerst, häufige Wörter und Zahlen nicht, höchstens acht", () => {
    assert.deepEqual(deriveTerms("Baue /pp --kontext in src/repl.mjs, prüfe MAX_USER_MESSAGE_CHARS und onDelta"), [
      "/pp",
      "src/repl.mjs",
      "MAX_USER_MESSAGE_CHARS",
      "onDelta",
      "--kontext",
    ]);
    assert.deepEqual(deriveTerms("eine neue Landingpage für den Coiffeur, z.B. mit API von 2026"), ["Landingpage", "Coiffeur", "API"]);
    assert.equal(deriveTerms(Array.from({ length: 20 }, (_, i) => `wort_${i}`).join(" ")).length, 8);
    assert.deepEqual(deriveTerms(""), []);
  });
});

describe("Nachricht", () => {
  const intro = t("kontextIntro");

  test("nie über 8000 Zeichen, auch bei grossem Repo und langer Absicht; die Absicht bleibt ganz", async () => {
    const files = { "package.json": JSON.stringify({ name: "gross" }) };
    for (let i = 0; i < 60; i++) {
      files[`src/mod${i}/checkout_flow.ts`] = Array.from({ length: 20 }, (_, n) => `export const checkout_flow_${n} = "${"z".repeat(150)}";`).join("\n");
    }
    const root = fixture(files);
    for (const length of [10, 2000, 6000, 7200]) {
      const idea = `checkout_flow ${"Absicht ".repeat(length)}`.slice(0, length);
      const built = await buildContextMessage({ cwd: root, idea, intro, max: MAX_USER_MESSAGE_CHARS });
      assert.equal(built.kind, "ready", `Absicht ${length}`);
      assert.ok(built.message.length <= MAX_USER_MESSAGE_CHARS, `Absicht ${length}: ${built.message.length} Zeichen`);
      assert.ok(built.message.startsWith(`${idea}\n\n---\n${intro}\n\n`), `Absicht ${length} gekürzt`);
      assert.match(built.message, /# PP context pack/);
    }
    const short = await buildContextMessage({ cwd: root, idea: "checkout_flow", intro, max: MAX_USER_MESSAGE_CHARS });
    assert.ok(short.files > 0, "Trefferzeilen fehlen");
    assert.ok(short.message.length > 4000, `${short.message.length} Zeichen, der Platz wird genutzt`);
  });

  test("kein Platz neben einer sehr langen Absicht: kein Stummel, sondern eine Absage", async () => {
    const root = fixture({ "a.ts": "x\n" });
    const built = await buildContextMessage({ cwd: root, idea: "a".repeat(7800), intro, max: MAX_USER_MESSAGE_CHARS });
    assert.equal(built.kind, "noRoom");
  });

  test("Steuerfolgen aus Dateien gehen nicht mit, auch nicht mitten in einem Wert", async () => {
    const root = fixture({
      "src/legacy.ts": `export const AWS_ACCESS_KEY_ID = "AKIA\u001b[0m${SECRET.aws.slice(4)}"; \u001b]0;Titel\u0007\n`,
    });
    const built = await buildContextMessage({ cwd: root, idea: "AWS_ACCESS_KEY_ID", intro, max: MAX_USER_MESSAGE_CHARS });
    assert.ok(built.files > 0, "Datei nicht gefunden");
    assert.ok(!built.message.includes("\u001b"), "Steuerfolge in der Nachricht");
    assert.ok(!built.message.includes("\u0007"));
    assert.ok(!built.message.includes(SECRET.aws), "zusammengesetzter Wert in der Nachricht");
    assert.match(built.message, /\[redacted: aws key\]/);
  });

  test("Hinweise sammeln sich nicht über mehrere Aufrufe", async () => {
    const root = fixture({ "a.ts": "x\n" }, { commit: false });
    for (let i = 0; i < 2; i++) {
      const built = await buildContextMessage({ cwd: root, idea: "irgendwas", intro, max: MAX_USER_MESSAGE_CHARS });
      assert.equal(built.message.split("repository has no commit yet").length - 1, 1, `Aufruf ${i + 1}`);
    }
  });
});

describe("Vorschau und Ja", () => {
  test("Fixture mit Geheimnissen: nach j geht die Nachricht raus, kein Wert steht in einer Anfrage", async () => {
    stub.state.chat.push(turn(["Kurz eine Frage."]));
    const repl = await start({ cwd: secretsRepo() });
    repl.input.write(`/pp --kontext ${SECRET_IDEA}\r`);
    await asked(repl);
    const screen = repl.screen();
    assert.match(screen, /Vorschau\. Genau das geht an Finn/);
    assert.match(screen, /An: PromptPrinter und deinen eigenen KI-Anbieter/);
    assert.match(screen, /bleibt in deinem Chat-Verlauf gespeichert/);
    assert.match(screen, /src\/db\.ts/, "Trefferzeilen in der Vorschau");
    assert.equal(chats().length, 0, "vor dem j geht nichts raus");

    repl.input.write("j\r");
    await until(() => repl.screen().includes("Finn: Kurz eine Frage."), "Antwort");
    assert.equal(chats().length, 1);
    const content = chats()[0].body.messages.at(-1).content;
    assert.ok(content.startsWith(`${SECRET_IDEA}\n\n---\n`), "die Absicht steht vorne, ganz");
    assert.ok(content.length <= MAX_USER_MESSAGE_CHARS);
    assert.ok(screen.includes(content.split("\n").find((line) => line.includes("src/aws.ts"))), "Vorschau zeigt, was gesendet wird");
    for (const kind of ["aws key", "assignment", "url credentials", "jwt", "long encoded value", "live key"]) {
      assert.ok(content.includes(`[redacted: ${kind}]`), `nichts geschwärzt: ${kind}`);
    }
    assert.match(content, /\.env: deny list/);
    assert.match(content, /deploy\/server\.key: deny list/);
    const everything = JSON.stringify(stub.requests) + repl.screen();
    for (const value of LEAKS) assert.ok(!everything.includes(value), `Wert verraten: ${value}`);

    repl.input.write("/exit\r");
    await repl.finished;
  });

  test("ohne eigenen Key nennt die Vorschau Z.ai als Empfänger", async () => {
    stub.state.me = { ...stub.state.me, hasOwnKey: false };
    const repl = await start({ cwd: fixture({ "a.ts": "needle\n" }) });
    repl.input.write("/pp --kontext needle\r");
    await asked(repl);
    assert.match(repl.screen(), /An: PromptPrinter und, über den Server-Key, Z\.ai in Singapur/);
    repl.input.write("n\r");
    await until(() => repl.screen().includes("Nichts gesendet."), "Absage");
    repl.input.write("/exit\r");
    await repl.finished;
  });

  test("nur j sendet: n, ja, eine leere Zeile und Strg+C senden nichts, das Programm läuft weiter", async () => {
    const repl = await start({ cwd: fixture({ "a.ts": "needle\n" }) });
    for (const answer of ["n\r", "ja\r", "\r", CTRL_C]) {
      const before = repl.screen().split("Nichts gesendet.").length;
      repl.input.write("/pp --kontext needle\r");
      await until(() => repl.screen().split("[j/N]").length === before + 1, `Frage für ${JSON.stringify(answer)}`);
      repl.input.write(answer);
      await until(() => repl.screen().split("Nichts gesendet.").length === before + 1, `Absage für ${JSON.stringify(answer)}`);
    }
    // Die abgebrochene Frage nimmt die nächste Zeile nicht mehr an, ein Befehl läuft wieder.
    repl.input.write("/whoami\r");
    await until(() => repl.screen().includes("Angemeldet als du@beispiel.ch"), "nächster Befehl");
    assert.equal(chats().length, 0);
    repl.input.write("/exit\r");
    await repl.finished;
  });

  test("ohne Key oder ohne Zustimmung wird nichts gesammelt", async () => {
    stub.state.me = { ...stub.state.me, hasOwnKey: false, needsOwnKey: true };
    const repl = await start({ cwd: fixture({ "a.ts": "needle\n" }) });
    repl.input.write("/pp --kontext needle\r");
    await until(() => repl.screen().includes("brauchst du einen eigenen KI-Key"), "Hinweis auf den Key");
    assert.doesNotMatch(repl.screen(), /Sammle Kontext|Vorschau/);
    repl.input.write("/exit\r");
    await repl.finished;
    assert.equal(chats().length, 0);
  });

  test("Eingabe aus einer Pipe, auch mit Terminal als Ausgabe: nichts gesammelt, nichts gesendet", async () => {
    const repl = await start({ cwd: fixture({ "a.ts": "needle\n" }), inputIsTTY: false });
    repl.input.write("/pp --kontext needle\r");
    await until(() => repl.screen().includes("geht nur im Terminal"), "Absage");
    assert.doesNotMatch(repl.screen(), /Sammle Kontext|Vorschau/);
    repl.input.write("/exit\r");
    await repl.finished;
    assert.equal(chats().length, 0);
  });

  test("das echte Programm aus einer Pipe verweigert, das j aus der Pipe zählt nicht", async () => {
    const config = mkdtempSync(join(tmpdir(), "pp-config-"));
    temps.push(config);
    await createSessionStore({ dir: config, server: stub.url }).save(session("a1", "r1"));
    stub.state.chat.push(turn(["ok"]));
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN], {
        cwd: secretsRepo(),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          PROMPTPRINTER_URL: stub.url,
          PROMPTPRINTER_CONFIG_DIR: config,
          PROMPTPRINTER_LANG: "de",
          PROMPTPRINTER_NO_BROWSER: "1",
        },
      });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (text += d));
      child.on("error", reject);
      child.on("close", () => resolve(text));
      child.stdin.end(`/pp --kontext ${SECRET_IDEA}\nj\n`);
    });
    assert.match(out, /geht nur im Terminal/);
    assert.doesNotMatch(out, /Vorschau/);
    const sent = JSON.stringify(chats());
    assert.ok(!sent.includes("DATABASE_URL") && !sent.includes(t("kontextIntro")), "Kontext gesendet");
    for (const value of LEAKS) assert.ok(!sent.includes(value), value);
  });
});
