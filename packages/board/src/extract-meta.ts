/**
 * Derive a workflow's diagram from its script body.
 *
 * The board's `meta` is GENERATED from the code below it: a hand-written second model of the
 * program drifts from it silently, and the field that draws (`agent`) is not the field that
 * dispatches (`agentType`). Here they are the same field.
 *
 * The script is parsed, never executed. Top-level `return`/`await` are legal in the Workflow
 * dialect because the runtime wraps the body in an async function, so acorn is told to allow them.
 *
 * Known limitation: a call is attributed to its LEXICAL position, not to where it is actually
 * invoked at runtime. `parallel([...])` written directly inside a loop body is drawn correctly —
 * its range sits inside the loop's range. But a helper defined ABOVE a loop and only called from
 * inside it — `const round = () => parallel([...]); for (...) { await agent(...); await round() }`
 * — is attributed to its definition site, ahead of the loop: it is not marked `repeat`, and it
 * sorts ahead of steps that in reality run before it every iteration, so `dependsOn` comes out
 * backwards. Fixing this would need control flow through function calls, which this extractor,
 * being purely lexical, does not do.
 *
 * A related, narrower gap: `agentType` is only readable when it is a string literal. A computed
 * value — `agentType: task.role` — dispatches for real at runtime but cannot be drawn, so the step
 * comes out with no `agent` field, same as a step that never named an `agentType` at all. The two
 * are NOT the same finding: one runs as the default subagent (a defect), the other dispatches
 * correctly and simply cannot be shown (not a defect). `computedAgentType` on `Extraction` is how
 * the two are told apart downstream, in `validate`.
 */

import { parse } from "acorn";
import type { WorkflowPhase, WorkflowStep } from "./types.js";

export interface Extraction {
  phases: WorkflowPhase[];
  /** Call sites the extractor could not classify. Reported, never silently dropped. */
  unclassified: { line: number; callee: string }[];
  /**
   * `agent()` calls that DID name an `agentType` — dispatch is real — but as something other than
   * a string literal, so the diagram cannot show which agent runs. Distinct from a step with no
   * `agentType` at all (the step's `agent` field is absent either way, so `validate` needs this
   * list to tell "computed, dispatches fine" apart from "never named one, runs as the default").
   */
  computedAgentType: { line: number; stepId: string }[];
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

  // Ranges that change how a call is drawn. `parallel` is a real fan-out; `pipeline` is not —
  // its stages run in order per item, so they chain and repeat instead.
  const groups: { start: number; end: number; id: string }[] = [];
  const pipelines: { start: number; end: number }[] = [];
  let groupN = 0;
  for (const call of calls) {
    if (call.name === "parallel") groups.push({ start: call.start, end: call.end, id: `g${++groupN}` });
    if (call.name === "pipeline") pipelines.push({ start: call.start, end: call.end });
  }
  const contains = (r: { start: number; end: number }, at: number): boolean => r.start <= at && at < r.end;
  const groupOf = (at: number): string | undefined =>
    groups.filter((g) => contains(g, at)).sort((a, b) => b.start - a.start)[0]?.id;
  const repeats = (at: number): boolean =>
    loops.some((l) => contains(l, at)) || pipelines.some((p) => contains(p, at));

  // Phase order comes from the sequence of `phase()` CALLS, not from wherever the first call that
  // happens to resolve to each title sits lexically — a wrap-up/report helper defined near the top
  // of the file and invoked from many places (often last, on the success path) used to drag its
  // phase to the front of the diagram just by being declared early.
  const declaredTitles: string[] = [];
  for (const call of calls) {
    if (call.name !== "phase") continue;
    const title = literalString(call.args[0]);
    if (title && !declaredTitles.includes(title)) declaredTitles.push(title);
  }

  const titles: string[] = [];
  const addTitle = (t: string): void => {
    if (!titles.includes(t)) titles.push(t);
  };

  if (declaredTitles.length > 0) {
    for (const title of declaredTitles) addTitle(title);
    // A title that appears ONLY in a `{ phase: 'X' }` option — never in a phase() call — is
    // appended after every declared phase, in its own first-appearance order.
    for (const call of calls) {
      if (call.name !== "agent" && call.name !== "workflow") continue;
      const declared = optionPhase(call);
      if (declared) addTitle(declared);
    }
  } else {
    // No phase() calls anywhere: fall back to option/ambient order, ending on "Run" for a
    // genuinely phase-less script.
    for (const call of calls) {
      if (call.name !== "agent" && call.name !== "workflow") continue;
      const declared = optionPhase(call);
      if (declared) addTitle(declared);
      else if (titles.length === 0) addTitle(ambientPhase(calls, call) ?? "Run");
    }
  }
  if (titles.length === 0) titles.push("Run");

  const phases: WorkflowPhase[] = titles.map((title) => ({ title, steps: [] as WorkflowStep[] }));
  const byTitle = new Map(phases.map((p) => [p.title, p]));
  const unclassified: { line: number; callee: string }[] = [];
  const computedAgentType: { line: number; stepId: string }[] = [];

  // Ordering state, keyed by phase title (dependsOn chains) or by group id (parallel members).
  const anchorsByPhase = new Map<string, string[]>();
  const groupAnchors = new Map<string, string[]>();
  const openGroups = new Map<string, string[]>();

  for (const call of calls) {
    if (call.name !== "agent" && call.name !== "workflow") continue;

    const declaredTitle = optionPhase(call);
    const ambientTitle = ambientPhase(calls, call);
    let title: string;
    if (declaredTitle) {
      title = declaredTitle;
    } else if (ambientTitle) {
      title = ambientTitle;
    } else if (declaresNonLiteralPhase(call)) {
      // A `{ phase: someVariable }` this extractor cannot resolve, with no ambient phase() call to
      // fall back on: rather than inventing a phase from wherever this call happens to sit
      // lexically, report it so a later validate step can tell the author to pass a literal.
      unclassified.push({ line: call.line, callee: call.name });
      continue;
    } else {
      title = titles[0] ?? "Run";
    }

    const phase = byTitle.get(title);
    if (!phase) continue;

    const option = options(call);
    const id = `${slugifyTitle(title)}-${phase.steps.length + 1}`;
    const label = call.name === "workflow" ? workflowLabel(call) : renderLabel(option.get("label"));
    const agentTypeNode = option.get("agentType");
    const agent = literalString(agentTypeNode);
    const kind = call.name === "workflow" ? "workflow" : literalString(option.get("kind"));
    const group = groupOf(call.start);
    const repeat = repeats(call.start);
    const backend = literalString(option.get("backend"));

    // Assigned in WorkflowStep's canonical key order — id, label, agent, kind, repeat, parallel,
    // backend, dependsOn (see coerceStep in workflow-meta.ts) — so serializeMeta's
    // JSON.stringify writes a stable field order.
    const step: WorkflowStep = { id, label };
    if (agent) step.agent = agent;
    else if (agentTypeNode !== undefined) {
      // Named, but not a string literal — dispatch is real at runtime, the extractor just cannot
      // read it. Not the "no agentType" defect; `validate` consults this list to say so.
      computedAgentType.push({ line: call.line, stepId: id });
    }
    if (kind === "workflow" || kind === "command") step.kind = kind;
    if (repeat) step.repeat = true;
    if (group) step.parallel = group;
    if (backend) step.backend = backend;

    const anchors = anchorsByPhase.get(title) ?? [];
    if (group) {
      // Every member of a group hangs off whatever preceded the block, not off each other.
      const snapshot = groupAnchors.get(group) ?? anchors;
      groupAnchors.set(group, snapshot);
      if (snapshot.length) step.dependsOn = [...snapshot];
      openGroups.set(group, [...(openGroups.get(group) ?? []), step.id]);
      anchorsByPhase.set(title, openGroups.get(group) ?? []);
    } else {
      if (anchors.length) step.dependsOn = [...anchors];
      anchorsByPhase.set(title, [step.id]);
    }

    if (step.label === "…") unclassified.push({ line: call.line, callee: call.name });
    phase.steps.push(step);
  }

  return { phases, unclassified, computedAgentType };
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

/** True when a call's options object names a `phase` whose value is not a resolvable literal. */
function declaresNonLiteralPhase(call: Call): boolean {
  if (call.name !== "agent") return false;
  const options = call.args[1];
  if (!options || options.type !== "ObjectExpression") return false;
  const properties = options["properties"];
  if (!Array.isArray(properties)) return false;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property["key"];
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? key["name"] : literalString(key);
    if (name !== "phase") continue;
    const value = property["value"];
    return !(isNode(value) && literalString(value) !== undefined);
  }
  return false;
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

/** All string-valued options of a call, plus a marker for options that are computed. */
function options(call: Call): Map<string, Node> {
  const out = new Map<string, Node>();
  const object = call.name === "agent" ? call.args[1] : undefined;
  if (!object || object.type !== "ObjectExpression") return out;
  const properties = object["properties"];
  if (!Array.isArray(properties)) return out;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property["key"];
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? (key["name"] as string) : literalString(key);
    const value = property["value"];
    if (typeof name === "string" && isNode(value)) out.set(name, value);
  }
  return out;
}

/**
 * A human-readable label for a node that may be computed. Anything the extractor cannot resolve
 * becomes "…", so `'build ' + t.id` reads as `build …` rather than vanishing.
 */
export function renderLabel(node: Node | undefined): string {
  if (!node) return "…";
  const direct = literalString(node);
  if (direct !== undefined) return direct;

  if (node.type === "TemplateLiteral") {
    const quasis = (node["quasis"] as unknown[]).filter(isNode);
    return collapse(quasis.map((q) => (q["value"] as { cooked?: string }).cooked ?? "").join("…"));
  }
  if (node.type === "BinaryExpression" && node["operator"] === "+") {
    const left = node["left"];
    const right = node["right"];
    return collapse((isNode(left) ? renderLabel(left) : "…") + (isNode(right) ? renderLabel(right) : "…"));
  }
  return "…";
}

/** Two adjacent unresolved fragments read as one. */
function collapse(text: string): string {
  return text.replace(/…{2,}/g, "…");
}

/** The string value of one property of an ObjectExpression, when it is a plain literal. */
function property(object: Node | undefined, name: string): string | undefined {
  if (!object || object.type !== "ObjectExpression") return undefined;
  const properties = object["properties"];
  if (!Array.isArray(properties)) return undefined;
  for (const p of properties) {
    if (!isNode(p) || p.type !== "Property") continue;
    const key = p["key"];
    if (!isNode(key)) continue;
    const keyName = key.type === "Identifier" ? key["name"] : literalString(key);
    if (keyName !== name) continue;
    const value = p["value"];
    return isNode(value) ? literalString(value) : undefined;
  }
  return undefined;
}

/**
 * `workflow()` takes a name or a `{ scriptPath }`, and its second argument is `args` — not an
 * options object — so a workflow node is labelled by what it runs.
 * `.../workflows/testing/workflow.js` → `testing`.
 */
function workflowLabel(call: Call): string {
  const first = call.args[0];
  const path = literalString(first) ?? property(first, "scriptPath");
  if (!path) return "…";
  const parts = path.replace(/\/workflow\.js$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}

function slugifyTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phase";
}
