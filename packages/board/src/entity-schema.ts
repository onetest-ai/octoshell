/**
 * The YAML entity schema — the on-disk shape of campaign/mission/task/bug files, replacing the
 * Markdown managed-block. Each entity folder holds ONE `<kind>.yaml`; children (tasks/bugs) are
 * folder-derived, so a parent never enumerates them. On-disk keys are snake_case; this module maps
 * them to the camelCase `EntityFields` the rest of the board uses, and back.
 */
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

export type EntityKind = "campaign" | "mission" | "task" | "bug";

/** The canonical entity status values (unchanged from the Markdown model). */
export const ENTITY_STATUSES = ["draft", "executing", "awaitingApproval", "done", "failed", "cancelled"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}
export interface DocumentLink {
  label: string;
  target: string;
}
/** Authored planning estimate — an open map so it carries maturity/basis/note without a fixed list. */
export type Tokenomics = Record<string, string | number | boolean>;

/** The parsed fields of an entity file; which are present depends on the kind. */
export interface EntityFields {
  name: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[]; // campaign/mission/task
  documents: DocumentLink[]; // campaign/mission
  status?: string; // campaign (settable) / task / bug
  role?: string; // task
  target?: string; // campaign
  severity?: string; // bug
  stepsToReproduce?: string; // bug
  expected?: string; // bug
  actual?: string; // bug
  rca?: string; // bug
  environment?: string; // bug
  tokenomics?: Tokenomics; // mission / task
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}
function parseCriteria(v: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(v)) return [];
  const out: AcceptanceCriterion[] = [];
  for (const item of v) {
    if (item && typeof item === "object" && "text" in item) {
      out.push({ text: asString((item as { text: unknown }).text), done: Boolean((item as { done?: unknown }).done) });
    }
  }
  return out;
}
function parseDocuments(v: unknown): DocumentLink[] {
  if (!Array.isArray(v)) return [];
  const out: DocumentLink[] = [];
  for (const item of v) {
    if (item && typeof item === "object" && "target" in item) {
      const target = asString((item as { target: unknown }).target);
      if (target) out.push({ label: asString((item as { label?: unknown }).label) || target, target });
    }
  }
  return out;
}
function parseTokenomics(v: unknown): Tokenomics | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Tokenomics = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parse a `<kind>.yaml` file body into typed fields. Missing keys default rather than throw. */
export function loadEntity(text: string): EntityFields {
  const raw = (yamlLoad(text) ?? {}) as Record<string, unknown>;
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

/** Serialize typed fields to a `<kind>.yaml` body, emitting only the keys that kind uses, in a stable order. */
export function dumpEntity(kind: EntityKind, f: EntityFields): string {
  const o: Record<string, unknown> = { name: f.name };
  if (kind === "campaign") {
    o.status = f.status ?? "draft";
    o.target = f.target ?? "";
  }
  if (kind === "task") {
    o.status = f.status ?? "draft";
    if (f.role) o.role = f.role;
  }
  if (kind === "bug") {
    o.severity = f.severity ?? "major";
    o.status = f.status ?? "draft";
  }
  o.description = f.description ?? "";
  if (kind === "bug") {
    o.steps_to_reproduce = f.stepsToReproduce ?? "";
    o.expected = f.expected ?? "";
    o.actual = f.actual ?? "";
    o.rca = f.rca ?? "";
    o.environment = f.environment ?? "";
  } else {
    o.acceptance_criteria = f.acceptanceCriteria.map((c) => ({ text: c.text, done: c.done }));
  }
  if (kind === "campaign" || kind === "mission") {
    o.documents = f.documents.map((d) => ({ label: d.label, target: d.target }));
  }
  if ((kind === "mission" || kind === "task") && f.tokenomics && Object.keys(f.tokenomics).length) {
    o.tokenomics = f.tokenomics;
  }
  return yamlDump(o, { lineWidth: -1, noRefs: true });
}
