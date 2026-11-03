import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Veröffentlichen ist Kasums Entscheid (CLAUDE.md). Der Workflow darf deshalb nur auf einen Tag hin laufen, den jemand von
// Hand setzt, und meldet sich bei npm per OIDC an: ein Token im Repo wäre ein zweiter Weg an ihm vorbei.
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("der Release-Workflow startet nur mit einem Versions-Tag", () => {
  const trigger = /^on:\r?\n([\s\S]*?)^\S/m.exec(workflow)?.[1];
  assert.equal(trigger?.trim(), 'push:\n    tags: ["v*.*.*"]');
});

test("der Release-Workflow kennt kein npm-Token und veröffentlicht mit Provenance", () => {
  assert.doesNotMatch(workflow, /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
  assert.match(workflow, /^ {6}id-token: write$/m);
  assert.match(workflow, /^permissions:\r?\n {2}contents: read\r?\n/m);
  assert.match(workflow, /npm publish --provenance/);
});
