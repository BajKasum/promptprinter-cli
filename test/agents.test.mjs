import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { findOnPath, fitsCommandLine, launchPlan, runAgent } from "../src/agents.mjs";

// Ein Prompt mit allem, was eine Shell als Befehl läse: cmd.exe (& | % ^ < > "), sh ($ ` ; '), dazu Zeilenumbrüche und
// ein Anfang mit "-", der ohne "--" eine Option des Agenten wäre.
const HOSTILE = [
  "--dangerously-skip-permissions",
  'Sag "Hallo" & echo GEHACKT | more',
  "100% %PATH% %USERNAME% ^ <nul >datei",
  "$(whoami) `id` ; rm -rf ~ 'ein Zitat'",
  "Zeile drei\r\nZeile vier\\\\\"",
].join("\n");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pp-agents-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// Ein Agent, der nur aufschreibt, was er bekommen hat.
function fakeAgentScript(path, out) {
  writeFileSync(path, `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
}

// Die `.cmd`-Datei, wie `npm install -g` sie unter Windows anlegt (cmd-shim).
function npmShim(name, target) {
  return `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*
`;
}

test("/an: ein npm-Shim unter Windows wird aufgelöst, der Prompt kommt ohne Shell und unverändert an", async () => {
  const bin = join(dir, "bin");
  mkdirSync(join(bin, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  const out = join(dir, "argv.json");
  fakeAgentScript(join(bin, "node_modules", "@openai", "codex", "bin", "codex.cjs"), out);
  writeFileSync(join(bin, "codex.cmd"), npmShim("codex", "node_modules\\@openai\\codex\\bin\\codex.cjs"));

  const file = await findOnPath("codex", { env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, platform: "win32" });
  assert.equal(file, join(bin, "codex.cmd"));
  const plan = await launchPlan(file, HOSTILE, { platform: "win32" });
  assert.equal(plan.kind, "ok");
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.args.slice(1), ["--", HOSTILE]);

  // Wirklich starten: kommt ein "&" oder "|" bei einer Shell vorbei, fehlt die Datei oder sie enthält anderes.
  const code = await runAgent(plan, { stdio: "ignore", cwd: dir });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["--", HOSTILE]);
});

test("/an: ohne Shell gestartet, mit dem Prompt als eigenem Argument", async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { once: (event, fn) => event === "exit" && setImmediate(() => fn(0, null)) };
  };
  await runAgent({ command: "C:\\x\\claude.exe", args: ["--", HOSTILE] }, { spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, ["--", HOSTILE]);
});

test("/an: eine .exe startet direkt, eine unbekannte .cmd gar nicht", async () => {
  const exe = join(dir, "claude.exe");
  writeFileSync(exe, "");
  assert.deepEqual(await launchPlan(exe, "p", { platform: "win32" }), { kind: "ok", command: exe, args: ["--", "p"] });

  const odd = join(dir, "codex.cmd");
  writeFileSync(odd, "@echo off\r\ncodex-real.exe %*\r\n");
  assert.equal((await launchPlan(odd, "p", { platform: "win32" })).kind, "unsupported");

  // Ein Shim, dessen Ziel ausserhalb seines Ordners liegt, wird nicht gestartet.
  const outside = join(dir, "sub");
  mkdirSync(outside);
  writeFileSync(join(dir, "evil.js"), "");
  writeFileSync(join(outside, "codex.cmd"), npmShim("codex", "..\\evil.js"));
  assert.equal((await launchPlan(join(outside, "codex.cmd"), "p", { platform: "win32" })).kind, "unsupported");

  // Die Datei ohne Endung, die npm für sh daneben legt, startet unter Windows nicht.
  writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
  assert.equal((await launchPlan(join(dir, "codex"), "p", { platform: "win32" })).kind, "unsupported");
});

test("/an: gesucht wird nur in absoluten PATH-Ordnern, nicht im aktuellen Ordner", async () => {
  writeFileSync(join(dir, "claude.exe"), "");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "claude.exe"), "");
  // Relative Einträge, die vom aktuellen Ordner aus genau dorthin zeigen, wo claude.exe liegt: trotzdem nicht.
  const env = { PATH: `.;;sub;${join(dir, "fehlt")}`, PATHEXT: ".EXE" };
  const before = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(await findOnPath("claude", { env, platform: "win32" }), null);
  } finally {
    process.chdir(before);
  }
  assert.equal(await findOnPath("claude", { env: { PATH: dir, PATHEXT: ".EXE" }, platform: "win32" }), join(dir, "claude.exe"));
});

test("/an: unter POSIX zählt nur eine ausführbare Datei", { skip: process.platform === "win32" }, async () => {
  const file = join(dir, "claude");
  const out = join(dir, "argv.json");
  writeFileSync(file, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  assert.equal(await findOnPath("claude", { env: { PATH: dir }, platform: "linux" }), null);
  chmodSync(file, 0o755);
  assert.equal(await findOnPath("claude", { env: { PATH: dir }, platform: "linux" }), file);
  const plan = await launchPlan(file, HOSTILE, { platform: "linux" });
  assert.equal(await runAgent(plan, { stdio: "ignore", cwd: dir }), 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), ["--", HOSTILE]);
});

test("/an: ein sehr langer Prompt passt unter Windows nicht in die Befehlszeile", () => {
  assert.equal(fitsCommandLine("x".repeat(12_000), "win32"), true);
  assert.equal(fitsCommandLine("x".repeat(12_001), "win32"), false);
  assert.equal(fitsCommandLine("x".repeat(50_000), "linux"), true);
});
