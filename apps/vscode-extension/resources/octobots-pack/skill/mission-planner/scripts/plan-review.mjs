// The plan-review rule: has a BA + tech-lead review been recorded for a mission? Dependency-free,
// like entity-io.mjs, because it ships in the pack. `set-status.js` imports it; the extension's
// BoardHost.setStatus uses the TypeScript mirror in packages/board (planReviewStatus), and
// packages/board/test/plan-review-parity.test.ts holds the two together over the shared case table
// (packages/board/test/fixtures/plan-review-cases.json). Change the rule in both files, in one PR.
//
// The rule (mission AC1 of M5, campaign decisions 9-11):
//  - A candidate section starts at a column-0 line `## Plan review (<text>)` (optional trailing
//    blanks) and ends at the next column-0 `## ` line or the end of the notes. So `## Plan review
//    overridden (...)` and `## Plan review record shape ...` never match.
//  - Strict record: a column-0 `Reviewers:` line holding the tokens `ba` and `tech-lead`, and a
//    column-0 `Verdict: approved` or `Verdict: approved with nits` line, with every column-0
//    `Verdict:` line of the section approving (a section that also says `Verdict: changes requested`
//    is ambiguous and refused).
//  - The `Reviewers:` and `Verdict:` keys and the verdict value match case-insensitively (the whole
//    line, as AC1 says), so `verdict: changes requested` makes a section strict and refused rather
//    than leaving it to pass as a legacy record. (Spec clarifications of T5.1 review, 2026-10-06.)
//  - Legacy record: the section has NO column-0 `Reviewers:` line and NO column-0 `Verdict:` line,
//    and the heading's parenthesised text names the BA (`ba` or `Alex`) and the tech lead
//    (`tech-lead` or `Rio`). Accepted, with a warning (printed by the caller).
//  - Role tokens match case-insensitively, persona names case-sensitively, and a token never has a
//    letter, digit, `_` or `-` next to it. Persona names count only inside a legacy heading.
//  - Indented lines are prose. A strict record anywhere beats a legacy one.

const HEADING = /^## Plan review \((.*)\)[ \t]*$/;
const REVIEWERS_LINE = /^Reviewers:/i;
const VERDICT_LINE = /^Verdict:/i;
const APPROVING_VERDICT = /^Verdict:[ \t]*(?:approved|approved with nits)[ \t]*$/i;

// A token is bounded by anything but a letter, digit, `_` or `-`.
const NOT_WORD = "[\\p{L}\\p{N}_-]";
const token = (word, flags) => new RegExp(`(?<!${NOT_WORD})${word}(?!${NOT_WORD})`, `u${flags}`);
const BA = token("ba", "i");
const TECH_LEAD = token("tech-lead", "i");
const ALEX = token("Alex", "");
const RIO = token("Rio", "");

export const MISSING_REVIEWERS = "no Reviewers: line naming ba and tech-lead";
export const MISSING_VERDICT = "no Verdict: approved line";
export const CONFLICTING_VERDICT = "a Verdict: line that is not approved";
export const MISSING_BA = "heading does not name the ba (ba or Alex)";
export const MISSING_TECH_LEAD = "heading does not name the tech-lead (tech-lead or Rio)";

/** Every `## Plan review (...)` section of `notes`: `{heading, text, lines}` in document order. */
function sectionsOf(notes) {
  const out = [];
  let current = null;
  for (const line of String(notes ?? "").split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      current = { heading: line.replace(/[ \t]+$/, ""), text: m[1], lines: [] };
      out.push(current);
    } else if (line.startsWith("## ")) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

/** What one section is judged as: `strict` once it has a Reviewers:/Verdict: line, else `legacy`. */
function judge(section) {
  const reviewers = section.lines.filter((l) => REVIEWERS_LINE.test(l));
  const verdicts = section.lines.filter((l) => VERDICT_LINE.test(l));
  if (reviewers.length || verdicts.length) {
    const missing = [];
    if (!reviewers.some((l) => BA.test(l) && TECH_LEAD.test(l))) missing.push(MISSING_REVIEWERS);
    if (!verdicts.some((l) => APPROVING_VERDICT.test(l))) missing.push(MISSING_VERDICT);
    else if (!verdicts.every((l) => APPROVING_VERDICT.test(l))) missing.push(CONFLICTING_VERDICT);
    return { legacy: false, missing };
  }
  const missing = [];
  if (!BA.test(section.text) && !ALEX.test(section.text)) missing.push(MISSING_BA);
  if (!TECH_LEAD.test(section.text) && !RIO.test(section.text)) missing.push(MISSING_TECH_LEAD);
  return { legacy: true, missing };
}

/**
 * Is a plan review recorded in the mission's or its campaign's notes?
 *  - `{ok: true, heading, where: "mission" | "campaign", legacy}`: the first strict record (mission
 *    notes first), else the first legacy one. `heading` is the full line without trailing blanks.
 *  - `{ok: false, candidates: [{heading, where, missing: string[]}]}`: every candidate section,
 *    mission notes first, with what each lacks. Empty when no `## Plan review (...)` heading exists.
 */
export function planReviewStatus(missionNotes, campaignNotes) {
  const candidates = [];
  let legacyHit = null;
  for (const [where, notes] of [["mission", missionNotes], ["campaign", campaignNotes]]) {
    for (const section of sectionsOf(notes)) {
      const verdict = judge(section);
      if (verdict.missing.length) {
        candidates.push({ heading: section.heading, where, missing: verdict.missing });
      } else if (!verdict.legacy) {
        return { ok: true, heading: section.heading, where, legacy: false };
      } else {
        legacyHit ??= { ok: true, heading: section.heading, where, legacy: true };
      }
    }
  }
  return legacyHit ?? { ok: false, candidates };
}
