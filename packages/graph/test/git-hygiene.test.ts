import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCommits, buildRepo } from "./fixtures/repo.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

/**
 * M4 B1: a fixture's `git commit` must not leave a detached
 * `git maintenance` process behind to race the temp-dir teardown.
 */
describe("fixture git hygiene", () => {
  it("fixture commits start no background maintenance or gc process", () => {
    const trace = join(mkdtempClean("octograph-hygiene-"), "trace2.json");
    writeFileSync(trace, "");
    const prev = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
      appendCommits(repo, [{ files: ["c.ts", "d.ts"] }]);
    } finally {
      if (prev === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = prev;
    }
    const names = readFileSync(trace, "utf8")
      .split("\n")
      .filter((l) => l.includes('"event":"cmd_name"'))
      .map((l) => (JSON.parse(l) as { name: string }).name);
    expect(names).toContain("commit");
    expect(names).not.toContain("maintenance");
    expect(names).not.toContain("gc");
  });

  it("an inline git call in a test inherits the same settings", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const get = (k: string) =>
      execFileSync("git", ["config", "--get", k], { cwd: repo, encoding: "utf8" }).trim();
    expect(get("gc.auto")).toBe("0");
    expect(get("maintenance.auto")).toBe("false");
  });
});
