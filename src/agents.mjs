import { spawn as nodeSpawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * `/an claude` und `/an codex`: startet den Agenten im selben Terminal, mit dem Prompt als erster Nachricht. Beide nehmen
 * sie als Argument an (`claude "<Prompt>"`, `codex "<Prompt>"`, laut ihrer Hilfe). Davor steht `--`: ein Prompt, der mit
 * "-" beginnt, wäre sonst eine Option des Agenten.
 *
 * Gestartet wird nie über eine Shell. Der Prompt kommt vom Modell, eine Shell läse darin `&`, `|`, `%VAR%` oder `$(…)` als
 * Befehl. Unter Windows sind `claude` und `codex` nach `npm install -g` aber `.cmd`-Dateien, die nur cmd.exe ausführen kann.
 * Deshalb liest dieses Modul aus der `.cmd`-Datei, welches Skript sie startet (die Form von npm, "cmd-shim"), und startet
 * dieses Skript mit Node direkt. Kennt es die Form nicht, startet es nichts und sagt das.
 */
export const AGENTS = {
  claude: { command: "claude", name: "Claude Code", install: "https://docs.claude.com/en/docs/claude-code/setup" },
  codex: { command: "codex", name: "Codex", install: "https://github.com/openai/codex" },
};

// Windows begrenzt eine Befehlszeile auf 32 767 Zeichen; Anführungszeichen im Prompt werden beim Übergeben verdoppelt.
const MAX_WINDOWS_PROMPT_CHARS = 12_000;
const SCRIPT = /\.(?:c|m)?js$/i;
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+)"\s+%\*/g;

/**
 * Sucht den Befehl im PATH, wie es eine Shell täte, aber nur in absoluten Ordnern: ein leerer oder relativer Eintrag
 * hiesse "der aktuelle Ordner", und dort könnte ein fremdes `claude.exe` liegen. Unter Windows zählen nur Dateien mit
 * einer Endung aus PATHEXT; die Datei ohne Endung, die npm daneben legt, ist ein Skript für sh.
 */
export async function findOnPath(command, { env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter((dir) => dir && isAbsolute(dir));
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = join(dir, `${command}${ext}`);
      try {
        const info = await stat(file);
        if (info.isFile() && (platform === "win32" || info.mode & 0o111)) return file;
      } catch {
        // nicht in diesem Ordner
      }
    }
  }
  return null;
}

/**
 * Wie der Agent ohne Shell gestartet wird: `{ command, args }`, oder `{ kind: "unsupported" }` für eine Datei, die nur eine
 * Shell ausführen könnte. Die Argumente sind eine Liste, der Prompt ist eines davon und wird nie zu einem Befehl verbunden.
 */
export async function launchPlan(file, prompt, { platform = process.platform, node = process.execPath } = {}) {
  const ext = extname(file).toLowerCase();
  if (platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const target = await shimTarget(file);
    if (!target) return { kind: "unsupported", file };
    if (SCRIPT.test(target)) return { kind: "ok", command: node, args: [target, "--", prompt] };
    if (extname(target).toLowerCase() === ".exe") return { kind: "ok", command: target, args: ["--", prompt] };
    return { kind: "unsupported", file };
  }
  if (platform === "win32" && ext !== ".exe" && ext !== ".com") return { kind: "unsupported", file };
  return { kind: "ok", command: file, args: ["--", prompt] };
}

// Die `.cmd`-Datei von npm endet mit `"%_prog%"  "%dp0%\node_modules\…\cli.js" %*` (Skript) oder `"%dp0%\…\x.exe" %*`.
// Gelesen wird nur dieses Ziel, und nur wenn es im Ordner der Datei oder darunter liegt und es die Datei gibt.
async function shimTarget(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const matches = [...text.matchAll(SHIM_TARGET)];
  if (matches.length === 0) return null;
  const base = dirname(file);
  const target = resolve(base, matches[matches.length - 1][1].replaceAll("\\", "/"));
  const inside = relative(base, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  try {
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

/** Sagt, ob der Prompt auf dieser Plattform als Argument passt. */
export function fitsCommandLine(prompt, platform = process.platform) {
  return platform !== "win32" || prompt.length <= MAX_WINDOWS_PROMPT_CHARS;
}

/**
 * Startet den Agenten im selben Terminal und wartet, bis er endet. `shell: false` steht ausdrücklich da: das ist die
 * Schranke, auf der `/an` ruht. Gibt den Exit-Code zurück oder wirft, wenn der Start scheitert.
 */
export function runAgent(plan, { spawn = nodeSpawn, stdio = "inherit", cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, { stdio, cwd, env, shell: false, windowsHide: false });
    } catch (err) {
      reject(err);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}
