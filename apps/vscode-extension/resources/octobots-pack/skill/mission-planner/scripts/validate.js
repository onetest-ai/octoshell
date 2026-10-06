#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { boardRootOf, findLegacyWorkflowFolders, isCampaignDir, legacyWorkflowsWarning } from "./legacy-workflows.mjs";
import { acIdsOf, missionToken, missionTestsFindings, readTestsText, tcProblems } from "./tc-io.mjs";
import { readPending, workspaceRootOf, MALFORMED_PENDING_NOTE } from "./pending-io.mjs";
import { readEntity, resolveEntityFile, KIND_KEYS, KNOWN_KEYS } from "./entity-io.mjs";

const arg = process.argv[2];
if (!arg || !existsSync(arg)) {
  console.error(`validate: file not found: ${arg ?? "(none)"}`);
  process.exit(2);
}

// A test-case file (<campaign>/tests/m<n>/TC-*.md) is checked on its own: its `warning:` lines, exit 0.
if (isTcFile(arg)) checkTcFile(resolve(arg));

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
 * Paths are relative to the board root (even on a copy not named `.octobots`), so the lines match
 * the board library's validateBoard(root).
 */
function legacyWorkflowWarnings() {
  const dir = dirname(path);
  return findLegacyWorkflowFolders(dir, boardRootOf(dir)).map(legacyWorkflowsWarning);
}

/**
 * Non-fatal: the tests-pairing findings (tc-io.mjs `missionTestsFindings`) of this mission, or of every
 * mission of this campaign: the tests README exists and is linked, every acceptance criterion is covered by
 * a TC, the README map agrees with the TC frontmatter, each TC follows the TC format contract. Warnings
 * only: they never change the exit code. Mirrors packages/board/src/validate.ts `missionTestsWarnings`.
 */
function testsWarnings() {
  const dir = dirname(path);
  const base = boardRootOf(dir);
  const forMission = (campaignDir, missionFields) =>
    missionTestsFindings({ campaignDir, campaign: basename(campaignDir), base, mission: missionFields }).map((m) => `warning: ${m}`);
  if (kind === "mission" && format === "yaml") {
    const campaignDir = dirname(dirname(dir));
    if (basename(dirname(dir)) !== "missions" || !isCampaignDir(campaignDir)) return [];
    return forMission(campaignDir, fields);
  }
  if (kind !== "campaign" || !isCampaignDir(dir)) return [];
  const out = [];
  for (const { fields: m } of campaignMissions(dir)) out.push(...forMission(dir, m));
  return out;
}

/**
 * The parsed `mission.yaml` of every mission folder of the campaign at `campaignDir`. A mission whose
 * file does not parse is left out: validating THAT mission reports its error, and one broken sibling
 * must not crash validate.js on the campaign or on a TC file (warnings never change the exit code).
 */
function campaignMissions(campaignDir) {
  const missions = join(campaignDir, "missions");
  const out = [];
  for (const e of existsSync(missions) ? readdirSync(missions, { withFileTypes: true }) : []) {
    const file = join(missions, e.name, "mission.yaml");
    if (!e.isDirectory() || !existsSync(file)) continue;
    try { out.push({ file, fields: readEntity(file, "yaml") }); } catch { /* reported when that mission is validated */ }
  }
  return out;
}

/** True for a path shaped `.../tests/m<n>/TC-*.md` that is a file. */
function isTcFile(p) {
  const abs = resolve(p);
  return /^TC-.*\.md$/.test(basename(abs)) && /^m\d+[a-z]*$/.test(basename(dirname(abs))) &&
    basename(dirname(dirname(abs))) === "tests" && statSync(abs).isFile();
}

/** `validate.js <TC file>`: print the file's `warning:` lines and exit 0 (a TC problem is never an error). */
function checkTcFile(file) {
  const dir = dirname(file);
  const folder = basename(dir);
  const campaignDir = dirname(dirname(dir));
  const base = boardRootOf(dir);
  // The mission this folder belongs to (its criteria bound what `covers` may name); unknown -> prefix check only.
  let acIds = null;
  for (const { fields: m } of campaignMissions(campaignDir)) {
    const token = missionToken(m.name);
    if (token?.folder === folder) { acIds = acIdsOf(token.id, m.acceptanceCriteria.length); break; }
  }
  const rel = relative(base, file).split(sep).join("/");
  const problems = tcProblems({ fileName: basename(file), folder, text: readTestsText(file) ?? "", acIds });
  console.log(`OK ${file}`);
  for (const p of problems) console.log(`warning: ${rel}: ${p}`);
  process.exit(0);
}

/**
 * Non-fatal: pack skills awaiting an agent's reconcile (.octobots/pack-updates/pending.json of the
 * workspace this entity sits in), one line each; a pending.json that cannot be read is one line.
 */
function packReconcileWarnings() {
  const root = workspaceRootOf(dirname(path));
  if (!root) return [];
  const pending = readPending(root);
  if (pending.state === "malformed") return [`warning: ${MALFORMED_PENDING_NOTE}`];
  if (pending.state === "none") return [];
  return pending.record.skills.map((s) => `warning: pack reconcile pending: ${s.skill} (v${pending.record.packVersion})`);
}

function report() {
  const warnings = [...legacyWorkflowWarnings(), ...testsWarnings(), ...packReconcileWarnings()];
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
