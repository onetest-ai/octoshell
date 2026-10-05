#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { dirname, resolve, parse } from "node:path";
import { findLegacyWorkflowFolders, legacyWorkflowsWarning } from "./legacy-workflows.mjs";
import { readEntity, resolveEntityFile, KIND_KEYS, KNOWN_KEYS } from "./entity-io.mjs";

const arg = process.argv[2];
if (!arg || !existsSync(arg)) {
  console.error(`validate: file not found: ${arg ?? "(none)"}`);
  process.exit(2);
}

// Resolve the target: an entity file (<kind>.yaml / legacy <kind>.md) or a folder holding one.
const ent = resolveEntityFile(arg);
if (!ent) {
  console.error(`validate: ${statSync(arg).isDirectory() ? "no entity (<kind>.yaml) in" : "not an entity file (<kind>.yaml):"} ${arg}`);
  process.exit(2);
}
const path = ent.file;
const kind = ent.kind;

const problems = [];

// Entity (<kind>.yaml) validation.
const format = path.endsWith(".yaml") ? "yaml" : "md";
const fields = readEntity(path, format);

// Name present + descriptive (not a placeholder like "T1" / "M3.2" / "Task 3").
if (!fields.name) {
  problems.push("missing a `name`");
} else if (isPlaceholderName(fields.name)) {
  problems.push(
    `name "${fields.name.trim()}" is just an id/placeholder — use the form \`<id> - descriptive name\` ` +
      `(e.g. "M3 - Skills workspace", "T3.1 - Add JWT validation to /login"); the bare id alone is not a name`,
  );
}

// Missions and tasks must carry at least one verifiable acceptance criterion.
if ((kind === "mission" || kind === "task") && !fields.acceptanceCriteria.some((c) => c.text.trim())) {
  problems.push(
    "no acceptance criteria — add at least one `acceptance_criteria` item (use set-criterion.js); " +
      "a task/mission without a verifiable criterion is not well-formed",
  );
}

// A key this schema knows but this kind does not own. It is preserved across writes (nothing is
// silently deleted) but the board never reads it, so it is reported rather than left to rot.
for (const key of Object.keys(fields.extra ?? {})) {
  if (!KNOWN_KEYS.includes(key) || KIND_KEYS[kind].includes(key)) continue;
  const owners = Object.keys(KIND_KEYS).filter((k) => KIND_KEYS[k].includes(key));
  problems.push(
    `\`${key}\` is not a ${kind} field (${owners.length ? `${owners.join("/")} only` : "no kind uses it"}) — ` +
      "it is preserved on disk but the board ignores it",
  );
}

// Criteria that were appended as prose into `notes` instead of written to `acceptance_criteria`
// ("stranded criteria"): they read fine to a human but are invisible to the board model.
if (kind === "campaign" || kind === "mission" || kind === "task") {
  const stranded = strandedCriteria(fields.notes);
  if (stranded.length) {
    problems.push(
      `${stranded.length} acceptance criterion-shaped line(s) stranded in \`notes\` ` +
        `(first: "${stranded[0]}") — notes are free-form prose the board never reads as criteria; ` +
        "move them into `acceptance_criteria` with set-criterion.js and never append them by hand",
    );
  }
}

report();

/**
 * Non-fatal: `workflows/` folders under this campaign or mission are no longer read (pack v57).
 * Paths are relative to the enclosing `.octobots/` so the lines match the board library's validateBoard.
 */
function legacyWorkflowWarnings() {
  const dir = resolve(dirname(path));
  let base = dir;
  for (let d = dir; ; d = dirname(d)) {
    if (parse(d).base === ".octobots") { base = d; break; }
    if (d === parse(d).root) break;
  }
  return findLegacyWorkflowFolders(dir, base).map(legacyWorkflowsWarning);
}

function report() {
  const warnings = legacyWorkflowWarnings();
  if (problems.length) {
    console.error(`INVALID ${path}:`);
    for (const p of problems) console.error(`  - ${p}`);
    for (const w of warnings) console.log(w);
    process.exit(1);
  }
  console.log(`OK ${path}`);
  for (const w of warnings) console.log(w);
  process.exit(0);
}

/**
 * Checkbox lines sitting in an entity's free-form `notes` — acceptance criteria that were appended
 * as text instead of written through the parser. Returns their texts.
 * Mirrors packages/board/src/validate.ts `strandedCriteria` — keep the two in step.
 */
function strandedCriteria(notes) {
  const out = [];
  for (const line of String(notes ?? "").split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[[ xX]\]\s*(\S.*)$/);
    if (m) out.push((m[1] ?? "").trim());
  }
  return out;
}

/** A name is a placeholder if it's empty, a letter-prefixed sequence number, a bare number, or a generic word. */
function isPlaceholderName(raw) {
  const s = (raw ?? "").trim().replace(/\*\*/g, "").trim();
  if (!s) return true;
  if (/^[A-Za-z]{1,4}\d+(\.\d+)?$/.test(s)) return true; // T1, M3, T5.5, TSK12, C2
  if (/^\d+(\.\d+)?$/.test(s)) return true; // bare number
  if (/^(task|mission|campaign|bug|phase|step|item|untitled|tbd|todo|new\s+\w+)\s*\d*(\.\d+)?$/i.test(s)) return true;
  return false;
}
