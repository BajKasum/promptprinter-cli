// Vergleicht die Dateien im Haupt-Repo, auf denen dieses Programm aufbaut, mit den festgehaltenen
// Prüfsummen. Jede Änderung schlägt an, auch ein Kommentar: lieber einmal zu oft lesen als einen
// geänderten Vertrag erst bei einem Nutzer merken. `--update` schreibt den heutigen Stand fest.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PINS = new URL("../contract/pins.json", import.meta.url);
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
  "src/server/cli-login/messages.ts",
];

async function hash(path) {
  const res = await fetch(RAW + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const text = (await res.text()).replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

const current = Object.fromEntries(await Promise.all(FILES.map(async (path) => [path, await hash(path)])));

if (process.argv.includes("--update")) {
  writeFileSync(PINS, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`${FILES.length} Prüfsummen geschrieben`);
} else {
  const pinned = JSON.parse(readFileSync(PINS, "utf8"));
  const changed = FILES.filter((path) => pinned[path] !== current[path]);
  for (const path of changed) console.error(`geändert: ${path}`);
  if (changed.length > 0) {
    console.error("Lesen, hier nachziehen, dann: node scripts/check-contract.mjs --update");
    process.exit(1);
  }
  console.log(`${FILES.length} Dateien unverändert`);
}
