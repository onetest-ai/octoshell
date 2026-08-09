import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest } from "../src/harvest.js";
import { appendCommits, buildRepo } from "./fixtures/repo.js";

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
    // The fixture pins commit dates to 2026-01-01 minus daysAgo, so the exact
    // value is knowable. Asserting `> 0` would also pass for epoch *seconds*,
    // and every downstream decay half-life is denominated in milliseconds.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"], daysAgo: 10 }]);
    expect(commits0Timestamp(repo)).toBe(Date.UTC(2025, 11, 22));
  });

  it("drops single-file commits, which contribute no co-change pair", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["solo.ts"] }]);
    const commits = harvest(repo);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("returns raw paths for names git would otherwise C-quote", () => {
    // core.quotePath (on by default) turns `src/résumé.ts` into the literal
    // 21-character string `"src/r\303\251sum\303\251.ts"`, quotes included —
    // a path that exists in no repo. Same for names holding a quote or a space.
    const tricky = ["src/résumé.ts", 'src/say "hi".ts', "src/two words.ts"];
    const repo = buildRepo([{ files: tricky }]);

    const files = harvest(repo)[0]?.files ?? [];
    expect(files).toHaveLength(tricky.length);
    for (const path of files) {
      expect(path.startsWith('"')).toBe(false);
      expect(path).not.toContain("\\");
      // The strongest form of the assertion: the harvested path is a path.
      expect(existsSync(join(repo, path))).toBe(true);
    }
  });

  it("sees history added by a second appendCommits round at the default seed", () => {
    // appendCommits must write fresh bytes on every round; if it reuses the
    // seed the second round is an empty diff and git commit exits non-zero.
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    appendCommits(repo, [{ files: ["a.ts", "b.ts"] }]);
    appendCommits(repo, [{ files: ["a.ts", "b.ts"] }]);

    const commits = harvest(repo);
    expect(commits).toHaveLength(3);
    expect(new Set(commits.map((c) => c.sha)).size).toBe(3);
  });
});

function commits0Timestamp(repo: string): number {
  const c = harvest(repo)[0];
  if (!c) throw new Error("expected a commit");
  return c.timestamp;
}
