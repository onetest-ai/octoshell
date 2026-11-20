#!/usr/bin/env node
// Usage: node .octobots/tokenomics/attribute.mjs --branch <b> [--session <id>] [--project-dir <dir>]
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadBoard } from "./board.mjs";
import { makeAttributionContext, resolveAttribution, attributionLabels } from "./attribution.mjs";

try {
  const { values } = parseArgs({
    options: {
      branch: { type: "string" },
      session: { type: "string", default: "" },
      "project-dir": { type: "string", default: process.cwd() }
    }
  });
  if (!values.branch)
    throw new Error("Usage: attribute --branch <b> [--session <id>] [--project-dir <dir>]");
  const root = values["project-dir"];
  const board = await loadBoard(root);
  const workLog = new Map();
  const file = join(root, ".octobots/tokenomics/worklog.jsonl");
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line);
        if (e.session_id && e.branch && e.task) workLog.set(`${e.session_id}|${e.branch}`, e.task);
      } catch {
        /* Match rollup: ignore corrupt worklog lines. */
      }
    }
  const target = resolveAttribution(
    values.branch,
    values.session,
    makeAttributionContext(board, workLog)
  );
  console.log(JSON.stringify(attributionLabels(target)));
} catch (error) {
  console.error(`attribute: ${error.message}`);
  process.exitCode = 1;
}
