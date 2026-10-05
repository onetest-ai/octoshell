// The ONE rule for reading a pack skill's version marker, on the pack side. The extension host has
// its twin in src/host/skill-marker.ts; test/skill-marker-parity.test.ts drives both from one case
// table and asserts identical results, so "is this SKILL.md the pack's, a fork, or reconciled" cannot
// come to mean two things. doctor.js, validate.js and pack-reconcile.mjs import this file.
//
// Frontmatter only: the first `version:` and the first `reconciled-from:` line between the opening
// `---` and the next `---`. A `version:` line further down is prose. The file hash is sha256 of the
// whole text with CRLF normalised to LF, so a Windows checkout of the same file hashes the same.
//
//   kind "integer"    version: 57
//   kind "plus-local" version: 57+local   (reconciled against pack v57; see reconciled-from)
//   kind "label"      any other value, e.g. 57-local; n is its leading integer, or null
//   kind "none"       no version line (label and n are null)
import { createHash } from "node:crypto";

const normalise = (text) => text.replace(/\r\n/g, "\n");

/** sha256 (hex) of `text` with CRLF normalised to LF. */
export function skillSha256(text) {
  return createHash("sha256").update(normalise(text)).digest("hex");
}

/** `{label, n, kind, reconciledFrom, sha256}` for the text of one SKILL.md. */
export function parseSkillMarker(text) {
  const lf = normalise(text);
  const fm = lf.replace(/^\uFEFF/, "").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const field = (name) => {
    const m = fm ? fm[1].match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m")) : null;
    const v = m ? m[1].trim() : "";
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
