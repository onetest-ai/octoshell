/**
 * Derive a workflow's diagram from its script body.
 *
 * The board's `meta` is GENERATED from the code below it: a hand-written second model of the
 * program drifts from it silently, and the field that draws (`agent`) is not the field that
 * dispatches (`agentType`). Here they are the same field.
 *
 * The script is parsed, never executed. Top-level `return`/`await` are legal in the Workflow
 * dialect because the runtime wraps the body in an async function, so acorn is told to allow them.
 */

import { parse } from "acorn";
import type { WorkflowPhase, WorkflowStep } from "./types.js";

export interface Extraction {
  phases: WorkflowPhase[];
  /** Call sites the extractor could not classify. Reported, never silently dropped. */
  unclassified: { line: number; callee: string }[];
}

interface Node {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

interface Call {
  name: string;
  start: number;
  end: number;
  line: number;
  args: Node[];
}

const LOOPS = new Set(["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
const TRACKED = new Set(["phase", "agent", "workflow", "parallel", "pipeline"]);

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as Node).type === "string";
}

/** Every descendant node, in no particular order. Ranges, not walk order, drive the algorithm. */
function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

export function parseScript(source: string): Node {
  return parse(source, {
    ecmaVersion: 2023,
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as unknown as Node;
}

/** String value of a literal node, or undefined for anything computed. */
export function literalString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  if (node.type === "TemplateLiteral") {
    const quasis = node["quasis"];
    const expressions = node["expressions"];
    if (Array.isArray(quasis) && Array.isArray(expressions) && expressions.length === 0) {
      const first = quasis[0] as Node | undefined;
      const cooked = (first?.["value"] as { cooked?: string } | undefined)?.cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

export function extractPhases(source: string): Extraction {
  const ast = parseScript(source);

  const calls: Call[] = [];
  const loops: { start: number; end: number }[] = [];
  walk(ast, (n) => {
    if (LOOPS.has(n.type)) loops.push({ start: n.start, end: n.end });
    if (n.type !== "CallExpression") return;
    const callee = n["callee"];
    if (!isNode(callee) || callee.type !== "Identifier") return;
    const name = callee["name"];
    if (typeof name !== "string" || !TRACKED.has(name)) return;
    const args = Array.isArray(n["arguments"]) ? (n["arguments"] as unknown[]).filter(isNode) : [];
    calls.push({ name, start: n.start, end: n.end, line: n.loc?.start.line ?? 0, args });
  });
  calls.sort((a, b) => a.start - b.start);

  const titles: string[] = [];
  const addTitle = (t: string): void => {
    if (!titles.includes(t)) titles.push(t);
  };

  for (const call of calls) {
    if (call.name === "phase") {
      const title = literalString(call.args[0]);
      if (title) addTitle(title);
      continue;
    }
    if (call.name !== "agent" && call.name !== "workflow") continue;
    const declared = optionPhase(call);
    if (declared) addTitle(declared);
    else if (titles.length === 0) addTitle(ambientPhase(calls, call) ?? "Run");
  }
  if (titles.length === 0) titles.push("Run");

  const phases: WorkflowPhase[] = titles.map((title) => ({ title, steps: [] as WorkflowStep[] }));
  return { phases, unclassified: [] };
}

/** The `phase` property of a call's options object, when it is a plain string. */
function optionPhase(call: Call): string | undefined {
  const options = call.name === "agent" ? call.args[1] : undefined;
  if (!options || options.type !== "ObjectExpression") return undefined;
  const properties = options["properties"];
  if (!Array.isArray(properties)) return undefined;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property["key"];
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? key["name"] : literalString(key);
    if (name !== "phase") continue;
    const value = property["value"];
    return isNode(value) ? literalString(value) : undefined;
  }
  return undefined;
}

/** Title of the most recent `phase()` call before this one. */
function ambientPhase(calls: Call[], call: Call): string | undefined {
  let title: string | undefined;
  for (const c of calls) {
    if (c.start >= call.start) break;
    if (c.name === "phase") title = literalString(c.args[0]) ?? title;
  }
  return title;
}
