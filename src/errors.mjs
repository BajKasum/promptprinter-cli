import { ApiError, NetworkError } from "./api.mjs";
import { NotLoggedInError, SessionBusyError } from "./session.mjs";

/**
 * Aus einer Absage wird ein Satz, der weiterhilft. Das Programm schreibt seine eigenen Texte und nennt die
 * Adresse, an der es weitergeht; den Text des Servers zeigt es nur, wenn es den Fall nicht kennt.
 */
export function describeError(err, { t, server }) {
  const settings = `${server}/settings`;
  if (err instanceof NotLoggedInError) return t("loginAgain");
  if (err instanceof SessionBusyError) return t("busy");
  if (err instanceof NetworkError) return t("network");
  if (err instanceof ApiError) {
    if (err.status === 401) return t("loginAgain");
    if (err.kind === "byokRequired") return t("needKey", { url: settings });
    if (err.kind === "consentRequired") return t("needConsent", { url: `${server}/chats/new` });
    if (err.kind === "chatMessages") return t("quota", { limit: err.limit ?? "?", url: settings });
    if (err.kind === "byokUnreadable") return t("keyUnreadable", { url: settings });
    if (err.status === 429) return t("rateLimited", { seconds: err.retryAfter ?? 60 });
    return t("generic", { detail: err.message });
  }
  return t("generic", { detail: err?.message ?? String(err) });
}
