/**
 * Reading and writing the `export const meta = { … }` block of a workflow script.
 *
 * The script is a Claude Code dynamic-workflow script and is NEVER imported or executed here.
 * The Workflow contract requires `meta` to be a pure object literal, so we locate that literal by
 * brace matching and evaluate only it, in an empty `node:vm` context: any identifier, call or
 * template interpolation resolves to nothing there and throws instead of running.
 */

import { runInNewContext } from "node:vm";
import type { WorkflowPhase, WorkflowStep } from "./types.js";

export interface MetaSpan {
  /** The literal text, `{` through `}` inclusive. */
  literal: string;
  /** Index of the opening `{` in the source. */
  start: number;
  /** Index one past the closing `}` in the source. */
  end: number;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases: WorkflowPhase[];
}

/** Index of the closing quote of the string/template starting at `i`, or `source.length`. */
function skipString(source: string, i: number): number {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === quote) return j;
  }
  return source.length;
}

/**
 * Locate the `export const meta = { … }` object literal, skipping braces that appear inside
 * strings, template literals and comments. Returns null when the export is absent or the
 * literal never closes.
 */
export function findMetaSpan(source: string): MetaSpan | null {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!decl) return null;
  const open = source.indexOf("{", decl.index + decl[0].length);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const STEP_KINDS = new Set(["agent", "workflow", "command"]);

function coerceStep(raw: unknown, phaseIndex: number, stepIndex: number): WorkflowStep {
  const where = `meta.phases[${phaseIndex}].steps[${stepIndex}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const o = raw as Record<string, unknown>;

  const id = asString(o["id"]);
  if (!id) throw new Error(`${where}.id is missing`);
  const label = asString(o["label"]);
  if (!label) throw new Error(`${where}.label is missing`);

  const step: WorkflowStep = { id, label };
  const agent = asString(o["agent"]);
  if (agent) step.agent = agent;
  const kind = asString(o["kind"]);
  if (kind && STEP_KINDS.has(kind)) step.kind = kind as WorkflowStep["kind"];
  if (o["repeat"] === true) step.repeat = true;
  const parallel = asString(o["parallel"]);
  if (parallel) step.parallel = parallel;
  const backend = asString(o["backend"]);
  if (backend) step.backend = backend;
  const dependsOn = o["dependsOn"];
  if (Array.isArray(dependsOn)) {
    const ids = dependsOn.filter((d): d is string => typeof d === "string");
    if (ids.length) step.dependsOn = ids;
  }
  return step;
}

function coercePhase(raw: unknown, phaseIndex: number): WorkflowPhase {
  const where = `meta.phases[${phaseIndex}]`;
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} is not an object`);
  const o = raw as Record<string, unknown>;

  const title = asString(o["title"]);
  if (!title) throw new Error(`${where}.title is missing`);

  const rawSteps = o["steps"];
  const steps = Array.isArray(rawSteps) ? rawSteps.map((s, j) => coerceStep(s, phaseIndex, j)) : [];

  const phase: WorkflowPhase = { title, steps };
  const detail = asString(o["detail"]);
  if (detail) phase.detail = detail;
  return phase;
}

/**
 * Parse a workflow script's `meta`. Throws with a human-readable message when the export is
 * missing, is not a pure literal, or does not match the schema.
 */
export function parseWorkflowMeta(source: string): WorkflowMeta {
  const span = findMetaSpan(source);
  if (!span) throw new Error("no `export const meta` object literal found in workflow.js");

  let raw: unknown;
  try {
    raw = runInNewContext(`(${span.literal})`, Object.create(null) as object, { timeout: 50 });
  } catch (err) {
    throw new Error(`meta is not a pure object literal: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("meta is not an object");

  const o = raw as Record<string, unknown>;
  const name = asString(o["name"]);
  if (!name) throw new Error("meta.name is missing");

  const rawPhases = o["phases"];
  const phases = Array.isArray(rawPhases) ? rawPhases.map((p, i) => coercePhase(p, i)) : [];

  return { name, description: asString(o["description"]) ?? "", phases };
}

/**
 * Carry the AUTHORED fields of a workflow's existing phases onto the phases just extracted from its
 * body, matching on title.
 *
 * Everything about a phase except `detail` is derived from the code — title, steps, ids, edges — so
 * regeneration simply overwrites it. `detail` is not: it is a caption a human writes, and it is the
 * one `meta.phases` field Claude Code's own Workflow runtime consumes. Nothing in the body carries
 * it, so an extraction that dropped it would make every `detail`-bearing workflow report
 * "meta is out of date" forever, and sync-meta.js would "fix" that by deleting the caption.
 *
 * Every regenerate — sync-meta.js writing the file, and validate.ts checking whether it would — must
 * go through here, so the two agree on what a current `meta` looks like.
 * Mirrors the pack's `workflow-meta.mjs` `mergeAuthoredPhases` — keep the two in step.
 */
export function mergeAuthoredPhases(existing: WorkflowPhase[], generated: WorkflowPhase[]): WorkflowPhase[] {
  const detailByTitle = new Map<string, string>();
  for (const phase of existing) {
    if (phase.detail && !detailByTitle.has(phase.title)) detailByTitle.set(phase.title, phase.detail);
  }
  return generated.map((phase) => {
    const detail = detailByTitle.get(phase.title);
    return detail === undefined ? phase : { ...phase, detail };
  });
}

/** Render a meta object back into a formatted literal, ready to splice over a `MetaSpan`. */
export function serializeMeta(meta: WorkflowMeta): string {
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
