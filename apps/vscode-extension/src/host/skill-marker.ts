import { createHash } from "node:crypto";

/**
 * The ONE rule for reading a pack skill's version marker, host side. Its twin is
 * `resources/octobots-pack/skill/mission-planner/scripts/skill-marker.mjs` (doctor.js, validate.js
 * and pack-reconcile.mjs import that one); `test/skill-marker-parity.test.ts` drives both from one
 * case table and asserts identical results.
 *
 * Frontmatter only: the first `version:` and the first `reconciled-from:` line between the opening
 * `---` and the next `---`. A `version:` line further down is prose. The file hash is sha256 of the
 * whole text with CRLF normalised to LF, so a Windows checkout of the same file hashes the same.
 *
 *   integer     `version: 57`
 *   plus-local  `version: 57+local` (reconciled against pack v57; see `reconciledFrom`)
 *   label       any other value, e.g. `57-local`; `n` is its leading integer, or null
 *   none        no version line (`label` and `n` are null)
 */
export type SkillMarkerKind = "integer" | "plus-local" | "label" | "none";

export interface SkillMarker {
  label: string | null;
  n: number | null;
  kind: SkillMarkerKind;
  reconciledFrom: string | null;
  sha256: string;
}

const normalise = (text: string): string => text.replace(/\r\n/g, "\n");

/** sha256 (hex) of `text` with CRLF normalised to LF. */
export function skillSha256(text: string): string {
  return createHash("sha256").update(normalise(text)).digest("hex");
}

export function parseSkillMarker(text: string): SkillMarker {
  const lf = normalise(text);
  const fm = lf.replace(/^\uFEFF/, "").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const field = (name: string): string | null => {
    const m = fm ? fm[1]!.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m")) : null;
    const v = m ? m[1]!.trim() : "";
    return v === "" ? null : v;
  };
  const label = field("version");
  const reconciledFrom = field("reconciled-from");
  const sha256 = skillSha256(text);
  if (label === null) return { label, n: null, kind: "none", reconciledFrom, sha256 };
  if (/^\d+$/.test(label)) return { label, n: Number(label), kind: "integer", reconciledFrom, sha256 };
  const local = label.match(/^(\d+)\+local$/);
  if (local) return { label, n: Number(local[1]), kind: "plus-local", reconciledFrom, sha256 };
  const lead = label.match(/^(\d+)/);
  return { label, n: lead ? Number(lead[1]) : null, kind: "label", reconciledFrom, sha256 };
}

/**
 * The `octobots-reconciled-from: <sha256>` marker of a reconciled pack FILE other than a SKILL.md
 * (a tokenomics script): the first line holding it, in whatever comment syntax the file uses
 * (`// ...`, `# ...`, `<!-- ... -->`). Lower-cased; null when absent. A file has no frontmatter, so
 * the marker alone says what it was reconciled against.
 */
export function fileReconciledFrom(text: string): string | null {
  const m = normalise(text).match(/octobots-reconciled-from:[ \t]*([0-9a-fA-F]{64})(?![0-9a-fA-F])/);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * `text` without its one standalone `octobots-reconciled-from: <64 hex>` marker line (and that
 * line's newline, CRLF or LF): the first such line, nothing else. A line with code before the
 * marker, or text after the hash, is local content and the text comes back unchanged.
 */
export function withoutReconciledFrom(text: string): string {
  return text.replace(/^[ \t]*(?:(?:\/\/|#)[ \t]*octobots-reconciled-from:[ \t]*[0-9a-fA-F]{64}|<!--[ \t]*octobots-reconciled-from:[ \t]*[0-9a-fA-F]{64}[ \t]*-->)[ \t]*(?:\r?\n|$)/m, "");
}
