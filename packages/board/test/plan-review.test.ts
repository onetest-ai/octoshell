/**
 * Unit tests for the pack's dependency-free `plan-review.mjs` (mission M5 AC1): does a mission's or
 * its campaign's notes hold a BA + tech-lead plan review? Every row of the shared case table
 * (fixtures/plan-review-cases.json, which T5.2's TypeScript mirror reuses) is one clause of the rule,
 * with its expected value written by hand from the rule, not computed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);

type Candidate = { heading: string; where: "mission" | "campaign"; missing: string[] };
type Result =
  | { ok: true; heading: string; where: "mission" | "campaign"; legacy: boolean }
  | { ok: false; candidates: Candidate[] };
const { planReviewStatus } = (await import(pathToFileURL(join(SCRIPTS, "plan-review.mjs")).href)) as {
  planReviewStatus: (missionNotes?: string | null, campaignNotes?: string | null) => Result;
};

interface Case {
  id: string;
  description: string;
  missionNotes: string;
  campaignNotes: string;
  expected: {
    ok: boolean;
    where?: "mission" | "campaign";
    legacy?: boolean;
    heading?: string;
    candidates?: Candidate[];
    missing?: string[];
  };
}
const TABLE = JSON.parse(readFileSync(resolve(__dirname, "fixtures/plan-review-cases.json"), "utf8")) as { cases: Case[] };

describe("plan-review.mjs on the shared case table", () => {
  it("has a self-describing table with unique ids", () => {
    const ids = TABLE.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(80);
    for (const c of TABLE.cases) {
      expect(c.description, c.id).toBeTruthy();
      expect(typeof c.missionNotes, c.id).toBe("string");
      expect(typeof c.campaignNotes, c.id).toBe("string");
    }
  });

  it.each(TABLE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const got = planReviewStatus(c.missionNotes, c.campaignNotes);
    if (c.expected.ok) {
      expect(got).toEqual({ ok: true, heading: c.expected.heading, where: c.expected.where, legacy: c.expected.legacy });
    } else {
      expect(got).toEqual({ ok: false, candidates: c.expected.candidates });
      expect((got as { candidates: Candidate[] }).candidates.flatMap((x) => x.missing)).toEqual(c.expected.missing);
    }
  });

  it("covers every clause of the task's refusal list by id", () => {
    const ids = new Set(TABLE.cases.map((c) => c.id));
    for (const id of [
      "refuse-verdict-changes-requested-both-named",
      "refuse-legacy-one-reviewer-alex",
      "refuse-reviewers-personas-only",
      "refuse-verdict-without-reviewers",
      "refuse-overridden-heading",
      "refuse-tech-leadership",
      "refuse-reviewers-after-next-heading",
      "real-m5-notes-alone-self-approval",
      "strict-wins-over-legacy-mission-first",
      "legacy-personas-real-uwb",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe("plan-review.mjs argument handling", () => {
  it("treats a missing mission or campaign notes (undefined, null) as empty", () => {
    expect(planReviewStatus(undefined, undefined)).toEqual({ ok: false, candidates: [] });
    expect(planReviewStatus(null, null)).toEqual({ ok: false, candidates: [] });
    const strict = "## Plan review (x)\nReviewers: ba, tech-lead\nVerdict: approved";
    expect(planReviewStatus(undefined, strict)).toMatchObject({ ok: true, where: "campaign", legacy: false });
    expect(planReviewStatus(strict, null)).toMatchObject({ ok: true, where: "mission", legacy: false });
  });

  it("is a pure function of its two arguments", () => {
    const a = "## Plan review (Alex + Rio)\nprose";
    expect(planReviewStatus(a, "")).toEqual(planReviewStatus(a, ""));
  });
});
