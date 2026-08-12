import { describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCommits, buildRepo } from "./fixtures/repo.js";

/**
 * The fixture builder retries a failed git call ONCE, because this suite's
 * heaviest fixture fails on CI at a measured ~1.9% per execution with
 * `fatal: could not parse HEAD` and 68 deliberate reproduction runs on real
 * runners could not make it happen. See the filed bug.
 *
 * That mitigation is only defensible while both of these hold, so both are
 * asserted rather than trusted: it must actually recover a transient fault,
 * and it must still fail loudly on a persistent one. A retry that quietly
 * swallowed a real breakage would be strictly worse than the flake.
 */
describe("fixture git retry", () => {
  it("recovers when the fault clears outside this process", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    // A pre-commit hook that fails the FIRST time and passes afterwards: an
    // external, self-clearing fault, which is the shape the retry exists for.
    // It has to clear outside our process — the retry pause is synchronous,
    // so anything needing our event loop to turn could never recover.
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\n` +
        `d=$(git rev-parse --git-dir)\n` +
        `if [ ! -f "$d/tripped" ]; then touch "$d/tripped"; exit 1; fi\n` +
        `exit 0\n`,
    );
    chmodSync(hook, 0o755);

    expect(() => appendCommits(repo, [{ files: ["c.ts", "d.ts"] }])).not.toThrow();
  });

  it("still fails, with both states captured, when the fault persists", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    writeFileSync(join(repo, ".git", "HEAD"), "broken forever\n");

    let message = "";
    try {
      appendCommits(repo, [{ files: ["c.ts", "d.ts"] }]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("failed TWICE");
    // Both dumps, because the difference between them is the evidence: a
    // state that changed across the retry means something is mutating the
    // repository underneath us, which is the leading unproven theory.
    expect(message).toContain("state before retry");
    expect(message).toContain("state after retry");
    expect(message).toContain("HEAD file: broken forever");
  });
});
