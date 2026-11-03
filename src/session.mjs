import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { ApiError } from "./api.mjs";

/** Niemand ist (mehr) angemeldet. */
export class NotLoggedInError extends Error {}
/** Ein anderes Fenster hält die Sperre zu lange. */
export class SessionBusyError extends Error {}

const FILE = "session.json";
const LOCK = "session.lock";
// Das Access-Token gilt eine Stunde. Mit dieser Reserve läuft es nicht mitten in einer Anfrage ab.
const EXPIRY_MARGIN_S = 60;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/**
 * Die Sitzung auf der Platte. Eine Datei, nur für diesen Nutzer lesbar (`0600`, unter Windows eine eigene
 * Zugriffsliste, `restrictToUser`). Sie enthält keine Schlüssel eines Anbieters, aber Zugang zum Konto.
 */
export function createSessionStore({ dir, server, now = () => Date.now() }) {
  const path = join(dir, FILE);
  const lockPath = join(dir, LOCK);

  async function load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
    if (
      typeof parsed?.access_token !== "string" ||
      typeof parsed?.refresh_token !== "string" ||
      typeof parsed?.expires_at !== "number"
    ) {
      return null;
    }
    // Eine Anmeldung gehört zu dem Server, der sie ausgestellt hat. Zeigt PROMPTPRINTER_URL woanders hin,
    // darf das Token dieses Servers dort nie ankommen.
    return parsed.server === server ? parsed : null;
  }

  /**
   * Erst in eine eigene Datei, dann umbenennen: ein Absturz hinterlässt die alte oder die neue Sitzung,
   * nie eine halbe. Das Refresh-Token ist nach jeder Erneuerung ein anderes, eine halbe Datei wäre eine
   * verlorene Anmeldung.
   */
  async function save(session) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") await restrictToUser(dir);
    const tmp = join(dir, `${FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    const record = {
      server,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    };
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await renameWithRetry(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return record;
  }

  async function clear() {
    await rm(path, { force: true });
  }

  /** Zwei Fenster dürfen nicht gleichzeitig erneuern: das zweite läse sonst ein verbrauchtes Token. */
  async function withLock(fn) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const deadline = now() + LOCK_WAIT_MS;
    let handle;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (err) {
        if (err.code !== "EEXIST" && err.code !== "EPERM") throw err;
        if (await isStale(lockPath, now)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (now() >= deadline) throw new SessionBusyError();
        await sleep(50);
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  return { load, save, clear, withLock, path };
}

const run = promisify(execFile);
let userSid;

/**
 * Unter Windows gibt es kein `0700`: der Ordner erbt die Rechte von %APPDATA%, und die lassen auf manchen
 * Rechnern weitere Konten lesen (gemessen: zwei lokale Konten der Sandbox eines KI-Agenten). Deshalb keine
 * geerbten Rechte, nur dieser Nutzer; die Dateien darin erben genau das. Bei jedem Speichern, damit auch ein
 * älterer Ordner es bekommt. Scheitert es (ein Laufwerk ohne Zugriffslisten), bleiben die geerbten Rechte,
 * wie ohne diesen Schritt: eine Anmeldung, die an einem Werkzeug scheitert, schützt niemanden.
 */
async function restrictToUser(dir) {
  // Mit festem Pfad: in Git Bash steht ein anderes `whoami` vorn im PATH, das /user nicht kennt.
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  try {
    userSid ??= run(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(
      ({ stdout }) => /"(S-1-[\d-]+)"/.exec(stdout)?.[1]
    );
    const sid = await userSid;
    if (!sid) return;
    await run(join(system32, "icacls.exe"), [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/q"], { windowsHide: true });
  } catch {
    // Siehe oben: dann gelten die Rechte des Benutzerordners.
  }
}

async function isStale(lockPath, now) {
  try {
    return now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// Unter Windows scheitert das Umbenennen kurz, solange ein anderer Prozess die Datei gerade liest.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) throw err;
      await sleep(50);
    }
  }
}

/**
 * Hält eine gültige Anmeldung bereit. In Produktion erkennt der Auth-Server wiederverwendete
 * Refresh-Tokens, deshalb: unter der Sperre neu lesen (ein anderes Fenster kann längst erneuert haben)
 * und das neue Token speichern, BEVOR es jemand benutzt.
 */
export function createAuth({ store, api, nowSeconds = () => Date.now() / 1000 }) {
  const isFresh = (session) => session.expires_at - nowSeconds() > EXPIRY_MARGIN_S;

  async function accessToken({ rejected } = {}) {
    const session = await store.load();
    if (!session) throw new NotLoggedInError();
    if (!rejected && isFresh(session)) return session.access_token;

    return store.withLock(async () => {
      const current = await store.load();
      if (!current) throw new NotLoggedInError();
      const renewedElsewhere = rejected ? current.access_token !== rejected : current.refresh_token !== session.refresh_token;
      if (renewedElsewhere && isFresh(current)) return current.access_token;

      let refreshed;
      try {
        refreshed = await api.refresh(current.refresh_token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await store.clear();
          throw new NotLoggedInError();
        }
        throw err;
      }
      return (await store.save(refreshed.session)).access_token;
    });
  }

  /**
   * Führt eine Anfrage mit gültigem Token aus. Ein 401 trotz frischem Token kann eine falsche Uhr sein:
   * einmal erneuern und wiederholen. Ein zweites 401 heisst, die Sitzung gibt es nicht mehr.
   */
  async function withToken(fn) {
    const token = await accessToken();
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
    }
    const renewed = await accessToken({ rejected: token });
    try {
      return await fn(renewed);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await store.clear();
        throw new NotLoggedInError();
      }
      throw err;
    }
  }

  return { accessToken, withToken };
}
