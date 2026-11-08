// Vergleicht die Dateien im Haupt-Repo, auf denen dieses Programm aufbaut, mit den festgehaltenen
// Prüfsummen. Jede Änderung schlägt an, auch ein Kommentar: lieber einmal zu oft lesen als einen
// geänderten Vertrag erst bei einem Nutzer merken. `--update` schreibt den heutigen Stand fest.
//
// Dazu die Quelle von src/context.mjs in promptprinter-pp (contract/context-pin.json). Ändert sie sich,
// wird die Datei neu kopiert und der Pin von Hand nachgezogen; `--update` fasst ihn nicht an, denn ohne
// neue Kopie stimmte er nicht mehr mit src/context.mjs überein.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PINS = new URL("../contract/pins.json", import.meta.url);
const CONTEXT_PIN = new URL("../contract/context-pin.json", import.meta.url);
const RAW = "https://raw.githubusercontent.com/BajKasum/PromptPrinter/main/";
const FILES = [
  "src/shared/lib/chat-stream.ts",
  "src/shared/lib/chat-limits.ts",
  "src/shared/lib/saved-prompts.ts",
  "src/shared/lib/ai-marker.ts",
  "src/features/chat/lib/normalize-fences.ts",
  "src/app/api/cli/device/route.ts",
  "src/app/api/cli/token/route.ts",
  "src/app/api/cli/refresh/route.ts",
  "src/app/api/cli/logout/route.ts",
  "src/app/api/cli/me/route.ts",
  "src/app/api/cli/prompts/route.ts",
  "src/app/api/cli/prompts/[id]/route.ts",
  "src/server/cli-login/saved-prompts.ts",
  "src/server/cli-login/messages.ts",
];

async function hash(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = (await res.text()).replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

const current = Object.fromEntries(await Promise.all(FILES.map(async (path) => [path, await hash(RAW + path)])));
const context = JSON.parse(readFileSync(CONTEXT_PIN, "utf8"));
const contextChanged = (await hash(`https://raw.githubusercontent.com/${context.repo}/main/${context.path}`)) !== context.sha256;
if (contextChanged) {
  console.error(`geändert: ${context.repo} ${context.path}`);
  console.error("Lesen, src/context.mjs neu kopieren (Kopf und export behalten), dann contract/context-pin.json nachziehen");
}

if (process.argv.includes("--update")) {
  writeFileSync(PINS, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`${FILES.length} Prüfsummen geschrieben`);
  if (contextChanged) process.exit(1);
} else {
  const pinned = JSON.parse(readFileSync(PINS, "utf8"));
  const changed = FILES.filter((path) => pinned[path] !== current[path]);
  for (const path of changed) console.error(`geändert: ${path}`);
  if (changed.length > 0) console.error("Lesen, hier nachziehen, dann: node scripts/check-contract.mjs --update");
  if (changed.length > 0 || contextChanged) process.exit(1);
  console.log(`${FILES.length + 1} Dateien unverändert`);
}
