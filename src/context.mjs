#!/usr/bin/env node
// ---- Kopie: hier nicht ändern -----------------------------------------------------------------------
// Herkunft: BajKasum/promptprinter-pp, skill/pp/scripts/context.mjs auf main bei Commit
// 2e3e545f75475e68f60faf5b42f01061c23845a9 (Skill 0.4.0, Skript 0.2.0), MIT. Nie eine ältere Fassung:
// Skill 0.3.0 liess Geheimnisse durch. Gegenüber der Quelle geändert sind nur dieser Kopf und `export`
// vor renderPack, damit das Programm den Kontext ohne Kindprozess baut. Die Prüfsumme der Quelle steht
// in contract/context-pin.json: test/context.test.mjs prüft, dass diese Datei bis auf die zwei Stellen
// der Quelle entspricht, `npm run contract` meldet, wenn sich die Quelle auf main ändert.
// ---- Ende der Herkunft -------------------------------------------------------------------------------
// Kontext-Skript des Skills /pp: sammelt Fakten aus Git und Dateien, prüft einen Auftrag, legt ihn ab.
//   node context.mjs <pack|search|check|save|doctor> [Optionen]
//
// Regeln, die der Test festhält:
//   - keine Abhängigkeiten, kein Netzwerk (kein Import von net, http, https, dns, kein fetch)
//   - Git nur über execFileSync mit Argumentliste, nie über eine Shell
//   - jede Ausgabezeile läuft durch das Schwärzen (emit)
//   - schreibt nur bei `save`, und nur unter <Wurzel>/.promptprinter/prompts/
//   - endet immer mit Exit-Code 0; ein Fehler ist eine Zeile "hint: ..."

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VERSION = "0.2.0";
const SCHEMA = "pp-context/1";
const MAX_STDIN = 200 * 1024;
const PACK_BUDGET_MS = 2500;
const SEARCH_BUDGET_MS = 1500;
const GIT_TIMEOUT_MS = 3000;
const PACK_MAX_CHARS = 5000;

const state = { debug: false, hints: [], gitMissing: false };

function hint(message) {
  if (!state.hints.includes(message)) state.hints.push(message);
}

function dbg(...parts) {
  if (state.debug) process.stderr.write(`${parts.join(" ")}\n`);
}

// ---------------------------------------------------------------- Schwärzen

// Reihenfolge zählt: der Anthropic-Schlüssel vor dem allgemeinen sk-.
const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["api key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["github token", /\bgithub_pat_[A-Za-z0-9_]{30,}/g],
  ["aws key", /\bAKIA[0-9A-Z]{16}/g],
  ["google key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["supabase key", /\bsb_secret_[A-Za-z0-9_-]{16,}/g],
  ["supabase token", /\bsbp_[A-Za-z0-9]{20,}/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}/g],
  ["gitlab token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["webhook secret", /\bwhsec_[A-Za-z0-9+/=_-]{20,}/g],
  ["hugging face token", /\bhf_[A-Za-z0-9]{30,}/g],
  // Die Ziffer trennt ein Token von einem langen Bezeichner im Fliesstext ("Bearer createClientForRequest").
  ["bearer token", /\bBearer\s+(?=[^\s]*\d)[A-Za-z0-9._~+/-]{20,}=*/gi],
  // Platzhalter wie user:password@ und ${PASS} sind kein Geheimnis.
  ["url credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+:(?![$<{[%]|(?:pass|password|changeme|secret|x+)@)[^\s/@"']+@/gi],
];
// Der Schlüsselname muss auf das Stichwort enden: AWS_SECRET_ACCESS_KEY zählt, TOKEN_URL und max_tokens nicht.
const ASSIGNMENT = /((?:secret(?:[_-]?(?:access[_-]?)?key)?(?:[_-]?base)?|token|password|passwd|pwd|credentials?|api[_-]?key|private[_-]?key|access[_-]?key|encryption[_-]?key|service[_-]?role[_-]?key|signing[_-]?key|auth[_-]?key)["']?\s*[:=]\s*["']?)([^\s"']{12,})/gi;
// Werte, die auf eine Quelle zeigen oder Code sind, und kein Geheimnis. Ein Passwort kann mit $ beginnen,
// deshalb zählen nur ${...} und $NAME_IN_GROSS als Verweis.
const NOT_A_VALUE = /^(?:\$\{|\$[A-Z_][A-Z0-9_]*[;,)]*$|<|\[|\{|%|process\.env|os\.environ|(?:env|ENV)\.|import\.meta)|\(/;

// Der Körper eines privaten Schlüssels und ähnliche Blöcke: lang, gemischt aus Gross, Klein und Ziffern. Git-Hashes
// haben keine Grossbuchstaben, Pfade haben viele Schrägstriche; beide bleiben stehen.
const LONG_ENCODED = /[A-Za-z0-9+/]{40,}={0,2}/g;
const looksEncoded = (value) =>
  /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && (value.match(/\//g)?.length ?? 0) * 16 <= value.length;

export function redactText(text) {
  let out = String(text);
  for (const [kind, pattern] of SECRET_PATTERNS) out = out.replace(pattern, `[redacted: ${kind}]`);
  out = out.replace(ASSIGNMENT, (whole, head, value) =>
    NOT_A_VALUE.test(value) ? whole : `${head}[redacted: assignment]`,
  );
  return out.replace(LONG_ENCODED, (value) => (looksEncoded(value) ? "[redacted: long encoded value]" : value));
}

// Nur Art und Zeile, nie der Wert.
export function findSecrets(text) {
  const found = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      // Ein Fund je Zeile genügt: der Fehler nennt Art und Zeile, nie den Wert.
      const hit = SECRET_PATTERNS.find(([, pattern]) => {
        pattern.lastIndex = 0;
        return pattern.test(line);
      });
      if (hit) return found.push({ kind: hit[0], line: index + 1 });
      ASSIGNMENT.lastIndex = 0;
      if ([...line.matchAll(ASSIGNMENT)].some((match) => !NOT_A_VALUE.test(match[2]))) {
        return found.push({ kind: "assignment", line: index + 1 });
      }
      if ((line.match(LONG_ENCODED) ?? []).some(looksEncoded)) found.push({ kind: "long encoded value", line: index + 1 });
    });
  return found;
}

export function isDeniedPath(path, config) {
  const clean = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = clean.split("/");
  const base = segments.at(-1).toLowerCase();
  if (segments.some((s) => s === ".git" || s === ".aws" || s === ".ssh" || s === ".kube" || s === ".secrets")) return true;
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return true;
  if (base === ".dev.vars" || base === ".envrc" || base === ".git-credentials" || base === "kubeconfig" || base === "wp-config.php") return true;
  if (/\.(pem|key|p12|pfx|tfstate|tfvars)$/.test(base)) return true;
  if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;
  if (base === ".npmrc" || base === ".pypirc" || base === ".netrc") return true;
  if (base.startsWith("credentials") || base.startsWith("secrets.")) return true;
  if (/(^|[-_.])service[-_]?account[^/]*\.json$|-adminsdk[^/]*\.json$|[-_]credentials[^/]*\.json$|^appsettings\.production[^/]*\.json$/.test(base)) return true;
  if (segments.at(-2) === "secrets" && /\.(ya?ml|json|env|txt)$/.test(base)) return true;
  if (segments.at(-2) === ".docker" && base === "config.json") return true;
  return (config?.denyPaths ?? []).some((prefix) => clean.startsWith(prefix));
}

// Pathspecs für `git grep`, damit gesperrte Dateien gar nicht erst gelesen werden.
const DENY_PATHSPECS = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*",
  "**/id_ed25519*", "**/.npmrc", "**/.pypirc", "**/.netrc", "**/credentials*", "**/secrets.*",
  "**/*.tfstate", "**/*.tfvars", "**/.dev.vars", "**/.envrc", "**/.git-credentials", "**/kubeconfig",
  "**/wp-config.php", "**/*service-account*.json", "**/*service_account*.json", "**/*-adminsdk*.json",
  "**/*-credentials*.json", "**/*_credentials*.json", "**/appsettings.[Pp]roduction*.json",
  "**/secrets/*.yml", "**/secrets/*.yaml", "**/secrets/*.json", "**/secrets/*.env", "**/secrets/*.txt",
  "**/.docker/config.json", "**/.kube/**", "**/.secrets/**", ".aws/**", ".ssh/**", ".promptprinter/**",
];
const NOISE_PATHSPECS = [
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/Cargo.lock", "**/poetry.lock",
  "**/go.sum", "dist/**", "build/**", ".next/**", "out/**", "coverage/**", "vendor/**",
  "**/*.min.*", "**/*.map",
];
const NOISE_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|(^|\/)(dist|build|\.next|out|coverage|vendor)\/|\.min\.[^/]+$|\.map$/;

function emit(text) {
  const lines = String(text).split("\n").map(redactText);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------- Hilfen

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--debug") options.debug = true;
    else if (arg === "--version") options.version = true;
    else if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) options[arg.slice(2)] = true;
      else {
        options[arg.slice(2)] = next;
        i++;
      }
    } else options._.push(arg);
  }
  return options;
}

const toPosix = (p) => String(p).replaceAll("\\", "/");

// Git meldet die Wurzel mit aufgelösten Links (macOS: /private/var statt /var, Windows: lange statt kurzer Namen).
// Der Arbeitsordner wird genauso aufgelöst, sonst lässt sich der Weg von der Wurzel zu ihm nicht berechnen.
function real(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const gitArgs = (args) => ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args];
const gitOptions = (cwd, timeoutMs) => ({
  cwd,
  encoding: "utf8",
  timeout: timeoutMs,
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
});

function gitFailed(error, args, cwd) {
  if (error.code === "ENOENT" && cwd && !existsSync(cwd)) {
    hint(`folder not found: ${toPosix(cwd)}`);
    return null;
  }
  if (error.code === "ENOENT") {
    state.gitMissing = true;
    hint("git not found: facts come from the file system only");
    return null;
  }
  if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM" || error.killed) {
    hint(`git ${args[0]} timed out and was skipped`);
    return null;
  }
  // Ausstieg ungleich 0 ist bei `git grep` ohne Treffer normal.
  return typeof error.stdout === "string" ? error.stdout : null;
}

function git(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  if (state.gitMissing) return null;
  try {
    const out = execFileSync("git", gitArgs(args), gitOptions(cwd, timeoutMs));
    dbg("git", args.slice(0, 3).join(" "), "ok");
    return out;
  } catch (error) {
    return gitFailed(error, args, cwd);
  }
}

// Unabhängige Git-Aufrufe der Suche laufen nebeneinander: der Prozessstart kostet unter Windows je rund 100 ms.
async function gitAsync(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  if (state.gitMissing) return null;
  try {
    const { stdout } = await execFileAsync("git", gitArgs(args), gitOptions(cwd, timeoutMs));
    dbg("git", args.slice(0, 3).join(" "), "ok");
    return stdout;
  } catch (error) {
    return gitFailed(error, args, cwd);
  }
}

const MANIFESTS = [
  "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "composer.json",
  "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "pubspec.yaml", "Package.swift",
];

function findRoot(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (top) return { root: real(top), isGit: true, none: false };
  let dir = real(cwd);
  for (;;) {
    if (MANIFESTS.some((name) => existsSync(join(dir, name)))) return { root: dir, isGit: false, none: false };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  hint("no project detected: facts are limited to the working folder");
  return { root: real(cwd), isGit: false, none: true };
}

const WALK_SKIP = new Set([
  ".git", "node_modules", "dist", "build", ".next", "out", "coverage", "vendor", "__pycache__",
  ".venv", "venv", "target", ".gradle", ".idea", ".promptprinter",
]);

function walk(root, limit = 20000) {
  const files = [];
  const stack = [""];
  while (stack.length && files.length < limit) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(path);
      } else if (entry.isFile()) files.push(path);
      if (files.length >= limit) break;
    }
  }
  if (files.length >= limit) hint(`file walk stopped at ${limit} files`);
  return files;
}

// Alle Dateien, die Git kennt oder die neu und nicht ignoriert sind (neue Dateien zählen).
const LS_FILES = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];

function listFiles(root, isGit) {
  return finishFileList(root, isGit ? git(root, LS_FILES) : null);
}

function finishFileList(root, lsOutput) {
  let files = null;
  if (lsOutput != null) files = lsOutput.split("\0").filter(Boolean).map(toPosix);
  files ??= walk(root);
  const unique = [...new Set(files)].filter((f) => !f.startsWith(".promptprinter/"));
  return unique.length > 100000 ? unique.slice(0, 100000) : unique.filter((f) => existsSync(join(root, f)));
}

function loadConfig(root) {
  const config = { denyPaths: [], language: null, target: null, budgets: null };
  const path = join(root, ".promptprinter", "config.json");
  if (!existsSync(path)) return config;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    for (const key of Object.keys(json)) {
      if (!(key in config)) hint(`unknown key in .promptprinter/config.json: ${key}`);
    }
    if (Array.isArray(json.denyPaths)) config.denyPaths = json.denyPaths.filter((p) => typeof p === "string" && p);
    if (typeof json.language === "string") config.language = json.language;
    if (typeof json.target === "string") config.target = json.target;
    if (json.budgets && typeof json.budgets === "object") config.budgets = json.budgets;
  } catch {
    hint("invalid .promptprinter/config.json: defaults used");
  }
  return config;
}

function localIso(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function cut(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function readText(path, maxBytes = 200 * 1024) {
  try {
    if (statSync(path).size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return "";
  } catch {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let total = 0;
  let retries = 0;
  for (;;) {
    let n;
    try {
      n = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EAGAIN" && retries++ < 200) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      break;
    }
    if (n === 0) break;
    total += n;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    if (total >= MAX_STDIN) {
      hint("input cut at 200 KB");
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_STDIN);
}

// Wie extractPrompt im Haupt-Repo: der beste ```text-Block, sonst der ganze Text.
export function extractOrder(text) {
  const blocks = [...String(text).matchAll(/^```text[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
  if (!blocks.length) return String(text).trim();
  return blocks.sort((a, b) => b.length - a.length)[0].trim();
}

const countBy = (items, keyOf) => {
  const map = new Map();
  for (const item of items) map.set(keyOf(item), (map.get(keyOf(item)) ?? 0) + 1);
  return map;
};

// ---------------------------------------------------------------- Manifeste

const FRAMEWORKS = [
  "next", "react", "vue", "nuxt", "svelte", "@sveltejs/kit", "astro", "@remix-run/react", "express",
  "fastify", "hono", "@nestjs/core", "@angular/core", "vite", "tailwindcss", "typescript", "vitest",
  "jest", "@playwright/test", "cypress", "prisma", "drizzle-orm", "@supabase/supabase-js", "electron",
  "expo", "react-native", "django", "flask", "fastapi", "pytest",
];
const TEST_FRAMEWORKS = ["vitest", "jest", "mocha", "ava", "@playwright/test", "playwright", "cypress", "pytest"];

const major = (range) => String(range ?? "").match(/\d+/)?.[0] ?? "";

function manifestDeps(name, text) {
  const deps = [];
  const add = (dep, version) => dep && deps.push({ name: dep, version: major(version) });
  try {
    if (name === "package.json" || name === "composer.json") {
      const json = JSON.parse(text);
      const groups = name === "package.json"
        ? [json.dependencies, json.devDependencies]
        : [json.require, json["require-dev"]];
      for (const group of groups) {
        for (const [dep, version] of Object.entries(group ?? {})) {
          if (name === "composer.json" && (dep === "php" || dep.startsWith("ext-"))) continue;
          add(dep, version);
        }
      }
    } else if (name === "requirements.txt") {
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(?:[=<>~!]=?\s*([0-9][^\s;#,]*))?/);
        if (match && !line.startsWith("-")) add(match[1].toLowerCase(), match[2]);
      }
    } else if (name === "pyproject.toml") {
      const array = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
      for (const quoted of array.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)[^"']*["']/g)) add(quoted[1].toLowerCase());
      const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
      for (const line of poetry.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["{]?[^"\d]*([\d.]*)/);
        if (match && match[1] !== "python") add(match[1].toLowerCase(), match[2]);
      }
    } else if (name === "go.mod") {
      let inBlock = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^require\s*\(/.test(line)) inBlock = true;
        else if (inBlock && line.trim() === ")") inBlock = false;
        else {
          const match = line.match(/^\s*(?:require\s+)?([\w.\-/]+)\s+v([\d.]+)/);
          if (match && (inBlock || line.startsWith("require"))) add(match[1], match[2]);
        }
      }
    } else if (name === "Cargo.toml") {
      let inDeps = false;
      for (const line of text.split(/\r?\n/)) {
        const section = line.match(/^\[(.+)\]\s*$/);
        if (section) inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(section[1]);
        else if (inDeps) {
          const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")?/);
          if (match) add(match[1], match[2] ?? match[3]);
        }
      }
    } else if (name === "Gemfile") {
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([~><= ]*[\d.]+)['"])?/gm)) add(m[1], m[2]);
    } else if (name === "pubspec.yaml") {
      let inDeps = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\S/.test(line)) inDeps = /^(dev_)?dependencies:/.test(line);
        else if (inDeps) {
          const match = line.match(/^ {2}([A-Za-z0-9_]+):\s*(\S*)/);
          if (match && match[1] !== "flutter") add(match[1], match[2]);
        }
      }
    } else if (name === "pom.xml") {
      for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
        const id = m[1].match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
        add(id, m[1].match(/<version>([^<]+)<\/version>/)?.[1]);
      }
    } else if (name.startsWith("build.gradle")) {
      for (const m of text.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^:"']+):([^:"']+)(?::([^"']+))?["']/g)) add(`${m[1]}:${m[2]}`, m[3]);
    } else if (name === "Package.swift") {
      for (const m of text.matchAll(/\.package\(\s*url:\s*"[^"]*\/([^"/]+?)(?:\.git)?"/g)) add(m[1]);
    }
  } catch {
    hint(`${name} could not be parsed`);
  }
  return deps;
}

function manifestScripts(name, text) {
  try {
    if (name === "package.json") return Object.keys(JSON.parse(text).scripts ?? {});
    if (name === "Makefile") {
      return [...text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)].map((m) => m[1]);
    }
  } catch {
    hint(`${name} could not be parsed`);
  }
  return [];
}

function manifestDirs(root, cwd) {
  const dirs = [root];
  let dir = resolve(cwd);
  const stop = resolve(root);
  while (dir.startsWith(stop) && dir !== stop) {
    if (MANIFESTS.some((name) => existsSync(join(dir, name)))) {
      dirs.push(dir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

// ---------------------------------------------------------------- Regeldateien

const RULE_CANDIDATES = [
  "CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md",
  ".cursorrules", ".github/copilot-instructions.md", "CONTRIBUTING.md", "SECURITY.md", ".editorconfig",
];

function ruleFiles(root, cwd, host) {
  const dirs = [root];
  const rel = relative(root, resolve(cwd));
  if (rel && !rel.startsWith("..")) {
    let current = root;
    for (const part of rel.split(/[\\/]/)) dirs.push((current = join(current, part)));
  }
  const found = [];
  for (const dir of dirs) {
    for (const candidate of RULE_CANDIDATES) {
      const full = join(dir, candidate);
      if (existsSync(full) && statSync(full).isFile()) found.push(full);
    }
    for (const folder of [".claude/rules", ".cursor/rules"]) {
      try {
        for (const entry of readdirSync(join(dir, folder), { withFileTypes: true })) {
          if (entry.isFile()) found.push(join(dir, folder, entry.name));
        }
      } catch {
        /* Ordner fehlt */
      }
    }
  }
  const claudeMd = (p) => /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|\.claude\/CLAUDE\.md)$/.test(toPosix(p));
  const hasClaude = found.some(claudeMd);
  const hasAgents = found.some((p) => /(^|\/)AGENTS(\.override)?\.md$/.test(toPosix(p)));
  const dirsWithOverride = new Set(found.filter((p) => basename(p) === "AGENTS.override.md").map(dirname));

  const rules = found.map((full) => {
    const path = toPosix(relative(root, full));
    const sizeBytes = statSync(full).size;
    const name = basename(full);
    let loadedByHost = "unknown";
    let warning;
    if (host === "claude") {
      if (claudeMd(full) || path.startsWith(".claude/rules/")) loadedByHost = "yes";
      else if (name === "AGENTS.md" || name === "AGENTS.override.md") {
        loadedByHost = hasClaude ? "no" : "yes";
        if (hasClaude) warning = "Claude Code does not read AGENTS.md when a CLAUDE.md is present";
      } else loadedByHost = "no";
    } else if (host === "codex") {
      if (name === "AGENTS.override.md") loadedByHost = "yes";
      else if (name === "AGENTS.md") loadedByHost = dirsWithOverride.has(dirname(full)) ? "no" : "yes";
      else {
        loadedByHost = "no";
        if (claudeMd(full) && !hasAgents) warning = "Codex does not read CLAUDE.md";
      }
    }
    return warning ? { path, sizeBytes, loadedByHost, warning } : { path, sizeBytes, loadedByHost };
  });
  if (host === "codex") {
    const total = rules.filter((r) => r.loadedByHost === "yes").reduce((sum, r) => sum + r.sizeBytes, 0);
    if (total > 32 * 1024) hint("Codex cuts rule files above 32 KiB: the rules may be truncated");
  }
  return rules;
}

// ---------------------------------------------------------------- pack

const TEST_FILE = /\.(test|spec)\.[^.]+$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/;
const isTestFile = (path) => TEST_FILE.test(path);

const TEST_COMMANDS = { npm: "npm run test", pnpm: "pnpm test", yarn: "yarn test", bun: "bun run test" };
const LOCKFILES = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];

// Der Eintrag `packageManager` in package.json geht vor dem Lockfile; ohne beides bleibt npm.
function packageManager(root) {
  const text = readText(join(root, "package.json"));
  if (text == null) return null;
  try {
    const declared = String(JSON.parse(text).packageManager ?? "").split("@")[0];
    if (TEST_COMMANDS[declared]) return declared;
  } catch {
    /* kaputtes package.json meldet schon manifestDeps */
  }
  return LOCKFILES.find(([file]) => existsSync(join(root, file)))?.[1] ?? "npm";
}

function buildStructure(files) {
  const top = new Map();
  const rootFiles = [];
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length === 1) {
      rootFiles.push(file);
      continue;
    }
    const entry = top.get(parts[0]) ?? { files: 0, children: new Map() };
    entry.files++;
    if (parts.length > 2) entry.children.set(parts[1], (entry.children.get(parts[1]) ?? 0) + 1);
    else entry.children.set(".", (entry.children.get(".") ?? 0) + 1);
    top.set(parts[0], entry);
  }
  const structure = [];
  for (const [name, entry] of [...top].sort((a, b) => a[0].localeCompare(b[0]))) {
    structure.push({ path: `${name}/`, files: entry.files });
    const children = [...entry.children].filter(([child]) => child !== ".").sort((a, b) => b[1] - a[1]);
    for (const [child, count] of children.slice(0, 12)) structure.push({ path: `${name}/${child}/`, files: count });
    if (children.length > 12) structure.push({ path: `${name}/ (+${children.length - 12} more)`, files: 0 });
  }
  return { structure, rootFiles: rootFiles.sort() };
}

function buildData(files, root) {
  const data = {};
  const migrations = files.filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f)).sort();
  if (migrations.length) {
    data.migrations = { count: migrations.length, first: basename(migrations[0]), last: basename(migrations.at(-1)) };
  }
  const otherMigrations = [...countBy(
    files.filter((f) => /(^|\/)migrations\/[^/]+$/.test(f) && !f.startsWith("supabase/migrations/")),
    (f) => dirname(f),
  )];
  if (otherMigrations.length) data.migrationFolders = otherMigrations.slice(0, 5).map(([dir, count]) => ({ dir, count }));
  const prisma = files.find((f) => /(^|\/)prisma\/schema\.prisma$/.test(f));
  if (prisma) {
    const text = readText(join(root, prisma)) ?? "";
    data.prismaModels = [...text.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
  }
  if (files.some((f) => /(^|\/)drizzle\.config\.[^/]+$/.test(f))) data.drizzle = true;
  const routes = files.filter((f) => /(^|\/)app\/(.*\/)?route\.[jt]sx?$/.test(f) || /(^|\/)pages\/api\//.test(f));
  if (routes.length) data.routes = routes.sort();
  const openapi = files.filter((f) => /(^|\/)openapi[^/]*\.(json|ya?ml)$/i.test(f));
  if (openapi.length) data.openapi = openapi;
  const graphql = files.filter((f) => /\.(graphql|gql)$/.test(f));
  if (graphql.length) data.graphql = graphql.slice(0, 10);
  return data;
}

export function buildPack(cwd, host = "claude") {
  const started = Date.now();
  const overBudget = () => Date.now() - started > PACK_BUDGET_MS;
  const { root, isGit, none } = findRoot(cwd);
  const here = real(cwd);
  const config = loadConfig(root);
  const pack = {
    schema: SCHEMA,
    host,
    generatedAt: localIso(),
    root: toPosix(root),
    repo: { name: basename(root), branch: null, ahead: null, behind: null, dirty: false },
    status: [], statusMore: 0, diffStat: [], commits: [], stack: [], scripts: [], rules: [],
    structure: [], rootFiles: [], data: {}, tests: { files: 0, frameworks: [], command: null },
    ci: [], skipped: [], hints: state.hints,
  };
  if (none) {
    pack.hints.push("no project detected: only the folder name is known");
    return pack;
  }

  if (isGit) {
    let branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
    if (!branch) branch = git(root, ["symbolic-ref", "--short", "HEAD"])?.trim() ?? null;
    if (branch === "HEAD") branch = `(detached ${git(root, ["rev-parse", "--short", "HEAD"])?.trim() ?? "?"})`;
    pack.repo.branch = branch;
    const counts = git(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])?.trim().split(/\s+/);
    if (counts?.length === 2) {
      pack.repo.behind = Number(counts[0]);
      pack.repo.ahead = Number(counts[1]);
    }
    const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status != null) {
      const parts = status.split("\0").filter(Boolean);
      const entries = [];
      for (let i = 0; i < parts.length; i++) {
        const code = parts[i].slice(0, 2);
        entries.push({ code: code.trim() || code, path: toPosix(parts[i].slice(3)) });
        if (code[0] === "R" || code[0] === "C") i++;
      }
      pack.repo.dirty = entries.length > 0;
      pack.status = entries.filter((e) => !e.path.startsWith(".promptprinter/")).slice(0, 30);
      pack.statusMore = Math.max(0, entries.length - 30);
    }
    const hasCommit = git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
    const diff = hasCommit
      ? git(root, ["diff", "HEAD", "--stat=120", "--no-ext-diff", "--no-textconv"])
      : git(root, ["diff", "--cached", "--stat=120", "--no-ext-diff", "--no-textconv"]);
    pack.diffStat = (diff ?? "").split("\n").filter(Boolean).slice(0, 30);
    const log = hasCommit ? git(root, ["log", "-n", "10", "--format=%h%x09%s"]) : "";
    pack.commits = (log ?? "").split("\n").filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: cut(subject.join(" "), 72) };
    });
    if (!hasCommit) pack.hints.push("repository has no commit yet");
  }

  const files = overBudget() ? [] : listFiles(root, isGit);
  if (overBudget()) pack.skipped.push({ path: "(facts after the file list)", reason: "time limit reached" });

  const seen = new Set();
  const stack = [];
  const scripts = [];
  for (const dir of manifestDirs(root, here)) {
    for (const name of MANIFESTS) {
      const full = join(dir, name);
      if (!existsSync(full) || seen.has(full)) continue;
      seen.add(full);
      const text = readText(full);
      if (text == null) continue;
      const source = toPosix(relative(root, full)) || name;
      for (const dep of manifestDeps(name, text)) stack.push({ ...dep, source });
      if (name === "package.json") scripts.push(...manifestScripts(name, text));
    }
    const makefile = readText(join(dir, "Makefile"));
    if (makefile) scripts.push(...manifestScripts("Makefile", makefile).filter((t) => t !== "PHONY"));
  }
  const rank = (name) => {
    const index = FRAMEWORKS.indexOf(name);
    return index === -1 ? FRAMEWORKS.length : index;
  };
  const uniqueStack = [...new Map(stack.map((d) => [d.name, d])).values()];
  pack.stack = uniqueStack.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  pack.scripts = [...new Set(scripts)];

  pack.rules = ruleFiles(root, here, host);
  const built = buildStructure(files);
  pack.structure = built.structure;
  pack.rootFiles = built.rootFiles;
  pack.data = buildData(files, root);

  const names = new Set(pack.stack.map((d) => d.name));
  const testFiles = files.filter(isTestFile);
  const frameworks = TEST_FRAMEWORKS.filter((f) => names.has(f));
  const hasScript = (s) => pack.scripts.includes(s);
  const manager = packageManager(root);
  let command = null;
  if (hasScript("test")) command = TEST_COMMANDS[manager ?? "npm"];
  else if (names.has("pytest")) command = "pytest";
  else if (files.includes("go.mod")) command = "go test ./...";
  else if (files.includes("Cargo.toml")) command = "cargo test";
  pack.tests = { files: testFiles.length, frameworks: frameworks, command };
  pack.packageManager = manager;

  pack.ci = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((f) => basename(f));

  const denied = [];
  for (const candidate of [".env", ".env.local", ".env.production", ...files]) {
    if (isDeniedPath(candidate, config) && (files.includes(candidate) || existsSync(join(root, candidate)))) denied.push(candidate);
  }
  pack.skipped.push(...[...new Set(denied)].slice(0, 10).map((path) => ({ path, reason: "deny list: name only, never read" })));
  return pack;
}

export function renderPack(pack, level = 0) {
  const stackLimit = level >= 2 ? 15 : 25;
  const commitLimit = level >= 3 ? 5 : 10;
  const out = [];
  out.push(`# PP context pack 1 (${pack.schema})`);
  out.push(`host: ${pack.host} | generated: ${pack.generatedAt}`);
  const repo = pack.repo;
  const sync = repo.ahead == null ? "" : `, ${repo.ahead} ahead / ${repo.behind} behind upstream`;
  out.push(`\n## Repo\n${repo.name}${repo.branch ? `, branch ${repo.branch}` : ""}${sync}`);
  if (pack.status.length || pack.statusMore) {
    out.push(`\n## Working tree (${pack.status.length + pack.statusMore} changes)`);
    for (const e of pack.status) out.push(`${e.code.padEnd(2)} ${e.path}`);
    if (pack.statusMore) out.push(`(+${pack.statusMore})`);
  } else if (pack.repo.branch) out.push("\n## Working tree\nclean");
  if (pack.diffStat.length) out.push(`\n## Diff against HEAD\n${pack.diffStat.join("\n")}`);
  if (pack.commits.length) {
    out.push("\n## Last commits");
    for (const c of pack.commits.slice(0, commitLimit)) out.push(`${c.sha} ${c.subject}`);
  }
  if (pack.stack.length) {
    const shown = pack.stack.slice(0, stackLimit).map((d) => (d.version ? `${d.name} ${d.version}` : d.name));
    const more = pack.stack.length - shown.length;
    out.push(`\n## Stack (names and major versions)\n${shown.join(", ")}${more > 0 ? ` (+${more})` : ""}`);
  }
  if (pack.scripts.length) {
    const more = pack.scripts.length - 7;
    const runner = pack.packageManager ? ` (run with ${pack.packageManager})` : "";
    out.push(`\n## Scripts${runner}\n${pack.scripts.slice(0, 7).join(", ")}${more > 0 ? ` (+${more})` : ""}`);
  }
  if (pack.rules.length) {
    out.push("\n## Rule files");
    for (const r of pack.rules) {
      out.push(`- ${r.path} (${r.sizeBytes} B), loaded by ${pack.host}: ${r.loadedByHost}${r.warning ? `. WARNING: ${r.warning}` : ""}`);
    }
  } else out.push("\n## Rule files\nnone found");
  if (pack.structure.length || pack.rootFiles.length) {
    out.push("\n## Structure (git-tracked and new files)");
    for (const s of pack.structure) {
      if (level >= 1 && s.path.split("/").filter(Boolean).length > 1 && !s.path.includes("(+")) continue;
      out.push(`${"  ".repeat(s.path.replace(/ \(\+.*$/, "").split("/").filter(Boolean).length - 1)}${s.path}${s.files ? ` (${s.files})` : ""}`);
    }
    if (pack.rootFiles.length) {
      const more = pack.rootFiles.length - 12;
      out.push(`root files: ${pack.rootFiles.slice(0, 12).join(", ")}${more > 0 ? ` (+${more})` : ""}`);
    }
  }
  const d = pack.data;
  const dataLines = [];
  if (d.migrations) dataLines.push(`migrations: ${d.migrations.count} (${d.migrations.first} .. ${d.migrations.last})`);
  for (const f of d.migrationFolders ?? []) dataLines.push(`migrations folder: ${f.dir} (${f.count})`);
  if (d.prismaModels) dataLines.push(`prisma models: ${d.prismaModels.join(", ")}`);
  if (d.drizzle) dataLines.push("drizzle config present");
  if (d.routes) {
    const more = d.routes.length - 15;
    dataLines.push(`routes (${d.routes.length}): ${d.routes.slice(0, 15).join(", ")}${more > 0 ? ` (+${more})` : ""}`);
  }
  if (d.openapi) dataLines.push(`openapi: ${d.openapi.join(", ")}`);
  if (d.graphql) dataLines.push(`graphql: ${d.graphql.join(", ")}`);
  if (dataLines.length) out.push(`\n## Data model and API\n${dataLines.join("\n")}`);
  const t = pack.tests;
  if (t.files || t.command) {
    out.push(`\n## Tests\n${t.files} test files${t.frameworks.length ? `, ${t.frameworks.join(", ")}` : ""}${t.command ? `, command: ${t.command}` : ""}`);
  }
  if (pack.ci.length) out.push(`\n## CI\n${pack.ci.join(", ")}`);
  if (pack.skipped.length) {
    out.push("\n## Left out");
    for (const s of pack.skipped) out.push(`- ${s.path}: ${s.reason}`);
  }
  for (const h of pack.hints) out.push(`hint: ${h}`);
  return out.join("\n");
}

function cmdPack(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const host = ["claude", "codex", "vscode"].includes(options.host) ? options.host : "claude";
  if (options.host && host !== options.host) hint(`unknown host ${options.host}: claude assumed`);
  const pack = buildPack(cwd, host);
  if (options.format === "json") {
    const { statusMore, rootFiles, ...json } = pack;
    return emit(JSON.stringify({ ...json, status: pack.status, rootFiles }, null, 2));
  }
  let level = 0;
  let text = renderPack(pack, level);
  while (text.length > PACK_MAX_CHARS && level < 3) text = renderPack(pack, ++level);
  if (text.length > PACK_MAX_CHARS) text += `\nhint: pack is ${text.length} characters, above the target of ${PACK_MAX_CHARS}`;
  emit(text);
}

// ---------------------------------------------------------------- search

const SIZE_LIMITS = { S: 5, M: 10, L: 15, XL: 15 };

export function cleanTerms(raw) {
  const notes = [];
  const terms = [];
  for (const part of String(raw ?? "").split(",")) {
    const cleaned = part.replace(/[^\p{L}\p{N}_.\-/: ]/gu, "").trim();
    if (cleaned !== part.trim()) notes.push(`characters removed from term "${cut(part, 30)}"`);
    if (cleaned.length < 2 || cleaned.length > 64) {
      if (part.trim()) notes.push(`term "${cut(part, 30)}" skipped: needs 2 to 64 characters`);
      continue;
    }
    if (!terms.includes(cleaned)) terms.push(cleaned);
  }
  if (terms.length > 12) notes.push("more than 12 terms: the first 12 are used");
  return { terms: terms.slice(0, 12), notes };
}

const looksLikeIdentifier = (term) => !/\s/.test(term) && /[._]|[a-z][A-Z]/.test(term);

function grepExcludes() {
  return [...DENY_PATHSPECS, ...NOISE_PATHSPECS].map((glob) => `:(exclude,glob)${glob}`);
}

function parseGrepCount(out) {
  const counts = new Map();
  for (const line of (out ?? "").split("\n")) {
    const at = line.lastIndexOf("\0");
    if (at === -1) continue;
    counts.set(toPosix(line.slice(0, at)), Number(line.slice(at + 1)));
  }
  return counts;
}

// Führt Aufgaben mit höchstens n gleichzeitig aus, Ergebnisse in Eingabereihenfolge.
async function pool(tasks, n = 6) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

// Tests, die zu einer Quelldatei gehören: gleicher Stamm im Namen (foo.ts, foo.test.ts, test_foo.py, foo_test.go).
// Allgemeine Stämme (index, route, page ...) zählen nur im selben Ordnerbaum, sonst hängt jeder Test an jeder Datei.
const GENERIC_STEMS = new Set(["index", "route", "page", "layout", "main", "mod", "utils", "util", "types", "config", "lib"]);
const testStem = (path) =>
  basename(path).replace(/\.(test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "").replace(/^test_/, "").replace(/_test$/, "").toLowerCase();

export function relatedTests(path, files) {
  const stem = testStem(path);
  const dir = dirname(path);
  return files
    .filter((f) => f !== path && isTestFile(f) && testStem(f) === stem)
    .filter((f) => !GENERIC_STEMS.has(stem) || dirname(f).startsWith(dir) || dir.startsWith(dirname(f)))
    .sort((a, b) => (dirname(a) === dir ? -1 : 0) - (dirname(b) === dir ? -1 : 0) || a.localeCompare(b))
    .slice(0, 3);
}

function mergeCounts(perFile, term, out, config) {
  for (const [path, count] of parseGrepCount(out)) {
    if (isDeniedPath(path, config) || NOISE_FILE.test(path)) continue;
    const entry = perFile.get(path) ?? new Map();
    entry.set(term, count);
    perFile.set(path, entry);
  }
}

export async function searchRepo(cwd, rawTerms, size = "M", task = null) {
  const started = Date.now();
  const left = () => Math.max(300, SEARCH_BUDGET_MS - (Date.now() - started));
  const { terms, notes } = cleanTerms(rawTerms);
  for (const note of notes) hint(note);
  const { root, isGit, none } = findRoot(cwd);
  const config = loadConfig(root);
  const result = { schema: SCHEMA, terms, size, results: [], shared: [], hints: state.hints };
  if (!terms.length) {
    hint("search needs --terms with 1 to 12 terms");
    return result;
  }
  const limit = SIZE_LIMITS[size] ?? 10;
  const lower = terms.map((t) => t.toLowerCase());
  const perFile = new Map();
  const sharedTerms = terms.filter(looksLikeIdentifier);
  const changed = new Set();
  let files = [];
  const sharedCounts = new Map();

  if (isGit) {
    // Alles, was nicht voneinander abhängt, läuft in einer Welle.
    const counted = (term) => () => gitAsync(root, ["grep", "--untracked", "-I", "-i", "-c", "-z", "-F", "-e", term, "--", ".", ...grepExcludes()], left());
    const listed = (term) => () => gitAsync(root, ["grep", "--untracked", "-I", "-l", "-z", "-F", "-e", term, "--", ".", ...grepExcludes()], left());
    const outputs = await pool([
      () => gitAsync(root, LS_FILES, left()),
      () => gitAsync(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], left()),
      () => gitAsync(root, ["log", "-n", "20", "--name-only", "--format="], left()),
      ...terms.map(counted),
      ...sharedTerms.map(listed),
    ]);
    files = finishFileList(root, outputs[0]);
    const parts = (outputs[1] ?? "").split("\0").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      changed.add(toPosix(parts[i].slice(3)));
      if (parts[i][0] === "R" || parts[i][0] === "C") i++;
    }
    for (const line of (outputs[2] ?? "").split("\n")) if (line) changed.add(toPosix(line));
    terms.forEach((term, i) => mergeCounts(perFile, term, outputs[3 + i], config));
    sharedTerms.forEach((term, i) => {
      const used = (outputs[3 + terms.length + i] ?? "").split("\0").map((s) => s.trim()).filter(Boolean).filter((p) => !isDeniedPath(p, config) && !NOISE_FILE.test(p));
      sharedCounts.set(term, used.length);
    });
  } else {
    // Ohne Git: Durchlauf mit fester Ignorierliste, Dateien über 200 KB und Binärdateien übersprungen.
    files = none ? [] : listFiles(root, false);
    for (const path of files) {
      if (Date.now() - started > SEARCH_BUDGET_MS) {
        hint("search time limit reached: the walk stopped early");
        break;
      }
      if (isDeniedPath(path, config) || NOISE_FILE.test(path)) continue;
      const text = readText(join(root, path));
      if (text == null || text.includes("\0")) continue;
      const hay = text.toLowerCase();
      for (const term of terms) {
        const needle = term.toLowerCase();
        let count = 0;
        for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) count++;
        if (count) {
          const entry = perFile.get(path) ?? new Map();
          entry.set(term, count);
          perFile.set(path, entry);
        }
      }
    }
    for (const term of sharedTerms) sharedCounts.set(term, [...perFile].filter(([, counts]) => counts.has(term)).length);
  }

  // Dateien, deren Pfad einen Begriff trägt, zählen auch ohne Treffer im Inhalt.
  for (const path of files) {
    if (isDeniedPath(path, config) || NOISE_FILE.test(path)) continue;
    if (lower.some((t) => path.toLowerCase().includes(t)) && !perFile.has(path)) perFile.set(path, new Map());
  }

  const penalizeTests = task !== "bugfix" && task !== "refactor";
  const scored = [...perFile].map(([path, counts]) => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const pathHit = lower.some((t) => path.toLowerCase().includes(t));
    const isChanged = changed.has(path);
    const test = isTestFile(path);
    const score = 4 * (pathHit ? 1 : 0) + counts.size * Math.log2(1 + total) + 2 * (isChanged ? 1 : 0) - (test && penalizeTests ? 1 : 0);
    return { path, score: Math.round(score * 10) / 10, terms: [...counts.keys()], hits: total, changed: isChanged, test, lines: [] };
  });
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const top = scored.slice(0, limit);
  for (const r of top) r.relatedTests = r.test ? [] : relatedTests(r.path, files);

  if (top.length && isGit) {
    const args = ["grep", "--untracked", "-n", "-I", "-i", "-F", "-m", "3"];
    for (const term of terms) args.push("-e", term);
    args.push("--", ...top.map((r) => r.path));
    const out = (await gitAsync(root, args, left())) ?? "";
    for (const line of out.split("\n")) {
      const owner = top.find((r) => line.startsWith(`${r.path}:`));
      const match = owner && line.slice(owner.path.length + 1).match(/^(\d+):(.*)$/);
      if (match && owner.lines.length < 3) owner.lines.push({ n: Number(match[1]), text: cut(match[2], 160) });
    }
  } else if (top.length) {
    for (const r of top) {
      const text = readText(join(root, r.path)) ?? "";
      text.split(/\r?\n/).forEach((line, index) => {
        if (r.lines.length < 3 && lower.some((t) => line.toLowerCase().includes(t))) r.lines.push({ n: index + 1, text: cut(line, 160) });
      });
    }
  }
  result.results = top;
  // Geteilte Bezeichner: in wie vielen Dateien steht der Begriff? Der Auftrag muss sagen, ob alle Stellen gemeint sind.
  for (const [term, used] of sharedCounts) if (used) result.shared.push({ term, files: used });
  if (Date.now() - started > SEARCH_BUDGET_MS) hint(`search took ${Date.now() - started} ms, above the target of ${SEARCH_BUDGET_MS} ms`);
  return result;
}

async function cmdSearch(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const size = ["S", "M", "L", "XL"].includes(String(options.size).toUpperCase()) ? String(options.size).toUpperCase() : "M";
  const result = await searchRepo(cwd, options.terms, size, typeof options.task === "string" ? options.task : null);
  if (options.format === "json") return emit(JSON.stringify(result, null, 2));
  const out = [`# PP search 1 (${SCHEMA})`, `terms: ${result.terms.join(", ")} | size ${size}`];
  if (!result.results.length) out.push("no candidates found");
  result.results.forEach((r, i) => {
    out.push(`${i + 1}. ${r.path} (score ${r.score}; ${r.terms.length ? r.terms.join(", ") : "path match"}; ${r.hits} hits${r.changed ? "; changed recently" : ""}${r.test ? "; test file" : ""})`);
    for (const line of r.lines) out.push(`   ${line.n}: ${line.text}`);
    if (r.relatedTests?.length) out.push(`   tests: ${r.relatedTests.join(", ")}`);
  });
  if (result.shared.length) {
    out.push("\nShared identifiers (say in the order whether all places or only one are meant):");
    for (const s of result.shared) out.push(`- ${s.term}: used in ${s.files} files`);
  }
  for (const h of result.hints) out.push(`hint: ${h}`);
  emit(out.join("\n"));
}

// ---------------------------------------------------------------- check

const CORRIDORS = { S: [50, 150], M: [150, 450], L: [350, 900], XL: [600, 1500] };
const KNOWN_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sql|py|go|rs|java|kt|rb|php|yml|yaml|toml|html|sh|ps1|cs|swift|vue|svelte|astro|prisma|graphql|env|txt|cfg|ini|xml|gradle|lock";
const PATH_SHAPE = /^(?:\.{1,2}\/|@\/)?[\w.\-[\]()]+(?:\/[\w.\-[\]()]+)*\/?$/;

export function extractPathCandidates(text) {
  const withoutFences = String(text).replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, " ");
  const found = [];
  for (const rawToken of withoutFences.split(/\s+/)) {
    let token = rawToken.replace(/^[`'"([]+/, "").replace(/[`'")\],;:!?]+$/, "");
    token = token.replace(/:\d+(?:-\d+)?$/, "").replace(/\.+$/, "");
    if (!token || /[*{}<>$|=]|:\/\/|^-|^~|^[a-z]+:$/.test(token)) continue;
    if (!PATH_SHAPE.test(token)) continue;
    const last = token.split("/").at(-1);
    const hasExt = new RegExp(`\\.(${KNOWN_EXT})$`, "i").test(last);
    const hasSlash = token.includes("/");
    if (!hasExt && !hasSlash) continue;
    if (/^\d+(\/\d+)+$/.test(token)) continue;
    found.push({ token, hasExt });
  }
  return found;
}

export function checkOrder(rawInput, cwd, size = "M") {
  const result = { schema: SCHEMA, size, errors: [], warnings: [], hints: [], words: 0 };
  const { root, isGit, none } = findRoot(cwd);
  const order = extractOrder(rawInput);
  if (!order.trim()) {
    result.hints.push("no input: pipe the work order into the check");
    return result;
  }

  for (const s of findSecrets(rawInput)) result.errors.push(`secret pattern (${s.kind}) in line ${s.line}: remove it`);

  const files = none ? new Set() : new Set(listFiles(root, isGit));
  const dirs = new Set([...files].flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
  const tops = new Set([...files].map((f) => f.split("/")[0]));
  const missing = [];
  for (const { token, hasExt } of extractPathCandidates(order)) {
    const clean = token.replace(/^\.\//, "").replace(/\/$/, "");
    const aliased = clean.startsWith("@/") ? [`src/${clean.slice(2)}`, clean.slice(2)] : [clean];
    const firstExists = tops.has(clean.split("/")[0]) || aliased.some((a) => tops.has(a.split("/")[0]));
    if (!hasExt && !firstExists) continue;
    const exists = aliased.some((a) => files.has(a) || dirs.has(a) || existsSync(join(root, a)) || existsSync(join(cwd, a)))
      || (!clean.includes("/") && [...files].some((f) => basename(f) === clean));
    if (!exists && !missing.includes(token)) missing.push(token);
  }
  for (const m of missing.slice(0, 20)) result.hints.push(`not found: ${m}. If it is new, mark it as new in the order`);

  result.words = order.split(/\s+/).filter(Boolean).length;
  const [low, high] = CORRIDORS[size] ?? CORRIDORS.M;
  if (result.words < low || result.words > high) {
    result.warnings.push(`length ${result.words} words is outside the corridor ${low} to ${high} for size ${size}`);
  }

  const prose = order.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, " ").replace(/`[^`\n]*`/g, " ");
  const placeholders = [...prose.matchAll(/\[[A-Za-z][^\]\n]{2,60}\](?!\()/g)].map((m) => m[0]);
  if (placeholders.length && !/assum|annahme|open point|offene punkte|offene fragen/i.test(order)) {
    result.warnings.push(`placeholder ${placeholders[0]} but no section with assumptions`);
  }

  const flags = [
    [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, "download piped into a shell"],
    [/\b(?:iex|invoke-expression)\b[^\n]*(?:download|iwr|invoke-webrequest|irm|http)/i, "downloaded text run as a command"],
    [/ignore (?:all )?previous/i, 'text like "ignore previous"'],
    [/disable (?:the )?tests?/i, 'text like "disable tests"'],
    [/skip (?:the )?checks?/i, 'text like "skip checks"'],
  ];
  for (const [pattern, label] of flags) if (pattern.test(order)) result.warnings.push(`red flag: ${label}`);

  if (isGit) {
    const hosts = new Set();
    for (const m of order.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1].toLowerCase());
    let checked = 0;
    for (const host of hosts) {
      if (checked >= 5 || /^(localhost|127\.0\.0\.1|example\.(com|org))$/.test(host)) continue;
      checked++;
      if (!(git(root, ["grep", "--untracked", "-I", "-l", "-F", "-e", host, "--", ".", ...grepExcludes()]) ?? "").trim()) {
        result.warnings.push(`red flag: URL host ${host} appears nowhere in the repository`);
      }
    }
  }
  result.hints.push(...state.hints);
  return result;
}

function cmdCheck(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const size = ["S", "M", "L", "XL"].includes(String(options.size).toUpperCase()) ? String(options.size).toUpperCase() : "M";
  const result = checkOrder(readStdin(), cwd, size);
  if (options.format === "json") return emit(JSON.stringify(result, null, 2));
  const lines = [`# PP check 1 (${SCHEMA})`];
  for (const e of result.errors) lines.push(`error: ${e}`);
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  for (const h of result.hints) lines.push(`hint: ${h}`);
  lines.push(`check: ${result.errors.length} errors, ${result.warnings.length} warnings, ${result.hints.length} hints, ${result.words} words`);
  emit(lines.join("\n"));
}

// ---------------------------------------------------------------- save

function cmdSave(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const { root, none } = findRoot(cwd);
  const flush = () => state.hints.forEach((h) => emit(`hint: ${h}`));
  if (none) {
    hint("not saved: no project root found");
    return flush();
  }
  const raw = readStdin();
  const order = extractOrder(raw);
  if (!order.trim()) {
    hint("not saved: no input");
    return flush();
  }
  const secrets = findSecrets(raw);
  if (secrets.length) {
    for (const s of secrets) emit(`error: not saved: secret pattern (${s.kind}) in line ${s.line}`);
    return;
  }
  const home = join(root, ".promptprinter");
  const promptsDir = join(home, "prompts");
  const created = !existsSync(home);
  if (!created && lstatSync(home).isSymbolicLink()) {
    hint("not saved: .promptprinter is a link, refusing to write through it");
    return flush();
  }
  mkdirSync(promptsDir, { recursive: true });
  if (created) writeFileSync(join(home, ".gitignore"), "*\n", { flag: "wx" });
  const target = realpathSync(promptsDir);
  const expected = join(realpathSync(root), ".promptprinter", "prompts");
  if (relative(expected, target) !== "") {
    hint("not saved: the target folder is not under .promptprinter/prompts");
    return flush();
  }
  const slug = (typeof options.slug === "string" ? options.slug : "auftrag")
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "auftrag";
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const header = `---\ndate: ${localIso(now)}\nhost: ${["claude", "codex", "vscode"].includes(options.host) ? options.host : "claude"}\nsize: ${["S", "M", "L", "XL"].includes(String(options.size).toUpperCase()) ? String(options.size).toUpperCase() : "unknown"}\nscript: ${VERSION}\n---\n\n`;
  for (let n = 1; n < 1000; n++) {
    const name = `${stamp}-${slug}${n === 1 ? "" : `-${n}`}.md`;
    try {
      writeFileSync(join(target, name), `${header}${order}\n`, { flag: "wx" });
      emit(`saved: .promptprinter/prompts/${name}`);
      return flush();
    } catch (error) {
      if (error.code !== "EEXIST") {
        hint(`not saved: ${error.code ?? "write failed"}`);
        return flush();
      }
    }
  }
  hint("not saved: too many files with this name");
  flush();
}

// ---------------------------------------------------------------- doctor

function skillVersion(dir) {
  const text = readText(join(dir, "SKILL.md"), 64 * 1024);
  if (text == null) return null;
  return text.match(/^\s*version:\s*"?([^"\n]+)"?/m)?.[1]?.trim() ?? "unknown";
}

function cmdDoctor(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const gitVersion = git(cwd, ["--version"])?.trim() ?? null;
  const { root, none } = findRoot(cwd);
  const config = none ? null : loadConfig(root);
  const home = homedir();
  const installed = {
    claude: skillVersion(join(home, ".claude", "skills", "pp")),
    agents: skillVersion(join(home, ".agents", "skills", "pp")),
  };
  const others = [];
  for (const dir of [join(home, ".claude", "skills"), join(root, ".claude", "skills"), join(home, ".agents", "skills"), join(root, ".agents", "skills")]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const text = readText(join(dir, entry.name, "SKILL.md"), 64 * 1024) ?? "";
        const name = text.match(/^name:\s*(\S+)/m)?.[1];
        if (name === "pp" && entry.name !== "pp") others.push(toPosix(join(dir, entry.name)));
      }
    } catch {
      /* Ordner fehlt */
    }
  }
  const report = {
    schema: SCHEMA,
    script: VERSION,
    node: { version: process.versions.node, ok: nodeMajor >= 22 },
    git: gitVersion,
    root: none ? null : toPosix(root),
    installed,
    otherSkillsNamedPp: others,
    config: config ? { denyPaths: config.denyPaths.length, language: config.language, target: config.target } : null,
    hints: state.hints,
  };
  if (options.format === "json") return emit(JSON.stringify(report, null, 2));
  const out = [`# PP doctor 1 (${SCHEMA})`, `script: ${VERSION}`];
  out.push(`node: ${report.node.version}${report.node.ok ? "" : " (needs 22 or newer)"}`);
  out.push(`git: ${gitVersion ?? "not found"}`);
  out.push(`project root: ${report.root ?? "none"}`);
  out.push(`skill in ~/.claude/skills/pp: ${installed.claude ?? "not installed"}`);
  out.push(`skill in ~/.agents/skills/pp: ${installed.agents ?? "not installed"}`);
  for (const o of others) out.push(`warning: another skill named pp in ${o}`);
  for (const h of report.hints) out.push(`hint: ${h}`);
  emit(out.join("\n"));
}

// ---------------------------------------------------------------- main

const COMMANDS = { pack: cmdPack, search: cmdSearch, check: cmdCheck, save: cmdSave, doctor: cmdDoctor };

async function main(argv) {
  const options = parseArgs(argv);
  state.debug = Boolean(options.debug);
  if (options.version) return emit(`pp-context ${VERSION} (${SCHEMA})`);
  const command = options._[0];
  if (!COMMANDS[command]) {
    return emit("hint: usage: node context.mjs <pack|search|check|save|doctor> [--cwd <dir>] [--format md|json] [--host claude|codex|vscode] [--terms a,b] [--size S|M|L|XL] [--slug name]");
  }
  if (Number(process.versions.node.split(".")[0]) < 22) hint("Node 22 or newer is expected");
  await COMMANDS[command](options);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    emit(`hint: internal error: ${cut(error?.message ?? error, 200)}`);
  }
  process.exitCode = 0;
}
