import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError, NetworkError } from "./api.mjs";
import { sanitize } from "./text.mjs";

/** Der Server sagt, wohin. Geglaubt wird das nur für den eigenen Server, sonst die bekannte Seite. */
function verificationAddress(api, uri) {
  try {
    const url = new URL(uri);
    if (url.origin === api.server) return url.href;
  } catch {
    // Keine gültige Adresse: die bekannte Seite nehmen.
  }
  return `${api.server}/cli`;
}

/**
 * Anmeldung per Geräte-Code: Code anfragen und zeigen, der Mensch bestätigt im Browser, dann genau einmal
 * die Sitzung abholen. Der Code steht bewusst nicht in der Adresse (Phishing, siehe Haupt-Repo). Das
 * Ergebnis ist `done`, `denied`, `expired`, `invalid`, `failed` oder `cancelled`.
 */
export async function runLogin({ api, store, print, signal, open, wait = sleep, now = () => Date.now() }) {
  const device = await api.requestDevice(`${hostname()} (promptprinter)`);
  const address = verificationAddress(api, device.verificationUri);
  print.step("loginStart");
  print.step("loginOpen", { url: address });
  print.step("loginCode", { code: sanitize(String(device.userCode)) });
  print.step("loginWarning");
  print.step("loginWaiting");
  open?.(address);

  let interval = Math.max(1, Number(device.interval) || 5);
  const deadline = now() + (Number(device.expiresIn) || 600) * 1000;
  while (now() < deadline) {
    try {
      await wait(interval * 1000, undefined, { signal });
    } catch {
      return "cancelled";
    }
    try {
      const answer = await api.pollToken(device.deviceCode);
      if (answer.status === "approved" && answer.session) {
        await store.save(answer.session);
        return "done";
      }
      if (typeof answer.interval === "number") interval = Math.max(1, answer.interval);
    } catch (err) {
      if (err instanceof NetworkError) continue;
      if (!(err instanceof ApiError)) throw err;
      if (err.kind === "slow_down") {
        // Wie RFC 8628: wer gebremst wird, fragt seltener, nicht nur gleich oft.
        interval = Math.max(interval + 5, err.interval ?? 0);
        continue;
      }
      if (err.kind === "rate_limited") {
        interval = Math.max(interval, err.retryAfter ?? interval);
        continue;
      }
      if (err.kind === "denied") return "denied";
      if (err.kind === "expired") return "expired";
      if (err.kind === "invalid") return "invalid";
      return "failed";
    }
  }
  return "expired";
}
