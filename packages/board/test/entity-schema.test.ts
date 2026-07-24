import { describe, it, expect } from "vitest";
import { loadEntity, dumpEntity, type EntityFields } from "../src/entity-schema.js";

function base(over: Partial<EntityFields> = {}): EntityFields {
  return { name: "n", description: "", acceptanceCriteria: [], documents: [], ...over };
}

describe("entity-schema load/dump", () => {
  it("round-trips a task with criteria, role, status and tokenomics", () => {
    const f = base({
      name: "T1.1 - Add JWT",
      description: "Multi-line\nprose stays intact.",
      status: "active",
      role: "python-dev",
      acceptanceCriteria: [
        { text: "JWT validated on /login", done: false },
        { text: "refresh path covered", done: true },
      ],
      tokenomics: { effort_days: 1, size_tshirt: "S", maturity: "production", estimated_retrospectively: true },
    });
    const yaml = dumpEntity("task", f);
    const back = loadEntity(yaml);
    expect(back.name).toBe("T1.1 - Add JWT");
    expect(back.description).toBe("Multi-line\nprose stays intact.");
    expect(back.status).toBe("active");
    expect(back.role).toBe("python-dev");
    expect(back.acceptanceCriteria).toEqual(f.acceptanceCriteria);
    expect(back.tokenomics).toEqual({ effort_days: 1, size_tshirt: "S", maturity: "production", estimated_retrospectively: true });
  });

  it("round-trips a campaign with status, target and documents", () => {
    const f = base({
      name: "Q3",
      status: "draft",
      target: "ship it",
      documents: [{ label: "spec", target: "docs/spec.md" }],
      acceptanceCriteria: [{ text: "ships", done: false }],
    });
    const back = loadEntity(dumpEntity("campaign", f));
    expect(back.status).toBe("draft");
    expect(back.target).toBe("ship it");
    expect(back.documents).toEqual([{ label: "spec", target: "docs/spec.md" }]);
  });

  it("round-trips a bug's severity/status and reproduction fields, and emits no acceptance_criteria", () => {
    const f = base({
      name: "Crash on load",
      severity: "critical",
      status: "draft",
      stepsToReproduce: "open the app",
      expected: "loads",
      actual: "crashes",
    });
    const yaml = dumpEntity("bug", f);
    expect(yaml).not.toContain("acceptance_criteria");
    const back = loadEntity(yaml);
    expect(back.severity).toBe("critical");
    expect(back.stepsToReproduce).toBe("open the app");
    expect(back.actual).toBe("crashes");
  });

  it("a mission emits no status/role and keeps documents + tokenomics", () => {
    const yaml = dumpEntity("mission", base({ name: "M1", status: "executing", role: "x", tokenomics: { effort_days: 3 } }));
    expect(yaml).not.toMatch(/^status:/m);
    expect(yaml).not.toMatch(/^role:/m);
    expect(loadEntity(yaml).tokenomics).toEqual({ effort_days: 3 });
  });

  it("defaults missing keys instead of throwing, and drops malformed criteria/documents", () => {
    const f = loadEntity("name: X\nacceptance_criteria:\n  - notext: 1\ndocuments:\n  - label: no-target\n");
    expect(f.name).toBe("X");
    expect(f.description).toBe("");
    expect(f.acceptanceCriteria).toEqual([]);
    expect(f.documents).toEqual([]);
    expect(f.tokenomics).toBeUndefined();
  });

  it("dump then load is idempotent (stable)", () => {
    const f = base({ name: "M1 - Auth", description: "d", acceptanceCriteria: [{ text: "a", done: false }], documents: [] });
    const once = dumpEntity("mission", f);
    const twice = dumpEntity("mission", loadEntity(once));
    expect(twice).toBe(once);
  });
});
