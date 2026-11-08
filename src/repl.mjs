import { createInterface } from "node:readline";
import { describeAccount, fetchAccount, signOut } from "./account.mjs";
import { AGENTS, findOnPath, fitsCommandLine, launchPlan, runAgent } from "./agents.mjs";
import { createConversation, MAX_USER_MESSAGE_CHARS, runTurn } from "./chat.mjs";
import { describeError } from "./errors.mjs";
import { extractPrompt } from "./extract-prompt.mjs";
import { buildContextMessage } from "./project-context.mjs";
import { ReplyRenderer } from "./render.mjs";
import { NotLoggedInError } from "./session.mjs";
import { sanitize, wrapLine } from "./text.mjs";

// Eingefügter Text kommt als viele Zeilen in einem Atemzug. Im Terminal werden sie zu einer Nachricht
// zusammengefasst, sonst ginge jede Zeile einzeln an Finn. Aus einer Pipe zählt jede Zeile einzeln.
const PASTE_WINDOW_MS = 30;
const CONTEXT_FLAG = /^--(?:kontext|context)(?:\s+|$)/i;

/**
 * Die Eingabezeile. Kennt die Befehle und zeichnet die Züge, die Arbeit steckt in den anderen Modulen.
 * Alles von aussen kommt über `ctx`, deshalb läuft sie im Test auch ohne echtes Terminal.
 */
export function runRepl(ctx) {
  const { input, output, term, t, api, auth, store, login, copy, save } = ctx;
  const cwd = ctx.cwd ?? process.cwd();
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

  // Eine Frage an der Eingabezeile. Strg+C (über `turn`) und das Ende der Eingabe gelten als Nein.
  function ask(query) {
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      turn = new AbortController();
      const { signal } = turn;
      const finish = (answer) => {
        rl.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
        turn = null;
        resolve(answer);
      };
      const onClose = () => finish(null);
      const onAbort = () => finish(null);
      rl.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      rl.question(query, { signal }, finish);
    });
  }

  function showPreview(built, me) {
    const border = term.unicode ? { top: "┌─", side: "│", bottom: "└─" } : { top: "+-", side: "|", bottom: "+-" };
    const width = term.wrapWidth - 2;
    say(t("kontextPreview"));
    say(term.dim(`${border.top} ${t("kontextMessage", { length: built.message.length, max: MAX_USER_MESSAGE_CHARS })}`));
    for (const line of built.message.split("\n")) {
      for (const part of wrapLine(line, width)) say(`${term.dim(border.side)} ${part}`);
    }
    say(term.dim(border.bottom));
    say(t("kontextSummary", { files: built.files, lines: built.lines, redacted: built.redacted, denied: built.denied }));
    say(t(me.hasOwnKey ? "kontextToOwn" : "kontextToServer"));
    say(t("kontextStored"));
    say(term.dim(t("kontextWarning")));
  }

  /** Empfänger und Nachricht für `/pp --kontext`, oder eine Absage als Text. Sendet nichts. */
  async function prepareContext(idea) {
    if (!idea) return { refusal: t("kontextAsk") };
    if (!term.isTTY || !input.isTTY) return { refusal: t("kontextNoTerminal") };
    if (idea.length > MAX_USER_MESSAGE_CHARS) {
      return { refusal: t("tooLong", { length: idea.length, max: MAX_USER_MESSAGE_CHARS }) };
    }
    let me;
    try {
      me = await fetchAccount({ auth, api });
    } catch (err) {
      return { refusal: err instanceof NotLoggedInError ? t("notLoggedIn") : describeError(err, { t, server: api.server }) };
    }
    if (!me) return { refusal: t("kontextNoRecipient") };
    if (me.needsOwnKey || me.needsConsent) {
      return { refusal: describeAccount(me, { t, server: api.server }).hints.join("\n") };
    }
    say(term.dim(t("kontextCollecting")));
    try {
      const built = await buildContextMessage({ cwd, idea, intro: t("kontextIntro"), max: MAX_USER_MESSAGE_CHARS });
      if (built.kind === "noRoom") return { refusal: t("kontextNoRoom", { max: MAX_USER_MESSAGE_CHARS }) };
      return { built, me };
    } catch (err) {
      return { refusal: t("generic", { detail: sanitize(String(err?.message ?? err)) }) };
    }
  }

  // `/pp --kontext <Idee>`: der Text verlässt den Rechner und bleibt im Chat-Verlauf. Deshalb erst Vorschau
  // und Empfänger, dann nur ein getipptes "j"; aus einer Pipe wird weder gesammelt noch gesendet, denn
  // dort könnte das "j" schon in der Eingabe stehen, bevor jemand die Vorschau gesehen hat.
  async function ppWithContext(idea) {
    const { refusal, built, me } = await prepareContext(idea);
    if (refusal) {
      say(refusal);
      return;
    }
    showPreview(built, me);
    const answer = await ask(t("kontextConfirm"));
    if (answer?.trim().toLowerCase() !== t("kontextYes")) {
      say(t("kontextCancelled"));
      return;
    }
    conversation.reset();
    lastPrompt = null;
    await send(built.message);
  }

  // `/an claude`, `/an codex`: der Agent übernimmt das Terminal, bis er endet. Solange liest diese Eingabezeile nichts,
  // und Strg+C gehört dem Agenten (der Prozess bekommt es auch, darf daran aber nicht enden).
  async function handOver(rest) {
    const agent = AGENTS[rest.toLowerCase()];
    if (!agent) {
      say(t("anUsage"));
      return;
    }
    if (!lastPrompt) {
      say(t("noPromptYet"));
      return;
    }
    if (!term.isTTY || !input.isTTY) {
      say(t("anNoTerminal", { name: agent.name }));
      return;
    }
    if (!fitsCommandLine(lastPrompt)) {
      say(t("anTooLong", { name: agent.name }));
      return;
    }
    const file = await (ctx.findAgent ?? findOnPath)(agent.command);
    if (!file) {
      say(t("anMissing", { name: agent.name, command: agent.command, url: agent.install }));
      return;
    }
    const plan = await launchPlan(file, lastPrompt);
    if (plan.kind !== "ok") {
      say(t("anUnsupported", { name: agent.name, file: sanitize(file) }));
      return;
    }
    say(term.dim(t("anStarting", { name: agent.name })));
    const keep = () => {};
    process.on("SIGINT", keep);
    rl.pause();
    if (input.isTTY && input.setRawMode) input.setRawMode(false);
    try {
      const code = await (ctx.runAgent ?? runAgent)(plan, { cwd });
      say(term.dim(t("anBack", { name: agent.name, code })));
    } catch (err) {
      say(t("anFailed", { name: agent.name, detail: sanitize(String(err?.message ?? err)) }));
    } finally {
      process.removeListener("SIGINT", keep);
      if (input.isTTY && input.setRawMode) input.setRawMode(true);
      rl.resume();
    }
  }

  async function command(line) {
    const space = line.search(/\s/);
    const name = (space === -1 ? line : line.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : line.slice(space + 1).trim();
    // Vor dem switch: mit Kontext beginnt das neue Gespräch erst nach dem "j".
    if (name === "/pp" && CONTEXT_FLAG.test(rest)) {
      await ppWithContext(rest.replace(CONTEXT_FLAG, "").trim());
      return;
    }
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
      case "/an":
        await handOver(rest);
        return;
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
