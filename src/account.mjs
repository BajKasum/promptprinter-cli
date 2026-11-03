import { ApiError } from "./api.mjs";
import { NotLoggedInError } from "./session.mjs";
import { sanitize } from "./text.mjs";

/** Eine Zeile zum Konto und, wenn der nächste Zug nicht laufen könnte, der Weg dorthin. */
export function describeAccount(me, { t, server }) {
  const key = me.hasOwnKey ? t("keyOwn") : me.needsOwnKey ? t("keyNone") : t("keyServer");
  const line = t("account", {
    email: sanitize(String(me.email ?? "?")),
    plan: me.plan === "pro" ? t("planPro") : t("planFree"),
    key,
  });
  const hints = [];
  if (me.needsOwnKey) hints.push(t("needKey", { url: `${server}/settings` }));
  if (me.needsConsent) hints.push(t("needConsent", { url: `${server}/chats/new` }));
  return { line, hints };
}

/**
 * Meldet dieses Gerät ab: die eine Sitzung auf dem Server, dann die Datei. Die Datei geht auch dann, wenn
 * der Server nicht erreichbar ist, denn wer sich abmeldet, will das Token los sein; das Ergebnis `local`
 * sagt dem Aufrufer, dass die Sitzung auf dem Server noch lebt.
 */
export async function signOut({ auth, api, store }) {
  if (!(await store.load())) return "none";
  let result = "out";
  try {
    await auth.withToken((token) => api.logout(token));
  } catch (err) {
    if (!(err instanceof NotLoggedInError)) result = "local";
  }
  await store.clear();
  return result;
}

/** Das Konto, oder `null`, wenn dieser Server die Route noch nicht kennt. Andere Fehler gehen weiter. */
export async function fetchAccount({ auth, api }) {
  try {
    return await auth.withToken((token) => api.me(token));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
