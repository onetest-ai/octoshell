#!/usr/bin/env node
// Append a run entry to a workflow's runs.jsonl log (one JSON object per line).
//
//   add-run.js --workflow <workflow-dir> --status <done|failed|cancelled|executing>
//              --summary "<text>" [--at YYYY-MM-DD]
//
// The board reads the newest well-formed line's status as the workflow's last run status.

import { existsSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

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

const { workflow, status, summary, at } = parseArgs(process.argv.slice(2));

if (!workflow || !status || !summary) {
  console.error(
    'usage: add-run.js --workflow <workflow-dir> --status <done|failed|cancelled|executing> ' +
      '--summary "<text>" [--at YYYY-MM-DD]',
  );
  process.exit(2);
}

const dir = existsSync(workflow) && statSync(workflow).isDirectory() ? workflow : null;
if (!dir) { console.error(`add-run: not a directory: ${workflow}`); process.exit(2); }
if (!existsSync(join(dir, "workflow.js"))) {
  console.error(`add-run: workflow.js not found in ${workflow} (not a workflow folder)`);
  process.exit(2);
}

const when = (at ?? "").trim() || new Date().toISOString().slice(0, 10);
const entry = { status, summary, at: when };
appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(entry) + "\n", "utf8");
console.log(`run: [${status}] ${when} — ${summary}`);
