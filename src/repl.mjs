import { createInterface } from "node:readline";
import { describeAccount, fetchAccount, signOut } from "./account.mjs";
import { createConversation, MAX_USER_MESSAGE_CHARS, runTurn } from "./chat.mjs";
import { describeError } from "./errors.mjs";
import { extractPrompt } from "./extract-prompt.mjs";
import { ReplyRenderer } from "./render.mjs";
import { NotLoggedInError } from "./session.mjs";

// Eingefügter Text kommt als viele Zeilen in einem Atemzug. Im Terminal werden sie zu einer Nachricht
// zusammengefasst, sonst ginge jede Zeile einzeln an Finn. Aus einer Pipe zählt jede Zeile einzeln.
const PASTE_WINDOW_MS = 30;

/**
 * Die Eingabezeile. Kennt die Befehle und zeichnet die Züge, die Arbeit steckt in den anderen Modulen.
 * Alles von aussen kommt über `ctx`, deshalb läuft sie im Test auch ohne echtes Terminal.
 */
export function runRepl(ctx) {
  const { input, output, term, t, api, auth, store, login, copy, save } = ctx;
  const write = (text) => output.write(text);
  const say = (text) => write(`${text}\n`);
  const conversation = createConversation();
  let lastPrompt = null;
  let turn = null;
  let closed = false;
  let working = false;
  const queue = [];
  let pasted = [];
  let pasteTimer = null;

  const rl = createInterface({ input, output, prompt: term.accent("> "), terminal: term.isTTY, historySize: 200 });

  async function send(text) {
    if (text.length > MAX_USER_MESSAGE_CHARS) {
      say(t("tooLong", { length: text.length, max: MAX_USER_MESSAGE_CHARS }));
      return;
    }
    const renderer = new ReplyRenderer({ write, term, labels: { prompt: t("prompt") } });
    let waiting = term.isTTY;
    if (waiting) write(term.dim(t("thinking")));
    const endWaiting = () => {
      if (!waiting) return;
      waiting = false;
      write(term.clearLine);
    };
    let started = false;
    turn = new AbortController();
    try {
      const result = await runTurn({
        auth,
        api,
        conversation,
        text,
        signal: turn.signal,
        onStatus: (status) => {
          if (waiting && status.phase === "retrying") {
            write(`${term.clearLine}${term.dim(t("retrying", { attempt: status.attempt ?? "?", max: status.maxAttempts ?? "?" }))}`);
          }
        },
        onDelta: (chunk) => {
          endWaiting();
          if (!started) {
            started = true;
            write(`${term.accent(t("finn"))}: `);
          }
          renderer.feed(chunk);
        },
      });
      endWaiting();
      renderer.finish();
      showOutcome(result);
    } catch (err) {
      endWaiting();
      renderer.finish();
      say(describeError(err, { t, server: api.server }));
    } finally {
      turn = null;
    }
  }

  function showOutcome(result) {
    if (result.kind === "stopped") say(t("stopped"));
    else if (result.kind === "dropped") say(t("dropped"));
    else if (result.kind === "protocol") say(t("protocol"));
    else if (result.kind === "error") say(t("generic", { detail: result.detail }));
    else if (result.kind === "done") {
      if (result.persistError) say(term.dim(t("persistFailed")));
      const prompt = extractPrompt(result.text);
      if (prompt) {
        lastPrompt = prompt;
        say(term.dim(t("actions")));
      }
    }
  }

  async function whoami() {
    try {
      const me = await fetchAccount({ auth, api });
      if (!me) return;
      const { line, hints } = describeAccount(me, { t, server: api.server });
      say(line);
      for (const hint of hints) say(hint);
    } catch (err) {
      say(err instanceof NotLoggedInError ? t("notLoggedIn") : describeError(err, { t, server: api.server }));
    }
  }

  async function logout() {
    const result = await signOut({ auth, api, store });
    say(t({ none: "notLoggedIn", out: "loggedOut", local: "logoutLocalOnly" }[result]));
  }

  async function command(line) {
    const space = line.search(/\s/);
    const name = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : line.slice(space + 1).trim();
    switch (name) {
      case "/pp":
        conversation.reset();
        lastPrompt = null;
        if (rest) await send(rest);
        else say(t("ppAsk"));
        return;
      case "/new":
        conversation.reset();
        lastPrompt = null;
        say(t("newChat"));
        return;
      case "/copy":
        if (!lastPrompt) say(t("noPromptYet"));
        else say((await copy(lastPrompt)) ? t("copied") : t("copyFailed"));
        return;
      case "/save": {
        if (!lastPrompt) {
          say(t("noPromptYet"));
          return;
        }
        const saved = await save(lastPrompt, { name: rest || undefined });
        if (saved.kind === "saved") say(t("saved", { path: saved.path }));
        else if (saved.kind === "exists") say(t("saveExists", { path: saved.path }));
        else say(t("saveFailed", { reason: saved.reason }));
        return;
      }
      case "/whoami":
        await whoami();
        return;
      case "/login":
        // Strg+C läuft hier über die Eingabezeile (rl, SIGINT) und bricht das Warten ab.
        turn = new AbortController();
        try {
          await login(turn.signal);
        } finally {
          turn = null;
        }
        return;
      case "/logout":
        await logout();
        return;
      case "/help":
        say(t("help"));
        return;
      case "/exit":
      case "/quit":
        rl.close();
        return;
      default:
        say(t("unknownCommand", { command: name }));
    }
  }

  async function handle(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/") && !trimmed.includes("\n")) await command(trimmed);
    else await send(trimmed);
  }

  return new Promise((resolve) => {
    async function drain() {
      if (working) return;
      working = true;
      while (queue.length > 0) await handle(queue.shift());
      working = false;
      if (closed) resolve();
      else rl.prompt();
    }

    rl.on("line", (line) => {
      if (!term.isTTY) {
        queue.push(line);
        void drain();
        return;
      }
      pasted.push(line);
      clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        queue.push(pasted.join("\n"));
        pasted = [];
        void drain();
      }, PASTE_WINDOW_MS);
    });
    // Strg+C bricht einen laufenden Zug ab, an der leeren Eingabezeile beendet es das Programm.
    rl.on("SIGINT", () => {
      if (turn) turn.abort();
      else rl.close();
    });
    rl.on("close", () => {
      closed = true;
      if (!working) resolve();
    });
    ctx.onInterrupt?.(() => {
      if (turn) turn.abort();
      else rl.close();
    });
    rl.prompt();
  });
}
