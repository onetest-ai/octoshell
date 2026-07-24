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
function parseCriteria(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && "text" in item) {
      out.push({ text: asString(item.text), done: Boolean(item.done) });
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
      if (target) out.push({ label: asString(item.label) || target, target });
    }
  }
  return out;
}
function parseTokenomics(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
  }
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
    o.acceptance_criteria = (f.acceptanceCriteria ?? []).map((c) => ({ text: c.text, done: c.done }));
  }
  if (kind === "campaign" || kind === "mission") {
    o.documents = (f.documents ?? []).map((d) => ({ label: d.label, target: d.target }));
  }
  if ((kind === "mission" || kind === "task") && f.tokenomics && Object.keys(f.tokenomics).length) {
    o.tokenomics = f.tokenomics;
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
  return f;
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
  if (!kinds.includes(kind)) return { file: arg, kind, format: km[2] };
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
