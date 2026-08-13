#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseWorkflowMeta } from "./workflow-meta.mjs";
import { readEntity, resolveEntityFile, KIND_KEYS, KNOWN_KEYS } from "./entity-io.mjs";

const arg = process.argv[2];
if (!arg || !existsSync(arg)) {
  console.error(`validate: file not found: ${arg ?? "(none)"}`);
  process.exit(2);
}

// Resolve the target: a workflow (workflow.js or a folder holding one) or an entity (<kind>.yaml /
// legacy <kind>.md, or a folder holding one).
let path;
let kind;
if (statSync(arg).isDirectory()) {
  if (existsSync(join(arg, "workflow.js"))) {
    path = join(arg, "workflow.js");
    kind = "workflow";
  } else {
    const ent = resolveEntityFile(arg);
    if (!ent) { console.error(`validate: no entity (<kind>.yaml) or workflow.js in ${arg}`); process.exit(2); }
    path = ent.file;
    kind = ent.kind;
  }
} else if (basename(arg) === "workflow.js") {
  path = arg;
  kind = "workflow";
} else {
  const ent = resolveEntityFile(arg);
  if (!ent) { console.error(`validate: not an entity file (<kind>.yaml) or workflow.js: ${arg}`); process.exit(2); }
  path = ent.file;
  kind = ent.kind;
}

const problems = [];

// A workflow is validated against its script, not against the task/mission contract.
if (kind === "workflow") {
  for (const p of validateWorkflowDir(dirname(path))) problems.push(p);
  report();
}

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

// A campaign or mission owns workflow folders. EITHER may hold several — a mission normally has one
// per execution loop (implementation / testing / fixing), which is why there is no count check here.
if (kind === "campaign" || kind === "mission") {
  const dir = dirname(path);
  const workflowsDir = join(dir, "workflows");
  const slugs = existsSync(workflowsDir)
    ? readdirSync(workflowsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((slug) => existsSync(join(workflowsDir, slug, "workflow.js")))
    : [];
  for (const slug of slugs) {
    for (const p of validateWorkflowDir(join(workflowsDir, slug))) {
      problems.push(`workflow "${slug}": ${p}`);
    }
  }
}

report();

function report() {
  if (problems.length) {
    console.error(`INVALID ${path}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK ${path}`);
  process.exit(0);
}

/**
 * Validate one workflow folder against its `workflow.js` meta. Returns a list of problems.
 * Mirrors packages/board/src/validate.ts `validateWorkflow` — keep the two in step.
 */
function validateWorkflowDir(dir) {
  const out = [];
  const slug = basename(dir);
  const jsPath = join(dir, "workflow.js");
  if (!existsSync(jsPath)) return ["workflow.js is missing"];

  let meta;
  try {
    meta = parseWorkflowMeta(readFileSync(jsPath, "utf8"));
  } catch (err) {
    return [err.message];
  }

  if (meta.name !== slug) out.push(`meta.name "${meta.name}" does not match its folder "${slug}"`);
  if (meta.phases.length === 0) {
    out.push("workflow has no phases");
    return out;
  }

  const stepPhase = new Map();
  const parallelPhase = new Map();
  meta.phases.forEach((phase, pi) => {
    if (phase.steps.length === 0) out.push(`phase "${phase.title}" has no steps`);
    for (const step of phase.steps) {
      if (stepPhase.has(step.id)) out.push(`duplicate step id "${step.id}"`);
      else stepPhase.set(step.id, pi);
      if (step.parallel !== undefined) {
        const seen = parallelPhase.get(step.parallel);
        if (seen !== undefined && seen !== pi) {
          out.push(`parallel group "${step.parallel}" spans more than one phase`);
        } else if (seen === undefined) {
          parallelPhase.set(step.parallel, pi);
        }
      }
    }
  });
  for (const phase of meta.phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepPhase.has(dep)) out.push(`step "${step.id}" dependsOn "${dep}", which is not a step`);
      }
    }
  }
  return out;
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
