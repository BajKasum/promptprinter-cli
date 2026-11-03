import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Was `npm publish` hochladen würde, fragt npm selbst: dieselbe Liste wie beim Veröffentlichen, ohne etwas zu schreiben.
// Ins Paket gehört nur, was das Programm zum Laufen braucht. Tests, Skripte, die Abnahme und erst recht eine .env-Datei
// gehören nicht hinein, und npm lässt eine .env in einem der Ordner aus "files" nicht von sich aus weg.
function packedFiles() {
  // Über die Shell, weil npm unter Windows eine .cmd-Datei ist. Der Befehl ist fest, nichts wird eingesetzt.
  const result = spawnSync("npm pack --dry-run --json --ignore-scripts", { cwd: ROOT, encoding: "utf8", shell: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  return pack.files.map((file) => file.path.replaceAll("\\", "/")).sort();
}

test("das Paket enthält nur Programm, Lizenz, README und package.json", () => {
  const files = packedFiles();
  const expected = [
    "LICENSE",
    "README.md",
    "bin/promptprinter.mjs",
    "package.json",
    ...readdirSync(join(ROOT, "src")).map((name) => `src/${name}`),
  ].sort();
  assert.deepEqual(files, expected);
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)\.env/, file);
    assert.doesNotMatch(file, /^(test|scripts|acceptance|contract|\.github)\//, file);
  }
});
