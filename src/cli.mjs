import { readFileSync } from "node:fs";
import { describeAccount, fetchAccount, signOut } from "./account.mjs";
import { createApi } from "./api.mjs";
import { banner } from "./banner.mjs";
import { ConfigError, configDir, serverUrl } from "./config.mjs";
import { describeError } from "./errors.mjs";
import { runLogin } from "./login.mjs";
import { detectLang, translator } from "./messages.mjs";
import { runRepl } from "./repl.mjs";
import { createAuth, createSessionStore, NotLoggedInError } from "./session.mjs";
import { copyToClipboard, openBrowser, savePrompt } from "./system.mjs";
import { detectTerminal } from "./terminal.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function main(argv, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const t = translator(detectLang(env));
  const say = (text) => output.write(`${text}\n`);

  let server;
  try {
    server = serverUrl(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      say(err.message);
      return 1;
    }
    throw err;
  }

  const [command, ...extra] = argv;
  if (command === "--version" || command === "-v") {
    say(VERSION);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    say(t("usage"));
    return 0;
  }

  const term = detectTerminal(output, env);
  const api = createApi({ server, version: VERSION, lang: detectLang(env) });
  const store = createSessionStore({ dir: configDir(env), server });
  const auth = createAuth({ store, api });

  // Aus dem Programm heraus und als eigener Befehl derselbe Weg. Strg+C beendet das Warten, nicht mehr:
  // ausserhalb der Eingabezeile kommt es als Signal an den Prozess, in ihr über `signal` vom Aufrufer.
  async function login(signal) {
    if (await store.load()) {
      say(t("alreadyIn"));
      return true;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    process.once("SIGINT", cancel);
    try {
      const result = await runLogin({
        api,
        store,
        signal: controller.signal,
        print: { step: (key, vars) => say(t(key, vars)) },
        open: term.isTTY && !env.PROMPTPRINTER_NO_BROWSER ? (url) => openBrowser(url) : undefined,
      });
      const outcome = {
        done: "loginDone",
        denied: "loginDenied",
        expired: "loginExpired",
        invalid: "loginInvalid",
        failed: "loginFailed",
        cancelled: "loginCancelled",
      };
      say(t(outcome[result]));
      return result === "done";
    } catch (err) {
      say(describeError(err, { t, server }));
      return false;
    } finally {
      signal?.removeEventListener("abort", cancel);
      process.removeListener("SIGINT", cancel);
    }
  }

  async function showAccount() {
    const me = await fetchAccount({ auth, api });
    if (!me) return;
    const { line, hints } = describeAccount(me, { t, server });
    say(term.dim(line));
    for (const hint of hints) say(hint);
  }

  if (command === "login") return (await login()) ? 0 : 1;

  if (command === "logout") {
    const result = await signOut({ auth, api, store });
    say(t({ none: "notLoggedIn", out: "loggedOut", local: "logoutLocalOnly" }[result]));
    return 0;
  }

  if (command === "whoami") {
    try {
      const me = await fetchAccount({ auth, api });
      if (!me) return 1;
      const { line, hints } = describeAccount(me, { t, server });
      say(line);
      for (const hint of hints) say(hint);
      return 0;
    } catch (err) {
      say(err instanceof NotLoggedInError ? t("notLoggedIn") : describeError(err, { t, server }));
      return 1;
    }
  }

  if (command !== undefined || extra.length > 0) {
    say(t("usage"));
    return 2;
  }

  say(banner(term, VERSION));
  say(term.dim(t("disclosure")));

  // Ohne Anmeldung geht nichts: im Terminal gleich anmelden, aus einer Pipe nur sagen, was fehlt.
  if (!(await store.load())) {
    if (!term.isTTY) {
      say(t("loginRequired"));
      return 1;
    }
    if (!(await login())) return 1;
  }
  try {
    await showAccount();
  } catch (err) {
    if (!(err instanceof NotLoggedInError)) {
      say(describeError(err, { t, server }));
    } else if (term.isTTY) {
      say(t("loginAgain"));
      if (!(await login())) return 1;
      await showAccount().catch((again) => say(describeError(again, { t, server })));
    } else {
      say(t("loginRequired"));
      return 1;
    }
  }
  say(term.dim(t("tips")));

  await runRepl({
    input,
    output,
    term,
    t,
    api,
    auth,
    store,
    login,
    copy: (text) => copyToClipboard(text, { env }),
    save: (text, options) => savePrompt(text, options),
    onInterrupt: (handler) => {
      if (!term.isTTY) process.on("SIGINT", handler);
    },
  });
  return 0;
}
