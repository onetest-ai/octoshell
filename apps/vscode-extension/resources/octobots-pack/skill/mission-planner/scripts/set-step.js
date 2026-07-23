#!/usr/bin/env node
// Upsert a step in a workflow's `export const meta`, rewriting ONLY that literal.
//
//   set-step.js --workflow <workflow-dir> --phase "<title>" --id <stepId> --agent <name>
//               --label "<text>" [--parallel <group>] [--depends-on <id,id>] [--backend <name>]
//
// The script body is never touched. If meta cannot be located or evaluated we refuse to write —
// clobbering a script we could not read would lose the user's work.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findMetaSpan, parseWorkflowMeta, serializeMeta } from "./workflow-meta.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      args[tok.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { workflow, phase, id, agent, label, parallel, backend } = args;
const dependsOn = args["depends-on"];

if (!workflow || !phase || !id || !agent || !label) {
  console.error(
    'usage: set-step.js --workflow <workflow-dir> --phase "<title>" --id <stepId> --agent <name> ' +
      '--label "<text>" [--parallel <group>] [--depends-on <id,id>] [--backend <name>]',
  );
  process.exit(2);
}

const dir = existsSync(workflow) && statSync(workflow).isDirectory() ? workflow : null;
if (!dir) { console.error(`set-step: not a directory: ${workflow}`); process.exit(2); }

const jsPath = join(dir, "workflow.js");
if (!existsSync(jsPath)) { console.error(`set-step: workflow.js not found in ${workflow}`); process.exit(2); }

const source = readFileSync(jsPath, "utf8");
const span = findMetaSpan(source);
if (!span) {
  console.error("set-step: no `export const meta` object literal found — refusing to rewrite the script");
  process.exit(2);
}

let meta;
try {
  meta = parseWorkflowMeta(source);
} catch (err) {
  console.error(`set-step: ${err.message} — refusing to rewrite the script`);
  process.exit(2);
}

const step = { id, agent, label };
if (parallel) step.parallel = parallel;
if (backend) step.backend = backend;
if (dependsOn) {
  const ids = dependsOn.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) step.dependsOn = ids;
}

// A step id is unique across the whole workflow: drop any existing copy before inserting.
for (const p of meta.phases) p.steps = p.steps.filter((s) => s.id !== id);

let target = meta.phases.find((p) => p.title === phase);
if (!target) {
  target = { title: phase, steps: [] };
  meta.phases.push(target);
}
target.steps.push(step);

writeFileSync(jsPath, source.slice(0, span.start) + serializeMeta(meta) + source.slice(span.end), "utf8");
console.log(`set step ${id} (${agent}) in phase "${phase}" of ${meta.name}`);
