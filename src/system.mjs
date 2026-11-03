import { spawn as nodeSpawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

// Dieselbe Markierung wie beim Markdown-Download im Web (shared/lib/ai-marker.ts im Haupt-Repo).
const AI_GENERATED_MARKER = "<!-- ai-generated: true; generator: PromptPrinter (Finn) -->";
const CLIPBOARD_TIMEOUT_MS = 5000;

function clipboardCandidates(platform, env) {
  if (platform === "win32") return [{ command: "clip", args: [], utf16: true }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  return [
    ...(env.WAYLAND_DISPLAY ? [{ command: "wl-copy", args: [] }] : []),
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
    // WSL: Linux, aber die Zwischenablage gehört Windows.
    { command: "clip.exe", args: [], utf16: true },
  ];
}

// clip.exe liest ohne Hinweis die alte Codepage und zerstört Umlaute. Mit Byte-Order-Mark nimmt es UTF-16.
function encodeForClipboard(text, utf16) {
  return utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : Buffer.from(text, "utf8");
}

function pipeTo(candidate, data, spawn) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok);
    };
    // Kein `shell`: der Prompt geht nur über stdin, nichts daran wird als Befehl gelesen.
    const child = spawn(candidate.command, candidate.args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLIPBOARD_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(data);
  });
}

export async function copyToClipboard(text, { platform = process.platform, env = process.env, spawn = nodeSpawn } = {}) {
  for (const candidate of clipboardCandidates(platform, env)) {
    if (await pipeTo(candidate, encodeForClipboard(text, candidate.utf16), spawn)) return true;
  }
  return false;
}

/**
 * Speichert einen Prompt als Markdown. Ohne Namen entsteht einer aus Datum und Uhrzeit, wobei eine
 * vorhandene Datei nie überschrieben wird (`wx`): mit Namen bekommt der Aufrufer `exists` zurück, ohne
 * Namen wird weitergezählt.
 */
export async function savePrompt(prompt, { name, cwd = process.cwd(), now = new Date() } = {}) {
  const content = `${AI_GENERATED_MARKER}\n\n${prompt}\n`;
  if (name) {
    const path = resolve(cwd, extname(name) ? name : `${name}.md`);
    try {
      await writeFile(path, content, { flag: "wx" });
      return { kind: "saved", path };
    } catch (err) {
      if (err.code === "EEXIST") return { kind: "exists", path };
      return { kind: "failed", reason: err.message };
    }
  }
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  for (let n = 1; n < 100; n++) {
    const path = resolve(cwd, `prompt-${stamp}${n > 1 ? `-${n}` : ""}.md`);
    try {
      await writeFile(path, content, { flag: "wx" });
      return { kind: "saved", path, name: basename(path) };
    } catch (err) {
      if (err.code !== "EEXIST") return { kind: "failed", reason: err.message };
    }
  }
  return { kind: "failed", reason: "too many files" };
}

/** Öffnet eine Adresse im Browser. Scheitert still: die Adresse steht ohnehin im Terminal. */
export function openBrowser(url, { platform = process.platform, spawn = nodeSpawn } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const [command, args] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", parsed.href]]
      : platform === "darwin"
        ? ["open", [parsed.href]]
        : ["xdg-open", [parsed.href]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
