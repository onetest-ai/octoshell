// The plan-review rule: has a BA + tech-lead review been recorded for a mission? This is the
// TypeScript mirror of the pack's dependency-free `plan-review.mjs` (which `set-status.js` imports).
// `test/plan-review-parity.test.ts` holds the two together over the shared case table
// (test/fixtures/plan-review-cases.json) and every real (mission notes, campaign notes) pair. Change
// the rule in both files, in one PR. See plan-review.mjs for the rule, clause by clause.

const HEADING = /^## Plan review \((.*)\)[ \t]*$/;
const REVIEWERS_LINE = /^Reviewers:/i;
const VERDICT_LINE = /^Verdict:/i;
const APPROVING_VERDICT = /^Verdict:[ \t]*(?:approved|approved with nits)[ \t]*$/i;

// A token is bounded by anything but a letter, digit, `_` or `-`.
const NOT_WORD = "[\\p{L}\\p{N}_-]";
const token = (word: string, flags: string): RegExp => new RegExp(`(?<!${NOT_WORD})${word}(?!${NOT_WORD})`, `u${flags}`);
const BA = token("ba", "i");
const TECH_LEAD = token("tech-lead", "i");
const ALEX = token("Alex", "");
const RIO = token("Rio", "");

export const MISSING_REVIEWERS = "no Reviewers: line naming ba and tech-lead";
export const MISSING_VERDICT = "no Verdict: approved line";
export const CONFLICTING_VERDICT = "a Verdict: line that is not approved";
export const MISSING_BA = "heading does not name the ba (ba or Alex)";
export const MISSING_TECH_LEAD = "heading does not name the tech-lead (tech-lead or Rio)";

export type PlanReviewWhere = "mission" | "campaign";

export interface PlanReviewCandidate {
  heading: string;
  where: PlanReviewWhere;
  missing: string[];
}

export type PlanReviewStatus =
  | { ok: true; heading: string; where: PlanReviewWhere; legacy: boolean }
  | { ok: false; candidates: PlanReviewCandidate[] };

interface Section {
  heading: string;
  text: string;
  lines: string[];
}

/** Every `## Plan review (...)` section of `notes`, in document order. */
function sectionsOf(notes: string | null | undefined): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (const line of String(notes ?? "").split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      current = { heading: line.replace(/[ \t]+$/, ""), text: m[1] ?? "", lines: [] };
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
function judge(section: Section): { legacy: boolean; missing: string[] } {
  const reviewers = section.lines.filter((l) => REVIEWERS_LINE.test(l));
  const verdicts = section.lines.filter((l) => VERDICT_LINE.test(l));
  const missing: string[] = [];
  if (reviewers.length || verdicts.length) {
    if (!reviewers.some((l) => BA.test(l) && TECH_LEAD.test(l))) missing.push(MISSING_REVIEWERS);
    if (!verdicts.some((l) => APPROVING_VERDICT.test(l))) missing.push(MISSING_VERDICT);
    else if (!verdicts.every((l) => APPROVING_VERDICT.test(l))) missing.push(CONFLICTING_VERDICT);
    return { legacy: false, missing };
  }
  if (!BA.test(section.text) && !ALEX.test(section.text)) missing.push(MISSING_BA);
  if (!TECH_LEAD.test(section.text) && !RIO.test(section.text)) missing.push(MISSING_TECH_LEAD);
  return { legacy: true, missing };
}

/**
 * Is a plan review recorded in the mission's or its campaign's notes?
 *  - `{ok: true, heading, where, legacy}`: the first strict record (mission notes first), else the
 *    first legacy one. `heading` is the full line without trailing blanks.
 *  - `{ok: false, candidates}`: every candidate section, mission notes first, with what each lacks.
 *    Empty when no `## Plan review (...)` heading exists.
 */
export function planReviewStatus(
  missionNotes?: string | null,
  campaignNotes?: string | null,
): PlanReviewStatus {
  const candidates: PlanReviewCandidate[] = [];
  let legacyHit: PlanReviewStatus | null = null;
  const sources: Array<[PlanReviewWhere, string | null | undefined]> = [
    ["mission", missionNotes],
    ["campaign", campaignNotes],
  ];
  for (const [where, notes] of sources) {
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
