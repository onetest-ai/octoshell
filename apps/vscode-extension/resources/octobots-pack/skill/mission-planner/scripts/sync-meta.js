#!/usr/bin/env node
// Rewrite a workflow's `export const meta` from its own body.
//
//   sync-meta.js <workflow-dir>     one workflow
//   sync-meta.js --all              every workflow under .octobots/campaigns
//
// The body is the source of truth: `meta` is the picture the board draws, and a hand-written
// picture drifts from the program silently. `name` and `description` are authored and preserved;
// only `phases` is generated.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extractPhases } from "./extract-meta.mjs";
import { findMetaSpan, parseWorkflowMeta, serializeMeta } from "./workflow-meta.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: sync-meta.js <workflow-dir> | --all");
  process.exit(2);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name === "workflow.js" ? [p] : [];
  });

const scripts =
  args[0] === "--all"
    ? existsSync(".octobots/campaigns") ? walk(".octobots/campaigns") : []
    : [join(args[0], "workflow.js")];

let changed = 0;
for (const scriptPath of scripts) {
  if (!existsSync(scriptPath)) {
    console.error(`sync-meta: no workflow.js at ${scriptPath}`);
    process.exit(2);
  }
  const source = readFileSync(scriptPath, "utf8");
  const span = findMetaSpan(source);
  if (!span) {
    console.error(`sync-meta: no \`export const meta\` literal in ${scriptPath}`);
    process.exit(2);
  }

  const existing = parseWorkflowMeta(source);
  const { phases, unclassified } = extractPhases(source);
  const next = serializeMeta({ name: existing.name, description: existing.description, phases });
  const updated = source.slice(0, span.start) + next + source.slice(span.end);

  for (const call of unclassified) {
    console.error(`  ${basename(scriptPath)}:${call.line}: ${call.callee}() has no readable label`);
  }
  if (updated === source) {
    console.log(`unchanged ${scriptPath}`);
    continue;
  }
  writeFileSync(scriptPath, updated, "utf8");
  changed++;
  const steps = phases.reduce((n, p) => n + p.steps.length, 0);
  console.log(`updated ${scriptPath} — ${phases.length} phase(s), ${steps} step(s)`);
}
console.log(`${changed} of ${scripts.length} workflow(s) updated`);
