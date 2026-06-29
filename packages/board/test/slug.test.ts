import { describe, it, expect } from "vitest";
import { slugify, uniqueSlug } from "../src/slug.js";

describe("slugify", () => {
  it("slugifies names", () => {
    expect(slugify("Profile the project")).toBe("profile-the-project");
    expect(slugify("Q3 Rollout!!")).toBe("q3-rollout");
    expect(slugify("  Hello  World  ")).toBe("hello-world");
  });
  it("falls back to a short id for empty/non-latin", () => {
    const s = slugify("日本語");
    expect(s).toMatch(/^[0-9a-f]{8}$/);
    expect(slugify("")).toMatch(/^[0-9a-f]{8}$/);
  });
  it("caps length at 50", () => {
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(50);
  });
});

describe("uniqueSlug", () => {
  it("returns base when free, else -2/-3", () => {
    const taken = new Set(["onboarding"]);
    expect(uniqueSlug("onboarding", taken)).toBe("onboarding-2");
    expect(uniqueSlug("fresh", taken)).toBe("fresh");
    expect(uniqueSlug("onboarding", new Set(["onboarding", "onboarding-2"]))).toBe("onboarding-3");
  });
});
