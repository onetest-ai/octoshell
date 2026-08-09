import { describe, expect, it } from "vitest";
import { harvest } from "../src/harvest.js";
import { buildRepo } from "./fixtures/repo.js";

describe("harvest", () => {
  it("returns one entry per commit, newest first, with the files it touched", () => {
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts", "d.ts"] },
    ]);
    const commits = harvest(repo);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.files.sort()).toEqual(["c.ts", "d.ts"]);
    expect(commits[1]?.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("drops mega-commits above maxCommitFiles", () => {
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const repo = buildRepo([{ files: many }, { files: ["x.ts", "y.ts"] }]);
    const commits = harvest(repo, { maxCommitFiles: 50 });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files.sort()).toEqual(["x.ts", "y.ts"]);
  });

  it("carries a commit timestamp in epoch milliseconds", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"], daysAgo: 10 }]);
    expect(commits0Timestamp(repo)).toBeGreaterThan(0);
  });

  it("drops single-file commits, which contribute no co-change pair", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["solo.ts"] }]);
    const commits = harvest(repo);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files.sort()).toEqual(["a.ts", "b.ts"]);
  });
});

function commits0Timestamp(repo: string): number {
  const c = harvest(repo)[0];
  if (!c) throw new Error("expected a commit");
  return c.timestamp;
}
