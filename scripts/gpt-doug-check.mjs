import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const manifest = JSON.parse(await readFile(join(root, "gpt-doug.manifest.json"), "utf8"));
const ontology = JSON.parse(await readFile(join(root, manifest.ontology), "utf8"));
const adapter = await import(join(root, manifest.adapter));

assert.equal(manifest.schemaVersion, "1.0");
assert.equal(manifest.id, "repo:sonoxo/pokemonlive");
assert.equal(manifest.moduleId, "gpt-doug-llm:pokemonlive");
assert.equal(manifest.governance.battleOutcomeAuthority, "rules-engine");
assert.equal(manifest.governance.mayMutateBattleOutcome, false);
assert.equal(ontology.ontologyId, manifest.moduleId);
assert.ok(Array.isArray(ontology.objectTypes) && ontology.objectTypes.length >= 6);
assert.ok(Array.isArray(ontology.linkTypes) && ontology.linkTypes.length >= 4);
assert.ok(ontology.deniedActions.includes("DECLARE_WINNER"));
assert.equal(adapter.GPT_DOUG_MODULE_ID, manifest.moduleId);
assert.equal(adapter.gptDougHealth().ok, true);

console.log(`GPT-DOUG integration OK: ${manifest.moduleId}`);
