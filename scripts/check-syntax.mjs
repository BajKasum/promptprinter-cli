// `node --check` für alle Quellen, plattformunabhängig (die Shell von npm kennt unter Windows keine Globs).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = ["bin", "src", "scripts", "test", join("test", "support")].flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => join(dir, name))
);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
}
console.log(`${files.length} Dateien geprüft`);
