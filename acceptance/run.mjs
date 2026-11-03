// Startet die Abnahme im Haupt-Repo: kopiert program.spec.ts nach e2e/tmp/ (dort von Git ignoriert), lässt Playwright
// gegen den lokalen Stack laufen und räumt danach auf. Voraussetzungen und Aufruf: acceptance/README.md.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [repoArg, ...extra] = process.argv.slice(2);
const repo = resolve(repoArg ?? process.env.PROMPTPRINTER_REPO ?? join(here, "..", "..", "PromptPrinter"));
const playwright = join(repo, "node_modules", "@playwright", "test", "cli.js");
if (!existsSync(playwright)) {
  console.error(`Kein Haupt-Repo mit installiertem Playwright unter ${repo}. Aufruf: node acceptance/run.mjs <Pfad zum Haupt-Repo>`);
  process.exit(2);
}

const tmpDir = join(repo, "e2e", "tmp");
const target = join(tmpDir, "cli-program.spec.ts");
// Der Dev-Server von Next legt beim Start eine AGENTS.md ins Repo. Die gehört nicht dazu, wenn sie vorher nicht da war.
const agents = join(repo, "AGENTS.md");
const leftovers = [existsSync(tmpDir) ? target : tmpDir, ...(existsSync(agents) ? [] : [agents])];

mkdirSync(tmpDir, { recursive: true });
copyFileSync(join(here, "program.spec.ts"), target);
let status = 1;
try {
  const result = spawnSync(process.execPath, [playwright, "test", "e2e/tmp/cli-program.spec.ts", ...extra], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, PROMPTPRINTER_CLI_BIN: join(here, "..", "bin", "promptprinter.mjs") },
  });
  status = result.status ?? 1;
} finally {
  for (const path of leftovers) rmSync(path, { recursive: true, force: true });
}
process.exit(status);
