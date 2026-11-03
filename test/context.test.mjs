import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { buildPack, findSecrets, isDeniedPath, redactText, renderPack, searchRepo } from "../src/context.mjs";

// src/context.mjs ist eine Kopie aus promptprinter-pp. Die Fälle hier sind aus dessen test/context.test.mjs
// übernommen, so weit das Programm die Teile nutzt: Schwärzen, Sperrliste, pack und search als Modul.
// check, save und doctor ruft das Programm nie auf, ihre Fälle bleiben drüben.
const SOURCE = new URL("../src/context.mjs", import.meta.url);
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Werte, die wie Geheimnisse aussehen, aber erfunden sind. Sie dürfen in keiner Ausgabe stehen.
const FAKE = {
  anthropic: "sk-ant-api03-FAKEFAKEFAKEFAKEFAKE1234",
  github: "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE12",
  aws: "AKIAFAKEFAKEFAKE1234",
  password: "hunter2hunter2hunter2",
};

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(files, { commit = true, init = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pp-fixture-"));
  temps.push(dir);
  if (init) git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (init && commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

// Wie emit im Skript: jede Zeile durch das Schwärzen.
const emitted = (text) => text.split("\n").map(redactText).join("\n");

describe("Herkunft", () => {
  test("die Kopie entspricht der festgehaltenen Quelle bis auf Kopf und export", () => {
    const pin = JSON.parse(readFileSync(new URL("../contract/context-pin.json", import.meta.url), "utf8"));
    const local = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
    assert.ok(local.includes(pin.commit), "Commit im Kopf");
    assert.ok(local.includes(`Skill ${pin.skill}`), "Version im Kopf");
    const restored = local
      .replace(/^\/\/ ---- Kopie: hier nicht ändern -+\n[\s\S]*?^\/\/ ---- Ende der Herkunft -+\n/m, "")
      .replace("\nexport function renderPack(", "\nfunction renderPack(");
    assert.equal(createHash("sha256").update(restored).digest("hex"), pin.sha256);
  });
});

describe("Schwärzen", () => {
  test("jedes Muster trifft und der Wert verschwindet", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      FAKE.anthropic,
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      FAKE.github,
      "github_pat_abcdefghijklmnopqrstuvwxyz1234567",
      FAKE.aws,
      "AIza" + "A".repeat(35),
      "xoxb-1234567890-abcdef",
      "sk_live_" + "a".repeat(20),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl",
      `password = "${FAKE.password}"`,
    ].join("\n");
    const out = redactText(text);
    for (const secret of [FAKE.anthropic, FAKE.github, FAKE.aws, FAKE.password, "sk-abcdefghijklmnopqrstuvwxyz123456"]) {
      assert.ok(!out.includes(secret), `Wert noch da: ${secret}`);
    }
    assert.equal(findSecrets(text).length, 11);
  });

  test("normaler Text und Verweise auf eine Quelle bleiben stehen", () => {
    const text = [
      "Der Task-Runner läuft. risk-assessment-framework-for-everything bleibt.",
      "token: process.env.API_TOKEN_VALUE",
      "password = <your-password-here>",
      "apiKey = ${SOME_LONG_ENV_VARIABLE}",
      "sk-kurz",
    ].join("\n");
    assert.deepEqual(findSecrets(text), []);
    assert.equal(redactText(text), text);
  });

  test("Zuweisungen mit längerem Schlüsselnamen, Anbieter-Token und URLs mit Passwort", () => {
    const values = {
      "AWS_SECRET_ACCESS_KEY=": "wJalrXUtnFEMIK7MDENGbPxRfiCYFAKEKEY",
      "SUPABASE_SERVICE_ROLE_KEY=": "a-fake-service-role-value",
      "PRIVATE_KEY=": "a-fake-private-key-value",
      "API_KEY_ENCRYPTION_KEY=": "a-fake-encryption-value",
      "SECRET_KEY_BASE=": "a-fake-secret-key-base",
      '"apiKey": "': "a-fake-json-api-key-value",
      'password = "': "$ecretPassw0rd123",
      "": "sb_secret_abcdefghijklmnopqrstuvwxyz",
    };
    // Zusammengesetzt, damit die Push Protection von GitHub die erfundenen Werte nicht als echte Token sperrt.
    const tokens = [
      "sbp_" + "0123456789abcdef".repeat(2) + "01234567",
      "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
      "glpat-" + "abcdefghijklmnopqrst",
      "whsec_" + "abcdefghijklmnopqrstuvwxyz012345",
      "hf_" + "abcdefghijklmnopqrstuvwxyzABCDEFGH",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    for (const [head, value] of Object.entries(values)) {
      const line = `${head}${value}`;
      assert.ok(!redactText(line).includes(value), `Wert noch da: ${line}`);
      assert.equal(findSecrets(line).length, 1, line);
    }
    for (const line of tokens) {
      assert.ok(!redactText(line).includes(line.split(" ").at(-1)), `Wert noch da: ${line}`);
      assert.equal(findSecrets(line).length, 1, line);
    }
    const url = "DATABASE_URL=postgres://admin:hunter2hunter2@db.example.com:5432/app";
    assert.ok(!redactText(url).includes("hunter2hunter2"));
    assert.match(redactText(url), /db\.example\.com/);
    assert.equal(findSecrets(url).length, 1);
  });

  test("der Körper eines privaten Schlüssels wird geschwärzt, Hash und Pfad bleiben", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKEFAKEFAKE";
    assert.ok(!redactText(body).includes(body));
    assert.equal(findSecrets(body)[0].kind, "long encoded value");
    const fine = ["4451250e7b3d5deadf922504ef4a5861ee68aeb4", "src/features/Chat2/components/MessageList/MessageListItem"].join("\n");
    assert.equal(redactText(fine), fine);
    assert.deepEqual(findSecrets(fine), []);
  });

  test("Platzhalter, Code und Wörter mit Stichwort bleiben stehen", () => {
    const text = [
      "postgres://user:password@localhost:5432/app",
      "postgres://user:${DB_PASSWORD}@localhost:5432/app",
      "http://localhost:3000/pfad@version",
      "max_tokens: DEFAULT_MAX_TOKENS_VALUE",
      "TOKEN_URL=https://example.com/oauth/token",
      "apiKey: resolveApiKeyFromConfig(request)",
      "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY",
      "Der Bearer createClientForRequest gilt nur im Chat.",
    ].join("\n");
    assert.deepEqual(findSecrets(text), []);
    assert.equal(redactText(text), text);
  });

  test("lange Zeilen bleiben schnell", () => {
    const started = Date.now();
    redactText("a".repeat(200 * 1024));
    findSecrets("a_".repeat(100 * 1024));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });

  test("Sperrliste nach Pfad", () => {
    for (const denied of [
      ".env", "app/.env.local", "x/id_rsa", "id_ed25519.pub", ".npmrc", "credentials.json", "secrets.yml", "a/b.pem", "k.key", "s.tfstate", ".aws/config", ".ssh/known_hosts", ".git/config",
      ".dev.vars", ".envrc", ".git-credentials", "terraform.tfvars", "infra/prod.tfvars", "kubeconfig", ".kube/config", ".docker/config.json", ".secrets/a",
      "service-account.json", "my_service_account_key.json", "app-firebase-adminsdk-x1.json", "google-credentials.json", "wp-config.php",
      "appsettings.Production.json", "secrets/prod.yaml", "deploy/secrets/db.env",
    ]) {
      assert.ok(isDeniedPath(denied), denied);
    }
    for (const fine of [".env.example", "src/environment.ts", "README.md", "src/keys.ts", "credits.md", "src/secrets/index.ts", "src/service-account.ts", "appsettings.json", "docker/config.json"]) {
      assert.ok(!isDeniedPath(fine), fine);
    }
    assert.ok(isDeniedPath("intern/plan.md", { denyPaths: ["intern/"] }));
  });
});

describe("pack und search als Modul", () => {
  test("Ordner ohne Git und ohne Manifest: nur der Name", () => {
    const dir = fixture({ "notizen.txt": "x\n" }, { init: false });
    const pack = buildPack(dir);
    assert.equal(pack.stack.length, 0);
    assert.match(renderPack(pack), /no project detected/);
    pack.hints.length = 0;
  });

  test("neue, nicht committete Datei steht in Status und Struktur", () => {
    const dir = fixture({ "package.json": "{}", "src/a.ts": "x\n" });
    writeFileSync(join(dir, "src", "neu.ts"), "y\n");
    const pack = buildPack(dir);
    assert.ok(pack.status.some((e) => e.path === "src/neu.ts" && e.code === "??"));
    assert.match(renderPack(pack), /src\/ \(2\)/);
    pack.hints.length = 0;
  });

  test("Ausgabe bleibt mit Stufe 3 unter 5000 Zeichen, auch bei grossem Repo", () => {
    const files = {};
    for (let i = 0; i < 40; i++) for (let j = 0; j < 14; j++) files[`mod${i}/sub${j}/f.ts`] = "x\n";
    const deps = {};
    for (let i = 0; i < 60; i++) deps[`pkg-${i}`] = "1.0.0";
    files["package.json"] = JSON.stringify({ dependencies: deps });
    const dir = fixture(files);
    for (let i = 0; i < 12; i++) git(dir, "commit", "-q", "--allow-empty", "-m", `Commit Nummer ${i} mit einem ziemlich langen Betreff, der gekuerzt werden soll ${"x".repeat(60)}`);
    const pack = buildPack(dir);
    const levels = [0, 1, 2, 3].map((level) => renderPack(pack, level).length);
    assert.ok(levels[3] <= 5000, `Stufe 3: ${levels[3]} Zeichen`);
    assert.ok(levels[3] < levels[0]);
    assert.match(renderPack(pack, 3), /\(\+\d+\)/);
    pack.hints.length = 0;
  });

  test("Geheimnisse in .env, config.js, Commit-Nachricht und README tauchen nicht auf", async () => {
    const dir = fixture({
      ".env": `API_KEY=${FAKE.anthropic}\n`,
      "config.js": `module.exports = { token: "${FAKE.github}" };\n`,
      "README.md": `Setup: export KEY=${FAKE.aws}\n`,
      "src/a.ts": "export {};\n",
    });
    git(dir, "commit", "-q", "--allow-empty", "-m", `bump ${FAKE.anthropic}`);
    const pack = buildPack(dir);
    const outputs = [renderPack(pack)];
    for (const terms of ["config,token,README,API_KEY", "KEY"]) {
      const result = await searchRepo(dir, terms, "M");
      outputs.push(result.results.flatMap((r) => [r.path, ...r.lines.map((l) => l.text)]).join("\n"));
    }
    pack.hints.length = 0;
    for (const out of outputs.map(emitted)) {
      for (const secret of [FAKE.anthropic, FAKE.github, FAKE.aws]) assert.ok(!out.includes(secret), `verrät ${secret}`);
    }
    assert.match(outputs[0], /\.env: deny list/);
  });

  test("Trefferzeilen höchstens drei je Datei und höchstens 160 Zeichen", async () => {
    const dir = fixture({ "a.ts": Array.from({ length: 9 }, () => `needle ${"y".repeat(300)}`).join("\n") });
    const [hit] = (await searchRepo(dir, "needle", "S")).results;
    assert.equal(hit.lines.length, 3);
    assert.ok(hit.lines.every((l) => l.text.length <= 160));
  });

  test("Sperrliste, Lockfiles und gebaute Ordner liefern keine Treffer", async () => {
    const dir = fixture({
      ".env": "needle=1\n",
      "secrets.json": "needle\n",
      "package-lock.json": "needle\n",
      "dist/app.js": "needle\n",
      "src/ok.ts": "needle\n",
    });
    const paths = (await searchRepo(dir, "needle", "XL")).results.map((r) => r.path);
    assert.deepEqual(paths, ["src/ok.ts"]);
  });

  test("ohne Git: Durchlauf mit Ignorierliste", async () => {
    const dir = fixture({ "package.json": "{}", "package-lock.json": "needle\n", "src/a.min.js": "needle\n", "src/a.ts": "needle\n", "node_modules/x/index.js": "needle\n", ".env": "needle\n" }, { init: false });
    const paths = (await searchRepo(dir, "needle", "M")).results.map((r) => r.path);
    assert.deepEqual(paths, ["src/a.ts"]);
  });
});

describe("Bauweise", () => {
  const source = readFileSync(SOURCE, "utf8");

  test("kein Netzwerk: kein Import von net, http, https, dns, tls, dgram, kein fetch", () => {
    assert.doesNotMatch(source, /from\s+["']node:(net|http|https|http2|dns|tls|dgram)["']/);
    assert.doesNotMatch(source, /require\(["'](net|http|https|dns)["']\)/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\bWebSocket\b|XMLHttpRequest/);
  });

  test("Git nur über Argumentlisten, keine Shell", () => {
    assert.doesNotMatch(source, /\bexec\s*\(|\bexecSync\s*\(|shell\s*:\s*true|spawn(Sync)?\s*\([^)]*shell/);
    assert.doesNotMatch(source, /child_process["']\s*;?[\s\S]*\bexec\b[^FSa-z]/);
  });

  test("keine Laufzeit-Abhängigkeiten: nur node:-Module", () => {
    const imports = [...source.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    assert.ok(imports.every((i) => i.startsWith("node:")), imports.join(", "));
  });
});
