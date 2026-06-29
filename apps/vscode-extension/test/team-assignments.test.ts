// apps/vscode-extension/test/team-assignments.test.ts
import { describe, it, expect } from "vitest";
import { TeamAssignments, type Memento } from "../src/host/team-assignments.js";

/** In-memory fake Memento for testing without real VS Code. */
class FakeMemento implements Memento {
  private store: Record<string, unknown> = {};
  get<T>(key: string): T | undefined { return this.store[key] as T | undefined; }
  update(key: string, value: unknown): Thenable<void> {
    this.store[key] = value;
    return Promise.resolve();
  }
}

function makeAssignments(): TeamAssignments {
  return new TeamAssignments(new FakeMemento());
}

describe("TeamAssignments", () => {
  it("get returns null for unknown key", () => {
    const ta = makeAssignments();
    expect(ta.get("project", "", "mission")).toBeNull();
    expect(ta.get("campaign", "camp1", "bug")).toBeNull();
  });

  it("set/get round-trips a teamId", async () => {
    const ta = makeAssignments();
    await ta.set("campaign", "camp1", "mission", "team-eng");
    expect(ta.get("campaign", "camp1", "mission")).toBe("team-eng");
  });

  it("set/get with null teamId clears the assignment", async () => {
    const ta = makeAssignments();
    await ta.set("project", "", "bug", "team-qa");
    expect(ta.get("project", "", "bug")).toBe("team-qa");
    await ta.set("project", "", "bug", null);
    expect(ta.get("project", "", "bug")).toBeNull();
  });

  it("list returns all set assignments", async () => {
    const ta = makeAssignments();
    await ta.set("campaign", "camp1", "mission", "team-eng");
    await ta.set("campaign", "camp1", "bug", "team-qa");
    await ta.set("mission", "m1", "bug", "team-sec");

    const all = ta.list();
    expect(all).toHaveLength(3);
    expect(all).toContainEqual({ scope: "campaign", scopeId: "camp1", workType: "mission", teamId: "team-eng" });
    expect(all).toContainEqual({ scope: "campaign", scopeId: "camp1", workType: "bug", teamId: "team-qa" });
    expect(all).toContainEqual({ scope: "mission", scopeId: "m1", workType: "bug", teamId: "team-sec" });
  });

  it("list includes entries with null teamId", async () => {
    const ta = makeAssignments();
    await ta.set("project", "", "campaign", null);
    const all = ta.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.teamId).toBeNull();
  });

  it("different scopes are independent", async () => {
    const ta = makeAssignments();
    await ta.set("campaign", "c1", "mission", "team-A");
    await ta.set("mission", "c1", "mission", "team-B");
    expect(ta.get("campaign", "c1", "mission")).toBe("team-A");
    expect(ta.get("mission", "c1", "mission")).toBe("team-B");
  });

  it("list is empty before any set", () => {
    const ta = makeAssignments();
    expect(ta.list()).toEqual([]);
  });
});
