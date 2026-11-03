import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError } from "../src/api.mjs";
import { createAuth, createSessionStore, NotLoggedInError, SessionBusyError } from "../src/session.mjs";

const SERVER = "https://promptprinter.app";
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 10;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pp-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const store = (server = SERVER) => createSessionStore({ dir: join(dir, "cfg"), server });
const record = (access, refresh, expires_at = future()) => ({ access_token: access, refresh_token: refresh, expires_at });

test("speichern und laden, ohne fremde Felder und ohne Reste", async () => {
  const s = store();
  assert.equal(await s.load(), null);
  await s.save({ ...record("a", "r"), extra: "weg" });
  const loaded = await s.load();
  assert.equal(loaded.access_token, "a");
  assert.equal(loaded.server, SERVER);
  assert.equal("extra" in loaded, false);
  assert.deepEqual(readdirSync(join(dir, "cfg")), ["session.json"]);
  await s.clear();
  assert.equal(await s.load(), null);
});

test("die Datei ist nur für den Nutzer lesbar", { skip: process.platform === "win32" }, async () => {
  const s = store();
  await s.save(record("a", "r"));
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "cfg")).mode & 0o777, 0o700);
  await s.save(record("b", "r2"));
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
});

test("eine Sitzung gilt nur für ihren Server", async () => {
  await store().save(record("a", "r"));
  assert.equal(await store("https://anderer.example.com").load(), null);
  assert.equal((await store().load()).access_token, "a");
});

test("kaputte oder unvollständige Dateien gelten als nicht angemeldet", async () => {
  const s = store();
  await s.save(record("a", "r"));
  writeFileSync(s.path, "{halb");
  assert.equal(await s.load(), null);
  writeFileSync(s.path, JSON.stringify({ server: SERVER, access_token: "a" }));
  assert.equal(await s.load(), null);
  writeFileSync(s.path, "null");
  assert.equal(await s.load(), null);
});

test("die Sperre lässt nur einen zugleich durch", async () => {
  const s = store();
  const order = [];
  const holder = (name) =>
    s.withLock(async () => {
      order.push(`${name}-start`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(`${name}-end`);
    });
  await Promise.all([holder("a"), holder("b")]);
  // Wer zuerst dran ist, ist offen. Sicher ist nur: keiner beginnt, bevor der andere fertig ist.
  const first = order[0].split("-")[0];
  const second = first === "a" ? "b" : "a";
  assert.deepEqual(order, [`${first}-start`, `${first}-end`, `${second}-start`, `${second}-end`]);
  assert.deepEqual(readdirSync(join(dir, "cfg")).includes("session.lock"), false);
});

test("eine verwaiste Sperre wird übernommen, eine frische nicht", async () => {
  const s = store();
  await s.save(record("a", "r"));
  const lock = join(dir, "cfg", "session.lock");
  writeFileSync(lock, "");
  utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(await s.withLock(async () => "durch"), "durch");

  writeFileSync(lock, "");
  let clock = Date.now();
  const stuck = createSessionStore({ dir: join(dir, "cfg"), server: SERVER, now: () => (clock += 3000) });
  await assert.rejects(stuck.withLock(async () => "nie"), SessionBusyError);
});

function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    refresh: async (token) => {
      calls.push(token);
      return handler(token);
    },
  };
}

test("ein gültiges Token wird ohne Erneuerung benutzt", async () => {
  const s = store();
  await s.save(record("a", "r"));
  const api = fakeApi(() => assert.fail("nicht erneuern"));
  assert.equal(await createAuth({ store: s, api }).accessToken(), "a");
});

test("ohne Sitzung NotLoggedIn, ohne den Server zu fragen", async () => {
  const api = fakeApi(() => assert.fail("nicht fragen"));
  await assert.rejects(createAuth({ store: store(), api }).accessToken(), NotLoggedInError);
});

test("kurz vor dem Ablauf wird erneuert und das neue Token gespeichert, bevor es jemand bekommt", async () => {
  const s = store();
  await s.save(record("alt", "r1", Math.floor(Date.now() / 1000) + 30));
  let savedWhenReturned;
  const api = fakeApi(async () => ({ session: record("neu", "r2") }));
  const token = await createAuth({ store: s, api }).accessToken();
  savedWhenReturned = JSON.parse(readFileSync(s.path, "utf8"));
  assert.equal(token, "neu");
  assert.equal(savedWhenReturned.refresh_token, "r2");
  assert.deepEqual(api.calls, ["r1"]);
});

test("zwei Fenster gleichzeitig erneuern nur einmal", async () => {
  const s = store();
  await s.save(record("alt", "r1", past()));
  const api = fakeApi(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { session: record("neu", "r2") };
  });
  const first = createAuth({ store: createSessionStore({ dir: join(dir, "cfg"), server: SERVER }), api });
  const second = createAuth({ store: createSessionStore({ dir: join(dir, "cfg"), server: SERVER }), api });
  const tokens = await Promise.all([first.accessToken(), second.accessToken()]);
  assert.deepEqual(tokens, ["neu", "neu"]);
  assert.deepEqual(api.calls, ["r1"]);
});

test("ein abgelehntes Refresh-Token löscht die Sitzung", async () => {
  const s = store();
  await s.save(record("alt", "r1", past()));
  const api = fakeApi(async () => {
    throw new ApiError(401, { kind: "invalid_token" });
  });
  await assert.rejects(createAuth({ store: s, api }).accessToken(), NotLoggedInError);
  assert.equal(await s.load(), null);
});

test("ein Ausfall beim Erneuern lässt die Sitzung stehen", async () => {
  const s = store();
  await s.save(record("alt", "r1", past()));
  const api = fakeApi(async () => {
    throw new ApiError(503, { kind: "unavailable" });
  });
  await assert.rejects(createAuth({ store: s, api }).accessToken(), ApiError);
  assert.equal((await s.load()).refresh_token, "r1");
});

test("ein 401 trotz frischem Token: einmal erneuern und wiederholen", async () => {
  const s = store();
  await s.save(record("a", "r1"));
  const api = fakeApi(async () => ({ session: record("b", "r2") }));
  const seen = [];
  const result = await createAuth({ store: s, api }).withToken(async (token) => {
    seen.push(token);
    if (token === "a") throw new ApiError(401, {});
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(seen, ["a", "b"]);
});

test("hat ein anderes Fenster schon erneuert, wird dessen Token genommen", async () => {
  const s = store();
  await s.save(record("a", "r1"));
  const api = fakeApi(() => assert.fail("nicht noch einmal erneuern"));
  const auth = createAuth({ store: s, api });
  await s.save(record("von-nebenan", "r2"));
  assert.equal(await auth.accessToken({ rejected: "a" }), "von-nebenan");
});

test("ein zweites 401 heisst: die Sitzung gibt es nicht mehr", async () => {
  const s = store();
  await s.save(record("a", "r1"));
  const api = fakeApi(async () => ({ session: record("b", "r2") }));
  await assert.rejects(
    createAuth({ store: s, api }).withToken(async () => {
      throw new ApiError(401, {});
    }),
    NotLoggedInError
  );
  assert.equal(await s.load(), null);
});
