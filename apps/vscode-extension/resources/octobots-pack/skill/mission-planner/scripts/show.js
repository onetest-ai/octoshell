#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readEntity, resolveEntityFile } from "./entity-io.mjs";

// Show an entity from its `<kind>.yaml` (falling back to a legacy `<kind>.md`). Default: print the raw
// file. `--digest`: print a compact title + description + acceptance-criteria summary.
const arg = process.argv[2];
const digest = process.argv.includes("--digest");
if (!arg || !existsSync(arg)) { console.error(`show: file not found: ${arg ?? "(none)"}`); process.exit(2); }

const resolved = resolveEntityFile(arg);
if (!resolved) { console.error(`show: not an entity file or folder: ${arg}`); process.exit(2); }

if (!digest) {
  process.stdout.write(readFileSync(resolved.file, "utf8"));
  process.exit(0);
}

const f = readEntity(resolved.file, resolved.format);
console.log(f.name || "(untitled)");
if (f.description) console.log(`\nDescription: ${f.description}`);
if (f.acceptanceCriteria.length) {
  console.log("\nAcceptance Criteria:");
  for (const c of f.acceptanceCriteria) console.log(`- [${c.done ? "x" : " "}] ${c.text}`);
}
// Notes carry the recorded decisions/sign-offs — surface them, or an agent reading only the digest
// edits the entity without ever seeing why it is what it is.
if (f.notes) console.log(`\nNotes:\n${f.notes}`);
