// Mirror of packages/board/src/extract-meta.ts — the app parses the same scripts.
// Kept in step by packages/board/test/extract-meta-parity.test.ts over the nine-workflow corpus.

import { parse } from "./vendor/acorn.mjs";

const LOOPS = new Set(["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"]);
const TRACKED = new Set(["phase", "agent", "workflow", "parallel", "pipeline"]);

function isNode(v) {
  return typeof v === "object" && v !== null && typeof v.type === "string";
}

/** Every descendant node, in no particular order. Ranges, not walk order, drive the algorithm. */
function walk(node, visit) {
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

export function parseScript(source) {
  return parse(source, {
    ecmaVersion: 2023,
    sourceType: "module",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  });
}

/** String value of a literal node, or undefined for anything computed. */
export function literalString(node) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis;
    const expressions = node.expressions;
    if (Array.isArray(quasis) && Array.isArray(expressions) && expressions.length === 0) {
      const first = quasis[0];
      const cooked = first?.value?.cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

export function extractPhases(source) {
  const ast = parseScript(source);

  const calls = [];
  const loops = [];
  walk(ast, (n) => {
    if (LOOPS.has(n.type)) loops.push({ start: n.start, end: n.end });
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (!isNode(callee) || callee.type !== "Identifier") return;
    const name = callee.name;
    if (typeof name !== "string" || !TRACKED.has(name)) return;
    const args = Array.isArray(n.arguments) ? n.arguments.filter(isNode) : [];
    calls.push({ name, start: n.start, end: n.end, line: n.loc?.start.line ?? 0, args });
  });
  calls.sort((a, b) => a.start - b.start);

  // Ranges that change how a call is drawn. `parallel` is a real fan-out; `pipeline` is not —
  // its stages run in order per item, so they chain and repeat instead (and therefore every call
  // site inside a `pipeline(...)`, whose items are computed by definition, is already `repeat`).
  const groups = [];
  const pipelines = [];
  // `parallel(...)` whose members are COMPUTED — the idiomatic `parallel(tasks.map(t => () =>
  // agent(…)))`, or a literal array with a spread in it. One lexical call site stands for N
  // concurrent runs, and it is not inside a loop, so nothing else would badge it. Drawing an N-wide
  // fan-out as a single unbadged node understates concurrency, which is the dangerous direction of
  // error here: the diagram exists to make concurrency visible, and file-writing steps share one
  // working tree. A literal array of thunks keeps the old behaviour — those really are a known,
  // enumerable set, and each member has its own call site to draw.
  const fannedOut = [];
  let groupN = 0;
  for (const call of calls) {
    if (call.name === "parallel") {
      groups.push({ start: call.start, end: call.end, id: `g${++groupN}` });
      if (!isEnumerableThunkList(call.args[0])) fannedOut.push({ start: call.start, end: call.end });
    }
    if (call.name === "pipeline") pipelines.push({ start: call.start, end: call.end });
  }
  const contains = (r, at) => r.start <= at && at < r.end;
  const groupOf = (at) => groups.filter((g) => contains(g, at)).sort((a, b) => b.start - a.start)[0]?.id;
  const repeats = (at) =>
    loops.some((l) => contains(l, at)) ||
    pipelines.some((p) => contains(p, at)) ||
    fannedOut.some((f) => contains(f, at));

  // Phase order comes from the sequence of `phase()` CALLS, not from wherever the first call that
  // happens to resolve to each title sits lexically — a wrap-up/report helper defined near the top
  // of the file and invoked from many places (often last, on the success path) used to drag its
  // phase to the front of the diagram just by being declared early.
  const declaredTitles = [];
  for (const call of calls) {
    if (call.name !== "phase") continue;
    const title = literalString(call.args[0]);
    if (title && !declaredTitles.includes(title)) declaredTitles.push(title);
  }

  const titles = [];
  const addTitle = (t) => {
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

  const phases = titles.map((title) => ({ title, steps: [] }));
  const byTitle = new Map(phases.map((p) => [p.title, p]));
  // Step ids are `<phase-slug>-<n>`, so two phases whose titles slugify the same — `phase('Build')`
  // and `phase('build')` are two real bands, not one — would mint two `build-1` steps. The diagram
  // keys its nodes by id and would collapse every implicit edge between them into a self-loop, so
  // the slug is disambiguated per phase instead of the phases being folded together.
  const slugByTitle = new Map();
  const usedSlugs = new Set();
  for (const title of titles) {
    const base = slugifyTitle(title);
    let slug = base;
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
    usedSlugs.add(slug);
    slugByTitle.set(title, slug);
  }
  // Unreadable call sites, each tagged with WHICH half was unreadable: "phase" is a
  // `{ phase: someVar }` that cannot be placed in a band (the call is dropped from the diagram),
  // "label" is a call that IS placed but whose caption rendered as nothing but an ellipsis.
  const unclassified = [];
  // `agent()` calls that DID name an agentType, but as something other than a string literal —
  // dispatch is real, the extractor just cannot read it. Distinct from a step with no agentType at
  // all: the step's `agent` field is absent either way, so `validate` consults this list to tell
  // "computed, dispatches fine" apart from "never named one, runs as the default subagent".
  const computedAgentType = [];

  // Ordering state, keyed by phase title (dependsOn chains) or by group id (parallel members).
  const anchorsByPhase = new Map();
  const groupAnchors = new Map();
  const openGroups = new Map();

  for (const call of calls) {
    if (call.name !== "agent" && call.name !== "workflow") continue;

    const declaredTitle = optionPhase(call);
    const ambientTitle = ambientPhase(calls, call);
    let title;
    if (declaredTitle) {
      title = declaredTitle;
    } else if (ambientTitle) {
      title = ambientTitle;
    } else if (declaresNonLiteralPhase(call)) {
      // A `{ phase: someVariable }` this extractor cannot resolve, with no ambient phase() call to
      // fall back on: rather than inventing a phase from wherever this call happens to sit
      // lexically, report it so a later validate step can tell the author to pass a literal.
      unclassified.push({ line: call.line, callee: call.name, reason: "phase" });
      continue;
    } else {
      title = titles[0] ?? "Run";
    }

    const phase = byTitle.get(title);
    if (!phase) continue;

    const option = options(call);
    const id = `${slugByTitle.get(title) ?? slugifyTitle(title)}-${phase.steps.length + 1}`;
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
    const step = { id, label };
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

    if (step.label === "…") unclassified.push({ line: call.line, callee: call.name, reason: "label" });
    phase.steps.push(step);
  }

  return { phases, unclassified, computedAgentType };
}

/**
 * The one wording for an unclassified call site, shared by everything that reports one
 * (validate.js and sync-meta.js). The caller supplies the location prefix.
 *
 * The two reasons are different mistakes with different fixes and must not share a sentence: an
 * unreadable `{ phase }` means the call is absent from the diagram altogether, while an unreadable
 * label means the node is drawn but captioned with an ellipsis.
 */
export function unclassifiedMessage(call) {
  return call.reason === "phase"
    ? `${call.callee}() names a { phase } that is not a string literal — it is left out of the diagram entirely; pass a literal phase title`
    : `${call.callee}() has no readable label`;
}

/**
 * True when a `parallel()` argument is a literal array of thunks: a known, enumerable set, each
 * member of which has its own call site for the diagram to draw. `parallel(tasks.map(…))` — the
 * idiomatic fan-out — is not one, and neither is `parallel([...tasks.map(…)])`: in both, a single
 * call site stands for however many items exist at run time.
 */
function isEnumerableThunkList(node) {
  if (!node || node.type !== "ArrayExpression") return false;
  const elements = node.elements;
  if (!Array.isArray(elements)) return false;
  return !elements.some((e) => isNode(e) && e.type === "SpreadElement");
}

/** The `phase` property of a call's options object, when it is a plain string. */
function optionPhase(call) {
  const options = call.name === "agent" ? call.args[1] : undefined;
  if (!options || options.type !== "ObjectExpression") return undefined;
  const properties = options.properties;
  if (!Array.isArray(properties)) return undefined;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property.key;
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? key.name : literalString(key);
    if (name !== "phase") continue;
    const value = property.value;
    return isNode(value) ? literalString(value) : undefined;
  }
  return undefined;
}

/** True when a call's options object names a `phase` whose value is not a resolvable literal. */
function declaresNonLiteralPhase(call) {
  if (call.name !== "agent") return false;
  const options = call.args[1];
  if (!options || options.type !== "ObjectExpression") return false;
  const properties = options.properties;
  if (!Array.isArray(properties)) return false;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property.key;
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? key.name : literalString(key);
    if (name !== "phase") continue;
    const value = property.value;
    return !(isNode(value) && literalString(value) !== undefined);
  }
  return false;
}

/** Title of the most recent `phase()` call before this one. */
function ambientPhase(calls, call) {
  let title;
  for (const c of calls) {
    if (c.start >= call.start) break;
    if (c.name === "phase") title = literalString(c.args[0]) ?? title;
  }
  return title;
}

/** All string-valued options of a call, plus a marker for options that are computed. */
function options(call) {
  const out = new Map();
  const object = call.name === "agent" ? call.args[1] : undefined;
  if (!object || object.type !== "ObjectExpression") return out;
  const properties = object.properties;
  if (!Array.isArray(properties)) return out;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    const key = property.key;
    if (!isNode(key)) continue;
    const name = key.type === "Identifier" ? key.name : literalString(key);
    const value = property.value;
    if (typeof name === "string" && isNode(value)) out.set(name, value);
  }
  return out;
}

/**
 * A human-readable label for a node that may be computed. Anything the extractor cannot resolve
 * becomes "…", so `'build ' + t.id` reads as `build …` rather than vanishing.
 */
export function renderLabel(node) {
  if (!node) return "…";
  const direct = literalString(node);
  if (direct !== undefined) return direct;

  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis.filter(isNode);
    return collapse(quasis.map((q) => q.value.cooked ?? "").join("…"));
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = node.left;
    const right = node.right;
    return collapse((isNode(left) ? renderLabel(left) : "…") + (isNode(right) ? renderLabel(right) : "…"));
  }
  return "…";
}

/** Two adjacent unresolved fragments read as one. */
function collapse(text) {
  return text.replace(/…{2,}/g, "…");
}

/** The string value of one property of an ObjectExpression, when it is a plain literal. */
function property(object, name) {
  if (!object || object.type !== "ObjectExpression") return undefined;
  const properties = object.properties;
  if (!Array.isArray(properties)) return undefined;
  for (const p of properties) {
    if (!isNode(p) || p.type !== "Property") continue;
    const key = p.key;
    if (!isNode(key)) continue;
    const keyName = key.type === "Identifier" ? key.name : literalString(key);
    if (keyName !== name) continue;
    const value = p.value;
    return isNode(value) ? literalString(value) : undefined;
  }
  return undefined;
}

/**
 * `workflow()` takes a name or a `{ scriptPath }`, and its second argument is `args` — not an
 * options object — so a workflow node is labelled by what it runs.
 * `.../workflows/testing/workflow.js` → `testing`.
 */
function workflowLabel(call) {
  const first = call.args[0];
  const path = literalString(first) ?? property(first, "scriptPath");
  if (!path) return "…";
  const parts = path.replace(/\/workflow\.js$/, "").split("/");
  return parts[parts.length - 1] ?? path;
}

function slugifyTitle(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phase";
}
