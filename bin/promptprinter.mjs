#!/usr/bin/env node
// Einstieg. Die Versionsprüfung steht vor dem Laden des Programms: eine zu alte Node-Version soll
// einen klaren Satz bekommen und keinen Syntaxfehler aus einer Datei, die niemand kennt.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(`PromptPrinter needs Node 22 or newer, this is Node ${process.versions.node}.`);
  process.exit(1);
}

const { main } = await import("../src/cli.mjs");
process.exitCode = await main(process.argv.slice(2));
