import { it, expect } from "vitest";
import { makeAttributionContext, resolveAttribution } from "../src/attribution.js";

// A campaign owns a branch only where its slug stands as a whole name part, bounded by the start or
// end of the branch, `/` or `-`. A plain substring match gave `demo` the branch `feat/demolition-m1`
// and `ai` every branch with "ai" anywhere in it.
const mission = (campaign: string, key: string) => ({ id: `M${key}`, campaign, missionKey: key, missionNum: Number(key), declaredBranches: [], tasks: [] });
const ctx = makeAttributionContext({
  missions: [mission("demo", "1"), mission("demolition", "2"), mission("ai", "3")],
  campaigns: [{ slug: "demo", declaredBranches: [] }, { slug: "demolition", declaredBranches: [] }, { slug: "ai", declaredBranches: [] }],
});
const campaignOf = (branch: string) => {
  const t = resolveAttribution(branch, "s", ctx);
  return t.kind === "mission" ? t.mission.campaign : t.kind === "campaign" ? t.campaign.slug : null;
};

it.each([
  ["feat/demo-m1-t1", "demo"],
  ["demo", "demo"],
  ["fix/demo", "demo"],
  ["demo/m1", "demo"],
  ["feat/demolition-m2", "demolition"],
  ["feat/ai-m3", "ai"],
])("%s belongs to campaign %s", (branch, slug) => {
  expect(campaignOf(branch)).toBe(slug);
});

it.each(["feat/demos-m1", "feat/maintenance", "chore/redemo", "feat/plain-m9"])("%s belongs to no campaign", (branch) => {
  expect(campaignOf(branch)).toBeNull();
});
