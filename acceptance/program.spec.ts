import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test, adminClient, makePro, signIn } from "../support/fixtures";
import { E2E_ORIGIN } from "../support/env";
import { totpCode } from "../support/totp";

// Abnahme mit dem echten Programm: es läuft als eigener Prozess gegen den lokalen Stack des Haupt-Repos, bestätigt wird in
// der echten Seite /cli. Die Datei gehört in dieses Repo, läuft aber nur dort, deshalb kopiert acceptance/run.mjs sie nach
// e2e/tmp/ und löscht sie danach wieder. Das Modell ist der Stub des Servers ("Demo-Antwort"), kein Anbieter.

const BIN = process.env.PROMPTPRINTER_CLI_BIN ?? join(process.cwd(), "..", "promptprinter-cli", "bin", "promptprinter.mjs");
const USER_CODE = /[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}/;

type Run = { code: number | null; out: string };

/** Ein Ordner für die Sitzung, einer als Arbeitsordner, und das Programm als Prozess mit Eingabe über stdin. */
function program() {
  const dir = mkdtempSync(join(tmpdir(), "pp-accept-"));
  const cwd = mkdtempSync(join(tmpdir(), "pp-accept-cwd-"));
  const env = {
    ...process.env,
    PROMPTPRINTER_URL: E2E_ORIGIN,
    PROMPTPRINTER_CONFIG_DIR: dir,
    PROMPTPRINTER_LANG: "de",
    PROMPTPRINTER_NO_BROWSER: "1",
  };
  const start = (args: string[], lines: string[] = []) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(lines.length ? `${lines.join("\n")}\n` : "");
    const done = new Promise<Run>((resolve) => child.on("close", (code) => resolve({ code, out })));
    return { done, output: () => out };
  };
  const accessToken = () => JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).access_token as string;
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { start, accessToken, cleanup };
}

/** Startet `promptprinter login` und wartet, bis der Code auf dem Bildschirm steht. */
async function requestCode(start: ReturnType<typeof program>["start"]) {
  const login = start(["login"]);
  await expect.poll(() => login.output(), { timeout: 30_000 }).toMatch(USER_CODE);
  return { login, code: login.output().match(USER_CODE)![0] };
}

/** Tippt den Code in /cli ein und gibt das Terminal frei, wie ein Mensch. */
async function approveInBrowser(page: Page, code: string) {
  await page.getByLabel("Code aus dem Terminal").fill(code);
  await page.getByRole("button", { name: "Weiter" }).click();
  await expect(page.getByText("(promptprinter)")).toBeVisible();
  await page.getByRole("button", { name: "Terminal anmelden" }).click();
  await expect(page.getByText("Dein Terminal ist angemeldet")).toBeVisible();
}

test("Programm: anmelden im Browser, Konto, Prompt mit Rückfrage, speichern, abmelden", async ({ signedIn: { page, account } }) => {
  test.setTimeout(180_000);
  const { start, accessToken, cleanup } = program();
  try {
    const { login, code } = await requestCode(start);
    await page.goto("/cli");
    await approveInBrowser(page, code);

    const loggedIn = await login.done;
    expect(loggedIn.code, loggedIn.out).toBe(0);
    expect(loggedIn.out).toContain("Angemeldet.");

    // Ein Konto auf Free ohne Key: das Programm sagt, was fehlt, und wo.
    const free = await start(["whoami"]).done;
    expect(free.code, free.out).toBe(0);
    expect(free.out).toContain(`Angemeldet als ${account.email}, Free, kein Key`);
    expect(free.out).toContain(`${E2E_ORIGIN}/settings`);

    const refused = await start([], ["/pp Landingpage", "/exit"]).done;
    expect(refused.out).toContain("eigenen KI-Key");

    await makePro(account);
    const pro = await start([], ["/pp Bewerbungsmail für ein Praktikum", "An eine Firma in Basel", "/save bewerbung", "/copy", "/whoami", "/exit"]).done;
    expect(pro.code, pro.out).toBe(0);
    expect(pro.out).toContain("Finn:");
    expect(pro.out).toContain("Demo-Antwort");
    expect(pro.out).toContain("Pro, Server-Key");
    const token = accessToken();
    expect(pro.out).not.toContain(token);

    // Beide Züge stehen im selben Gespräch, also auch im Browser.
    const { data: rows } = await adminClient().from("messages").select("role, conversation_id").eq("user_id", account.id);
    expect(rows?.filter((row) => row.role === "user")).toHaveLength(2);
    expect(new Set(rows?.map((row) => row.conversation_id)).size).toBe(1);

    const logout = await start(["logout"]).done;
    expect(logout.out).toContain("abgemeldet");
    const res = await page.request.get("/api/cli/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(401);
    const gone = await start(["whoami"]).done;
    expect(gone.code).toBe(1);
  } finally {
    cleanup();
  }
});

test("Programm mit zweitem Faktor: /cli verlangt erst den Code aus der App, danach chattet das Terminal", async ({
  signedIn: { page, account },
  browser,
}) => {
  test.setTimeout(180_000);
  await makePro(account);
  // Den Faktor einrichten wie die Einstellungen: Schlüssel holen, mit einem Code aus ihm bestätigen.
  const enrolled = await page.request.post("/api/auth/mfa", { data: { action: "enroll" } });
  expect(enrolled.status(), await enrolled.text()).toBe(200);
  const { factorId, secret } = await enrolled.json();
  const activated = await page.request.post("/api/auth/mfa", { data: { action: "activate", factorId, code: totpCode(secret) } });
  expect(activated.status(), await activated.text()).toBe(200);

  // Ein zweiter Browser, nur mit dem Passwort angemeldet: so steht man vor /cli, wenn das Terminal den Link öffnet.
  const context = await browser.newContext({ baseURL: E2E_ORIGIN });
  const second = await context.newPage();
  await signIn(second, account);
  const { start, accessToken, cleanup } = program();
  try {
    const { login, code } = await requestCode(start);

    // Ohne den Code aus der App gibt es weder die Seite noch die Freigabe über die Route.
    await second.goto("/cli");
    await expect(second).toHaveURL(/\/login\/zweiter-faktor\?next=%2Fcli/);
    await expect(second.getByRole("heading", { name: "Noch ein Schritt", level: 1 })).toBeVisible();
    const early = await second.request.post("/api/cli/approve", {
      headers: { origin: E2E_ORIGIN },
      data: { userCode: code, action: "approve" },
    });
    expect(early.status()).toBe(403);
    expect((await early.json()).code).toBe("aal2_required");

    await second.getByLabel("Code aus der App").fill(totpCode(secret));
    await second.getByRole("button", { name: "Bestätigen" }).click();
    await expect(second).toHaveURL(/\/cli$/);
    await approveInBrowser(second, code);

    const loggedIn = await login.done;
    expect(loggedIn.code, loggedIn.out).toBe(0);
    expect(loggedIn.out).toContain("Angemeldet.");

    const chat = await start([], ["/pp Absage für ein Vorstellungsgespräch", "Freundlich, kurz", "/whoami", "/exit"]).done;
    expect(chat.code, chat.out).toBe(0);
    expect(chat.out).toContain("Finn:");
    expect(chat.out).toContain("Demo-Antwort");
    expect(chat.out).toContain(`Angemeldet als ${account.email}, Pro, Server-Key`);
    expect(chat.out).not.toContain(accessToken());
    expect(chat.out).not.toContain(secret);

    const logout = await start(["logout"]).done;
    expect(logout.out).toContain("abgemeldet");
  } finally {
    cleanup();
    await context.close();
  }
});
