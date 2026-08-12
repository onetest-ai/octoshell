---
name: graph fixture — map output must be gitignored before a second run
description: >-
  A packages/graph test fixture that runs `map` twice (via runCli or the
  bundle) with `appendCommits` in between must gitignore the out directory
  first, or the first run's own output becomes a bogus module in the second.
type: reference
tags: [area/graph, area/testing]
created: 2026-08-10
updated: 2026-08-10
---

## The trap

`packages/graph/test/fixtures/repo.ts`'s `appendCommits` stages with `git add
-A` — the whole working tree diff, not just the files the caller named. Any
`map` (or `runCli(["map", ...])`) run writes `map.md` and `clusters.json`
into the resolved out directory (`.octograph/` when no `.octobots/` board
exists) **inside the fixture repo itself**.

Sequence that breaks: build a repo → run `map` (writes `.octograph/map.md`
+ `clusters.json`, untracked) → call `appendCommits` to simulate a second
round of history → its `git add -A` sweeps up those two untracked files
alongside whatever the caller meant to commit → they become harvestable, and
`.octograph/*` collapses under the two-segment module convention into a
bogus `(repo root)`-adjacent `.octograph` module on the *next* `map` run.

Verified 2026-08-10 (`packages/graph/test/e2e-gate.test.ts`, T3.6): a
map-diff-confinement test that asserted the exact set of module names across
two runs failed with a fourth `".octograph"` module until fixed.

## The fix

Commit a `.gitignore` for the out directory as its **own, single-file**
commit before the first `map` run — not via `appendCommits` (which
overwrites file content with fixture placeholder bytes, so a `.gitignore`
committed that way carries junk, not an ignore pattern) and not left
uncommitted (an untracked `.gitignore` would itself ride along on the very
next multi-file `appendCommits` commit and become a bogus root-level module).

```ts
writeFileSync(join(repo, ".gitignore"), ".octograph/\n");
execFileSync("git", ["add", ".gitignore"], { cwd: repo, stdio: "pipe" });
execFileSync("git", ["commit", "-q", "-m", "chore: ignore build output"], {
  cwd: repo,
  stdio: "pipe",
});
```

This works *because* `harvest()` drops any commit touching fewer than two
files — a solo `.gitignore` commit is invisible to the whole pipeline by
construction, never a module member and never counted in anyone's co-change
support.

## Why existing tests never hit this

`cli.test.ts`'s "map pins cluster ids onto the previous run" test does the
same two-runs-with-appendCommits-in-between shape and never gitignores
anything — but it only asserts on ONE specific cluster id
(`modA/a.ts`'s), so the bogus `.octograph` module's presence doesn't fail
it. Any *new* test that inspects the full module set, or the full
`clusters.json`/`map.md` diff, will hit this the same way T3.6 did.

Related: [[dist-before-typecheck]] · CLAUDE.md's "Reuse the single spelling
of a rule" — this isn't that class of bug, but it's the same flavor of
"passes until something asserts more precisely."
