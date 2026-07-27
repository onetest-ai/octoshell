// Shared entity YAML I/O for the standalone pack scripts. Mirrors packages/board/src/entity-schema.ts
// (the on-disk shape BoardModel reads) so the scripts and the app agree byte-for-byte: snake_case
// keys, `acceptance_criteria` as a list of {text,done}, `documents` as a list of {label,target},
// and status/role/severity/tokenomics living in the child's OWN file. Zero external install — it
// imports only the vendored js-yaml bundle. Keep this in step with entity-schema.ts.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { load as yamlLoad, dump as yamlDump } from "./vendor/js-yaml.mjs";

/** The four YAML entity kinds (workflow is a `.js` script, not an entity file). */
export const ENTITY_KINDS = ["campaign", "mission", "task", "bug"];

// ── slug helpers ───────────────────────────────────────────────────────────────
export const newId = () => randomUUID().replace(/-/g, "").slice(0, 12);
export function slugify(s) {
  const out = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
  return out || newId().slice(0, 8);
}
export function siblingSlugs(dir) {
  return existsSync(dir)
    ? new Set(readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
    : new Set();
}
export function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ── canonical status mapping (mirrors managed-block.ts mapBoardStatus) ──────────
export function mapBoardStatus(raw) {
  const key = String(raw ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
  switch (key) {
    case "draft": return "draft";
    case "active": case "executing": case "in progress": case "running": return "executing";
    case "awaiting approval": case "awaitingapproval": case "awaiting": return "awaitingApproval";
    case "done": case "complete": case "completed": return "done";
    case "failed": case "fail": return "failed";
    case "cancelled": case "canceled": return "cancelled";
    default: return null;
  }
}

// ── parse / serialize (mirrors entity-schema.ts loadEntity/dumpEntity) ──────────
function asString(v) { return typeof v === "string" ? v : v == null ? "" : String(v); }
function optString(v) { return typeof v === "string" && v.length ? v : undefined; }
/** The top-level keys this schema owns; anything else round-trips through `extra`. */
export const KNOWN_KEYS = [
  "name",
  "description",
  "acceptance_criteria",
  "documents",
  "status",
  "role",
  "target",
  "severity",
  "steps_to_reproduce",
  "expected",
  "actual",
  "rca",
  "environment",
  "tokenomics",
  "notes",
];

/** Which top-level keys each kind emits. A known key outside its kind's list is misplaced. */
export const KIND_KEYS = {
  campaign: ["name", "status", "target", "description", "acceptance_criteria", "documents", "notes"],
  mission: ["name", "status", "description", "acceptance_criteria", "documents", "tokenomics", "notes"],
  task: ["name", "status", "role", "description", "acceptance_criteria", "tokenomics", "notes"],
  bug: ["name", "status", "severity", "description", "steps_to_reproduce", "expected", "actual", "rca", "environment", "notes"],
};

/** The item's keys minus the ones named — carried through so nothing on the item is dropped. */
function restOf(item, owned) {
  const rest = {};
  for (const [k, v] of Object.entries(item)) {
    if (!owned.includes(k)) rest[k] = v;
  }
  return rest;
}

/** True for a value that carries nothing — absent, blank, or an empty list/map. */
function isEmptyish(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/**
 * Everything worth carrying across a round-trip: keys the schema does not know, plus keys it DOES
 * know that carry content. `dumpEntity` only re-emits what the kind did not already write, so a
 * known key lands here purely as a safety net for the kinds that do not own it (a `documents:` on a
 * task, say) — malformed, but never silently deleted. Empty values are skipped so a round-trip does
 * not litter every file with `documents: []`.
 */
function carryForward(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.includes(k) || !isEmptyish(v)) out[k] = v;
  }
  return out;
}
function parseCriteria(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && "text" in item) {
      out.push({ text: asString(item.text), done: Boolean(item.done), ...restOf(item, ["text", "done"]) });
    }
  }
  return out;
}
function parseDocuments(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && "target" in item) {
      const target = asString(item.target);
      if (target) out.push({ label: asString(item.label) || target, target, ...restOf(item, ["label", "target"]) });
    }
  }
  return out;
}
function parseTokenomics(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  // Every value is kept, scalar or not — dropping a nested block would silently lose an estimate's
  // breakdown on the next unrelated write.
  const out = { ...v };
  return Object.keys(out).length ? out : undefined;
}

/** Parse a `<kind>.yaml` body into camelCase fields (missing keys default rather than throw). */
export function loadEntity(text) {
  const raw = yamlLoad(text) ?? {};
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    acceptanceCriteria: parseCriteria(raw.acceptance_criteria),
    documents: parseDocuments(raw.documents),
    status: optString(raw.status),
    role: optString(raw.role),
    target: optString(raw.target),
    severity: optString(raw.severity),
    stepsToReproduce: optString(raw.steps_to_reproduce),
    expected: optString(raw.expected),
    actual: optString(raw.actual),
    rca: optString(raw.rca),
    environment: optString(raw.environment),
    tokenomics: parseTokenomics(raw.tokenomics),
    notes: optString(raw.notes),
    extra: carryForward(raw),
  };
}

/** Serialize fields to a `<kind>.yaml` body, emitting only the keys that kind uses, in a stable order. */
export function dumpEntity(kind, f) {
  const o = { name: f.name };
  o.status = f.status ?? "draft";
  if (kind === "campaign") o.target = f.target ?? "";
  if (kind === "task" && f.role) o.role = f.role;
  if (kind === "bug") o.severity = f.severity ?? "major";
  o.description = f.description ?? "";
  if (kind === "bug") {
    o.steps_to_reproduce = f.stepsToReproduce ?? "";
    o.expected = f.expected ?? "";
    o.actual = f.actual ?? "";
    o.rca = f.rca ?? "";
    o.environment = f.environment ?? "";
  } else {
    // Spread the item's other keys back out — an agent may annotate a criterion (evidence, who
    // verified it) and a rewrite must not strip that.
    o.acceptance_criteria = (f.acceptanceCriteria ?? []).map((c) => ({
      text: c.text,
      done: c.done,
      ...restOf(c, ["text", "done"]),
    }));
  }
  if (kind === "campaign" || kind === "mission") {
    o.documents = (f.documents ?? []).map((d) => ({ label: d.label, target: d.target, ...restOf(d, ["label", "target"]) }));
  }
  if ((kind === "mission" || kind === "task") && f.tokenomics && Object.keys(f.tokenomics).length) {
    o.tokenomics = f.tokenomics;
  }
  // Free-form appended prose (decisions/rationale/sign-offs) — emitted for every kind when present.
  // Every mutating script rewrites the WHOLE file through this dump, so a field missing here is
  // destroyed by the next unrelated edit. Keep in step with entity-schema.ts `dumpEntity`.
  if (f.notes && f.notes.trim()) o.notes = f.notes;
  // Keys this schema does not model are re-emitted last, so a write never destroys content it did
  // not understand. Modelled keys always win — `extra` can only add.
  for (const [k, v] of Object.entries(f.extra ?? {})) {
    if (!(k in o)) o[k] = v;
  }
  return yamlDump(o, { lineWidth: -1, noRefs: true });
}

const emptyFields = (name = "") => ({ name, description: "", acceptanceCriteria: [], documents: [] });

// ── legacy `.md` fallback read (best-effort; supports mid-migration boards) ─────
function mdSection(text, label) {
  const m = new RegExp(`^##\\s+${label}\\s*$`, "m").exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const ends = [rest.search(/^##\s+/m), rest.search(/^<!--/m)].filter((n) => n >= 0);
  const body = (ends.length ? rest.slice(0, Math.min(...ends)) : rest).trim();
  return /^_\(.*\)_$/.test(body) ? "" : body;
}
function loadEntityMd(text) {
  const f = emptyFields();
  const h = /^#\s+(.+?)\s*$/m.exec(text);
  f.name = h ? h[1].trim() : "";
  f.description = mdSection(text, "Description");
  const ac = mdSection(text, "Acceptance Criteria");
  for (const line of ac.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (m) f.acceptanceCriteria.push({ text: (m[2] ?? "").trim(), done: (m[1] ?? " ").toLowerCase() === "x" });
  }
  const docs = mdSection(text, "Documents");
  for (const line of docs.split("\n")) {
    const m = line.match(/^\s*-\s*\[([^\]]*)\]\(([^)]+)\)/);
    if (m) f.documents.push({ label: (m[1] ?? "").trim() || m[2].trim(), target: m[2].trim() });
  }
  f.target = mdSection(text, "Target") || undefined;
  f.severity = (mdSection(text, "Severity") || undefined)?.toLowerCase();
  f.stepsToReproduce = mdSection(text, "Steps to Reproduce") || undefined;
  f.expected = mdSection(text, "Expected") || undefined;
  f.actual = mdSection(text, "Actual") || undefined;
  f.rca = mdSection(text, "RCA") || undefined;
  f.environment = mdSection(text, "Environment") || undefined;
  f.status = mapBoardStatus(mdSection(text, "Status")) || undefined;
  // Free-form prose appended below the managed block (decisions/rationale/sign-offs) — kept so an
  // edit that converts a legacy `.md` to yaml does not drop it. Mirrors write.ts `parseNotes`.
  f.notes = parseNotesMd(text);
  return f;
}

/** Non-structural `##` sections below the managed-block boundary, verbatim, or undefined. */
function parseNotesMd(md) {
  const marker = md.indexOf("Auto-generated by Octobots");
  if (marker < 0) return undefined;
  const close = md.indexOf("-->", marker);
  if (close < 0) return undefined;
  const STRUCTURAL = /^(Tasks|Bugs|Missions|Tokenomics|Sessions|Runs)\b/i;
  const kept = [];
  for (const part of md.slice(close + 3).split(/(?=^##[ \t]+)/m)) {
    const h = /^##[ \t]+(.+?)[ \t]*$/m.exec(part);
    if (h && STRUCTURAL.test(h[1] ?? "")) continue;
    const stripped = part.replace(/^##[ \t]+.*$/m, "").replace(/_\([^)]*\)_/g, "").trim();
    if (!stripped) continue;
    kept.push(part.trim());
  }
  return kept.join("\n\n").trim() || undefined;
}

// ── entity-file resolution (`<kind>.yaml`, falling back to `<kind>.md`) ─────────
/** Resolve a dir/file arg to `{ file, kind, format }`, or null. `kinds` limits which kinds to accept. */
export function resolveEntityFile(arg, kinds = ENTITY_KINDS) {
  if (!arg || !existsSync(arg)) return null;
  if (statSync(arg).isDirectory()) {
    for (const kind of kinds) {
      const y = join(arg, `${kind}.yaml`);
      if (existsSync(y)) return { file: y, kind, format: "yaml" };
      const m = join(arg, `${kind}.md`);
      if (existsSync(m)) return { file: m, kind, format: "md" };
    }
    return null;
  }
  const base = basename(arg);
  const km = base.match(/^(campaign|mission|task|bug)\.(yaml|md)$/);
  if (!km) return null;
  const kind = km[1];
  // A kind the caller did not ask for is NOT a match — returning it anyway let set-criterion.js
  // accept a bug.yaml, then drop the criterion on dump (bugs have no acceptance_criteria) while
  // still reporting success.
  if (!kinds.includes(kind)) return null;
  return { file: arg, kind, format: km[2] };
}

/** Read an entity's full fields from a resolved `{ file, format }`. */
export function readEntity(file, format) {
  const text = readFileSync(file, "utf8");
  return format === "yaml" ? loadEntity(text) : loadEntityMd(text);
}

/** Read just an entity folder's name (for matching by title). Prefers yaml, falls back to md heading. */
export function entityName(dir, kind) {
  const y = join(dir, `${kind}.yaml`);
  if (existsSync(y)) return loadEntity(readFileSync(y, "utf8")).name;
  const m = join(dir, `${kind}.md`);
  if (existsSync(m)) {
    const h = /^#\s+(.+?)\s*$/m.exec(readFileSync(m, "utf8"));
    return h ? h[1].trim() : "";
  }
  return "";
}

/** Directory entries (folder names) under `p`, or []. */
export function childDirs(p) {
  return existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}
