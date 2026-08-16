import { describe, expect, it, vi } from "vitest";

/**
 * `porcelainPaths` (diff-impact.ts) consumes the SEPARATE NUL-terminated
 * record a rename/copy status is followed by — the old path — and keeps only
 * the new one. `test/diff-impact.test.ts` exercises that against a real
 * `git mv`, but real git NEVER emits a rename record without its old-path
 * companion; there is no way to reach "a rename is the LAST record, with
 * nothing after it" from a live repository. The only way to reach that shape
 * is a genuinely truncated read of the stream — a killed subprocess, a pipe
 * cut short, `maxBuffer` hit mid-record — which is why `node:child_process`
 * is mocked here to manufacture it directly, in its own file so this mock
 * never touches the real-git tests in `diff-impact.test.ts`.
 *
 * `execFileSync` always returns a single rename record and nothing else,
 * regardless of the git subcommand asked for. That is fine here: `worktree`
 * scope issues exactly one git call (`status --porcelain -z
 * --untracked-files=all`), so nothing else in `changedPaths` needs a real
 * answer for this scenario.
 */
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "R  src/new.ts\0"),
}));

const { changedPaths } = await import("../src/diff-impact.js");

describe("changedPaths — truncated porcelain stream", () => {
  it("a rename record as the LAST record, with no following old-path record, does not throw and returns the new path", () => {
    expect(() => changedPaths("/irrelevant", { kind: "worktree" }, "main", [])).not.toThrow();
    expect(changedPaths("/irrelevant", { kind: "worktree" }, "main", [])).toEqual(["src/new.ts"]);
  });
});
