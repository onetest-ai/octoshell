// Shared helpers for reading and writing a workflow script's `export const meta` block.
//
// The script is NEVER imported or executed. The Claude Code Workflow contract requires `meta` to be
// a pure object literal, so we locate that literal by brace matching and evaluate only it, in an
// empty `node:vm` context: any identifier, call or interpolation throws there instead of running.
//
// Keep this in step with packages/board/src/workflow-meta.ts — the app parses the same files.

import { runInNewContext } from "node:vm";

/** Index of the closing quote of the string/template starting at `i`, or `source.length`. */
function skipString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") { j++; continue; }
    if (ch === quote) return j;
  }
  return source.length;
}

/**
 * Locate `export const meta = { … }`, skipping braces inside strings, templates and comments.
 * Returns `{ literal, start, end }` or null.
 */
export function findMetaSpan(source) {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index + decl[0].length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(source, i); continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { literal: source.slice(open, i + 1), start: open, end: i + 1 };
    }
  }
  return null;
}

const str = (v) => (typeof v === "string" ? v : undefined);

function coerceStep(raw, pi, si) {
  const where = `meta.phases[${pi}].steps[${si}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const id = str(raw.id);
  if (!id) throw new Error(`${where}.id is missing`);
  const agent = str(raw.agent);
  if (!agent) throw new Error(`${where}.agent is missing`);
  const label = str(raw.label);
  if (!label) throw new Error(`${where}.label is missing`);

  const step = { id, agent, label };
  if (str(raw.parallel)) step.parallel = raw.parallel;
  if (str(raw.backend)) step.backend = raw.backend;
  if (Array.isArray(raw.dependsOn)) {
    const ids = raw.dependsOn.filter((d) => typeof d === "string");
    if (ids.length) step.dependsOn = ids;
  }
  return step;
}

function coercePhase(raw, pi) {
  const where = `meta.phases[${pi}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const title = str(raw.title);
  if (!title) throw new Error(`${where}.title is missing`);
  const steps = Array.isArray(raw.steps) ? raw.steps.map((s, si) => coerceStep(s, pi, si)) : [];
  const phase = { title, steps };
  if (str(raw.detail)) phase.detail = raw.detail;
  return phase;
}

/** Parse a workflow script's meta. Throws with a human-readable message on any problem. */
export function parseWorkflowMeta(source) {
  const span = findMetaSpan(source);
  if (!span) throw new Error("no `export const meta` object literal found in workflow.js");

  let raw;
  try {
    raw = runInNewContext(`(${span.literal})`, Object.create(null), { timeout: 50 });
  } catch (err) {
    throw new Error(`meta is not a pure object literal: ${err.message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("meta is not an object");
  const name = str(raw.name);
  if (!name) throw new Error("meta.name is missing");

  const phases = Array.isArray(raw.phases) ? raw.phases.map((p, i) => coercePhase(p, i)) : [];
  return { name, description: str(raw.description) ?? "", phases };
}

/** Render a meta object back into a formatted literal, ready to splice over a span. */
export function serializeMeta(meta) {
  const phaseLines = meta.phases.map((p) => {
    const detail = p.detail ? `, detail: ${JSON.stringify(p.detail)}` : "";
    const steps = p.steps.length
      ? `[\n${p.steps.map((s) => `      ${JSON.stringify(s)},`).join("\n")}\n    ]`
      : "[]";
    return `    { title: ${JSON.stringify(p.title)}${detail}, steps: ${steps} },`;
  });
  return [
    "{",
    `  name: ${JSON.stringify(meta.name)},`,
    `  description: ${JSON.stringify(meta.description)},`,
    "  phases: [",
    ...phaseLines,
    "  ],",
    "}",
  ].join("\n");
}

/** Slugify a name the same way the app does. */
export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}
