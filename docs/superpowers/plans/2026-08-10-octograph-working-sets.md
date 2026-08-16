# Octograph Working Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Louvain communities that disagree with the declared module structure — the "discovered delta" half of spec D3 — as a `Working sets` section in `map.md`, and nothing else.

**Architecture:** `analyze()` already computes a Louvain partition (`byCommunity`) and immediately collapses it into module *names*. This plan keeps that collapse and adds a second, independent consumer of the same partition: a `WorkingSet[]` on `Analysis`, filtered to communities that span two or more declared modules, suppressed wholesale when history is too thin for clustering to mean anything. `renderMap` gains a third truncatable section that obeys the existing token budget and the existing dangling-reference invariant.

**Tech Stack:** TypeScript (NodeNext ESM, `strict`, `noUncheckedIndexedAccess`), Vitest. No new dependencies.

## Global Constraints

- **Relative imports carry the `.js` extension** even from `.ts` source (`import { x } from "./foo.js"`).
- **No new runtime dependencies.** The pack bundle must stay installable with no `node_modules`.
- **Deterministic.** No `Date.now()`, no `Math.random()`, no iteration over `Set`/`Map` insertion order that reaches an artifact. Order by a property of the data, tie-broken with `compare` from `rollup.ts`.
- **Byte-reproducible.** Two runs over an unchanged commit produce byte-identical `map.md`.
- **Anything a consumer needs is re-exported from `src/index.ts`,** or it does not exist outside the package. This has been missed by two prior missions; `test/conventions.test.ts` guards it.
- **The section states what it observed, never what to do.** No "consider merging", no "these should be one module". Co-change is evidence of coupling, not evidence of a correct boundary.

---

## Measured baseline (repo HEAD, 65 analysable commits, 2026-08-10)

Ground truth for the tasks below, produced by replicating `analyze()`'s pipeline up to `partition`:

| Community | Files | Spans |
|---|---|---|
| #97 | 10 | `apps/vscode-extension` + `packages/board` |
| #77 | 4 | `apps/vscode-extension` + `packages/tokenomics` |
| #111 | 3 | `apps/vscode-extension` + `packages/board` |
| #24 | 2 | `(repo root)` + `packages/graph` |

10 communities, 7 declared modules, 4 crossing. **#24 is `packages/graph/package.json` + `pnpm-lock.yaml`** — a manifest/lockfile pair the noise floor already classifies as mechanical. It must not ship as a working set (Task 1, Step 5).

Tests do **not** appear in any community: `analyze.ts` excludes `testIds` from clustering (A8). The mission note's claim that community #97 contains "their tests" is stale and is corrected on the board.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/graph/src/working-sets.ts` | **Create.** `WorkingSet` type + `workingSets()`: the boundary-crossing filter, the noise-floor exclusion, naming, ordering. Pure — takes the partition and the spine, touches no disk. |
| `packages/graph/src/analyze.ts` | **Modify.** Call `workingSets()` from the existing `byCommunity`/`spine` locals; add the field to `Analysis`. |
| `packages/graph/src/config.ts` | **Modify.** Export `historyIsThin()` — the single spelling of the thin-history predicate, currently open-coded in `doctor.ts`. |
| `packages/graph/src/doctor.ts` | **Modify.** Call `historyIsThin()` instead of open-coding `analysable < config.minCommits`. |
| `packages/graph/src/render.ts` | **Modify.** Render the `Working sets` section; make it a third participant in the truncation loop; restate the dangling-reference filter over it. |
| `packages/graph/src/index.ts` | **Modify.** Re-export `type WorkingSet` and `historyIsThin`. |
| `packages/graph/test/working-sets.test.ts` | **Create.** Unit tests for the filter, the noise exclusion, naming, ordering. |
| `packages/graph/test/render.test.ts` | **Modify.** Section rendering, suppression, dangling-reference, budget, byte-identity. |
| `packages/graph/test/conventions.test.ts` | **Modify.** Single-spelling guard for the thin-history predicate; new index exports. |
| `packages/graph/test/e2e.test.ts` | **Modify.** Task 4's hazard suite. |

---

### Task 1: The working-set computation

**Files:**
- Create: `packages/graph/src/working-sets.ts`
- Create: `packages/graph/test/working-sets.test.ts`
- Modify: `packages/graph/src/analyze.ts` (the `Analysis` interface, and after the `spine`/`byCommunity` locals exist)
- Modify: `packages/graph/src/index.ts`

**Interfaces:**

- Consumes: `byCommunity: Map<number, number[]>` and `partition`, `bridgedEdges`, `table.files`, `spine.moduleOf` — all already local to `analyze()`. `classifyPair` and `nameCluster` already exist.
- Produces:

```ts
export interface WorkingSet {
  /** The set's own name: its most central member's path. NOT a module name —
   *  a working set is precisely the thing that has no declared name. */
  name: string;
  /** Declared modules this set spans, ascending by `compare`. Always >= 2. */
  modules: string[];
  /** Member file paths, ascending by `compare`. */
  files: string[];
}

export function workingSets(
  byCommunity: Map<number, number[]>,
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): WorkingSet[];
```

`Analysis` gains `workingSets: WorkingSet[]`.

- [ ] **Step 1: Write the failing test — only boundary-crossing communities survive**

```ts
// packages/graph/test/working-sets.test.ts
import { describe, expect, it } from "vitest";
import { workingSets } from "../src/working-sets.js";

const moduleOf = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");

describe("workingSets", () => {
  it("drops a community whose files all fall inside one declared module", () => {
    const files = ["a/one.ts", "a/two.ts", "a/three.ts"];
    const byCommunity = new Map([[7, [0, 1, 2]]]);
    expect(workingSets(byCommunity, [], files, moduleOf)).toEqual([]);
  });

  it("keeps a community spanning two declared modules and names the span", () => {
    const files = ["a/one.ts", "b/two.ts"];
    const byCommunity = new Map([[7, [0, 1]]]);
    const [set] = workingSets(byCommunity, [], files, moduleOf);
    expect(set?.modules).toEqual(["a", "b"]);
    expect(set?.files).toEqual(["a/one.ts", "b/two.ts"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- working-sets`
Expected: FAIL — `Cannot find module '../src/working-sets.js'`.

- [ ] **Step 3: Implement the filter**

```ts
// packages/graph/src/working-sets.ts
import { nameCluster } from "./louvain.js";
import { classifyPair } from "./noise.js";
import { compare } from "./rollup.js";
import type { Edge } from "./weights.js";

export interface WorkingSet { name: string; modules: string[]; files: string[] }

export function workingSets(
  byCommunity: Map<number, number[]>,
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): WorkingSet[] {
  const out: WorkingSet[] = [];
  // Communities are iterated by ascending id, not Map insertion order: this
  // reaches map.md, so the order must be a property of the data.
  for (const [, members] of [...byCommunity.entries()].sort((x, y) => x[0] - y[0])) {
    const paths = members
      .map((n) => files[n])
      .filter((p): p is string => p !== undefined)
      .sort(compare);
    const modules = [...new Set(paths.map(moduleOf))].sort(compare);
    if (modules.length < 2) continue;   // agrees with the declared structure — not a delta
    const primary = nameCluster(members, edges, files, 1)[0];
    const name = primary === undefined ? paths[0] : files[primary];
    if (name === undefined) continue;
    out.push({ name, modules, files: paths });
  }
  // Largest first: the biggest disagreement is the one worth reading. Ties on
  // name, through the same comparator every other ordering here uses.
  return out.sort((x, y) => y.files.length - x.files.length || compare(x.name, y.name));
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @octoshell/graph test -- working-sets`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the noise-floor exclusion**

Measured on this repo: community #24 is `packages/graph/package.json` + `pnpm-lock.yaml`, which spans `(repo root)` and `packages/graph` and would therefore pass the boundary filter. It is a manifest/lockfile pair — mechanical co-change, already classified by `classifyPair`, already suppressed in `drift`. A two-file set that is *entirely* one noise pair carries no architectural claim.

```ts
it("drops a two-file set that is entirely a manifest/lockfile pair", () => {
  const files = ["packages/graph/package.json", "pnpm-lock.yaml"];
  const mod = (p: string): string => (p.includes("/") ? "packages/graph" : "(repo root)");
  expect(workingSets(new Map([[24, [0, 1]]]), [], files, mod)).toEqual([]);
});

it("keeps a larger set that merely contains a lockfile", () => {
  const files = ["a/x.ts", "b/y.ts", "pnpm-lock.yaml"];
  const mod = (p: string): string => (p.startsWith("a/") ? "a" : p.startsWith("b/") ? "b" : "root");
  expect(workingSets(new Map([[9, [0, 1, 2]]]), [], files, mod)).toHaveLength(1);
});
```

Run: `pnpm --filter @octoshell/graph test -- working-sets` → FAIL (first case returns one set).

- [ ] **Step 6: Implement the exclusion — bounded to exactly the case it is justified for**

Insert after the `modules.length < 2` guard:

```ts
    // A set of exactly two files that `classifyPair` does not call a real
    // candidate IS that noise pair and nothing else — in practice a lockfile
    // moving with its manifest. Suppress it.
    //
    // Only the mechanical case can actually arrive here: A8 strips test ids
    // from the edge set BEFORE `louvain()` runs (analyze.ts), so no test file
    // ever reaches a community, and `intra-module` cannot span two declared
    // modules by definition. `classifyPair` is still the right call rather
    // than an open-coded manifest test — it is this package's single spelling
    // of "mechanical co-change" — but do not read this line as handling
    // test-subject pairs. It does not, because it cannot.
    //
    // Do NOT generalise to "contains a noisy pair": a ten-file set that
    // happens to include a lockfile is still a real working set, and dropping
    // it would delete the mission's own headline result. The rule is scoped to
    // the case where the noise pair IS the set.
    if (paths.length === 2) {
      const [a, b] = paths;
      if (a !== undefined && b !== undefined && classifyPair(a, b) !== "candidate") continue;
    }
```

> `"candidate"` is the discriminant, spelled exactly as `drift.ts:105` spells it. `PairClass` is
> `"test-subject" | "mechanical" | "intra-module" | "candidate"` — there is no `"signal"` member.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `pnpm --filter @octoshell/graph test -- working-sets`
Expected: PASS, 4 tests.

- [ ] **Step 8: Wire it into `analyze()` and export it**

In `analyze.ts`, after `byCommunity` and `spine` both exist and before the return, compute `workingSets(byCommunity, bridgedEdges, table.files, spine.moduleOf)` and add it to the returned `analysis` object; add `workingSets: WorkingSet[]` to the `Analysis` interface. Use `bridgedEdges` — the edge set clustering actually saw — so centrality-based naming measures the same graph the partition came from.

In `index.ts`, add `export { workingSets, type WorkingSet } from "./working-sets.js";`.

- [ ] **Step 9: Assert the real result, on this repo**

```ts
it("finds the dual-schema working set on this repo's own history", () => {
  const { analysis } = analyze(repoRoot, loadConfig(repoRoot, {}), { now: FIXED_NOW });
  const set = analysis.workingSets.find((w) =>
    w.files.includes("packages/board/src/entity-schema.ts"));
  expect(set?.files.some((f) => f.endsWith("entity-io.mjs"))).toBe(true);
  expect(set?.modules).toEqual(["apps/vscode-extension", "packages/board"]);
});
```

> This is a live-history assertion and it will drift as the repo grows. That is deliberate — it is mission criterion 5, and the campaign has twice shipped a claim nothing re-checked. If a future commit breaks it, the fix is to re-measure and decide, not to delete the test.

- [ ] **Step 10: Full suite, typecheck, lint, commit**

```bash
pnpm --filter @octoshell/graph test && pnpm --filter @octoshell/graph typecheck && pnpm --filter @octoshell/graph lint
git add packages/graph/src/working-sets.ts packages/graph/src/analyze.ts packages/graph/src/index.ts packages/graph/test/working-sets.test.ts
git commit -m "feat(graph): compute boundary-crossing working sets from the Louvain partition"
```

---

### Task 2: One spelling of "history is too thin to cluster"

**Files:**
- Modify: `packages/graph/src/config.ts` (add `historyIsThin`)
- Modify: `packages/graph/src/doctor.ts:89` (the `const thin = analysable < config.minCommits` line)
- Modify: `packages/graph/src/analyze.ts`
- Modify: `packages/graph/src/index.ts`
- Modify: `packages/graph/test/conventions.test.ts`

**Interfaces:**

- Consumes: `Config.minCommits` (exists; `doctor.ts` already reads it).
- Produces: `export function historyIsThin(analysableCommits: number, config: Config): boolean`

Mission criterion 3 requires the section to vanish when `doctor` grades history degraded. That makes `doctor`'s thinness rule a **shared** predicate, and pack v40 doctrine puts the guard entry in the task that introduces the sharing — not in the review that follows it.

- [ ] **Step 1: Write the failing conventions test**

```ts
// packages/graph/test/conventions.test.ts
it("spells the thin-history rule exactly once", async () => {
  const src = await readdir(new URL("../src/", import.meta.url));
  const hits: string[] = [];
  for (const f of src.filter((n) => n.endsWith(".ts"))) {
    const text = await readFile(new URL(`../src/${f}`, import.meta.url), "utf8");
    if (/<\s*\w*\.?minCommits/.test(text) && f !== "config.ts") hits.push(f);
  }
  expect(hits).toEqual([]);   // every consumer calls historyIsThin()
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- conventions`
Expected: FAIL, listing `doctor.ts`.

- [ ] **Step 3: Extract the predicate**

```ts
// config.ts
/** The one rule for "this history is too thin for clustering to mean anything".
 *  `doctor` grades a repo `degraded` on it and `analyze` suppresses working
 *  sets on it — two surfaces that MUST agree, because criterion 3 is written
 *  as "absent whenever doctor says degraded". Two spellings of this would let
 *  map.md publish invented community structure on a repo doctor is calling
 *  untrustworthy in the same breath. */
export function historyIsThin(analysableCommits: number, config: Config): boolean {
  return analysableCommits < config.minCommits;
}
```

Replace the open-coded comparison in `doctor.ts` with a call.

- [ ] **Step 4: Suppress in `analyze()`**

Suppress at the **analysis** layer, not in the renderer: every consumer of `Analysis` — `map.md`, the artifact, M6's extension bridge — must see the same suppression, and a render-time check would leave the others publishing what the renderer refused to.

```ts
  const sets = historyIsThin(commits.length, config)
    ? []
    : workingSets(byCommunity, bridgedEdges, table.files, spine.moduleOf);
```

> An empty `workingSets` means "nothing to report" whether the cause is thin history or a repo whose communities all agree with its modules. Criterion 3 requires the section to be **absent, not caveated**, so the renderer does not need to tell those apart — and must not invent a caveat that says which.

- [ ] **Step 5: Test suppression at the analysis layer**

```ts
it("reports no working sets when history is below the doctor threshold", () => {
  const repo = mkdtempClean();               // the fixture helper — never a bare mkdtemp
  // ...commit a handful of files across two module dirs...
  const cfg = { ...loadConfig(repo, {}), minCommits: 1000 };
  expect(analyze(repo, cfg, { now: FIXED_NOW }).analysis.workingSets).toEqual([]);
});
```

Use `mkdtempClean()` from the existing test helper. A bare `mkdtemp` leaked 2,502 fixture repos and 1.2 GB in this campaign and broke CI.

- [ ] **Step 5b: Tie the two surfaces together with one test — criterion 3 is about `doctor`, not about `minCommits`**

`degraded ⟺ historyIsThin` is true **today** only because `doctor`'s two `required: true` checks are `repository` (always `ok` on any branch that reaches the grade) and `history depth`. `graphify` and `board` are `required: false`. Promote either one — and D10/D11 point that way — and `doctor` grades `degraded` for a reason `historyIsThin` has never heard of, while criterion 3 silently starts failing. Testing suppression through `minCommits` alone never notices.

```ts
it("suppresses working sets on exactly the repos doctor grades degraded", () => {
  const repo = mkdtempClean();
  // ...a fixture with real cross-module co-change, above minCommits...
  const thin = { ...loadConfig(repo, {}), minCommits: 1000 };
  expect(doctor(repo, thin).status).toBe("degraded");
  expect(analyze(repo, thin, { now: FIXED_NOW }).analysis.workingSets).toEqual([]);
});
```

Add a one-line comment at `doctor.ts`'s required-check list: a third `required: true` check breaks the equivalence criterion 3 is written on, and must revisit this coupling.

- [ ] **Step 6: Run, export, commit**

```bash
pnpm --filter @octoshell/graph test
git add packages/graph/src/config.ts packages/graph/src/doctor.ts packages/graph/src/analyze.ts packages/graph/src/index.ts packages/graph/test/
git commit -m "feat(graph): one spelling of the thin-history rule, and suppress working sets on it"
```

---

### Task 3: Render the Working sets section

**Files:**
- Modify: `packages/graph/src/render.ts`
- Modify: `packages/graph/test/render.test.ts`

**Interfaces:**

- Consumes: `Analysis.workingSets` (Task 1), already suppressed by Task 2.
- Produces: no new exports. `renderMap`'s signature is unchanged.

> `render.test.ts` builds the only hand-written `Analysis` literal in the test tree (around lines 5–18). It needs `workingSets: []` added or the file will not typecheck once Task 1 lands.

The section goes **after** Modules and the edge section — it is the interpretation layer, and a reader needs the declared structure in hand first.

Target shape:

```markdown
## Working sets

_Files that move together across declared module boundaries. Observed from commit
history; a working set is evidence of coupling, not a proposal to change any boundary._

- **packages/board/src/entity-schema.ts** — 10 files across apps/vscode-extension, packages/board
  - apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs
  - packages/board/src/entity-schema.ts
  - ...
```

- [ ] **Step 1: Write the failing tests**

```ts
it("omits the section entirely when there are no working sets", () => {
  const out = renderMap({ ...baseAnalysis, workingSets: [] }, 4000);
  expect(out).not.toContain("## Working sets");
});

it("names the modules a working set spans and lists its files", () => {
  const out = renderMap({ ...baseAnalysis, workingSets: [
    { name: "a/x.ts", modules: ["a", "b"], files: ["a/x.ts", "b/y.ts"] },
  ] }, 4000);
  expect(out).toContain("## Working sets");
  expect(out).toContain("2 files across a, b");
  expect(out).toContain("  - b/y.ts");
});

it("states no recommendation", () => {
  const out = renderMap({ ...baseAnalysis, workingSets: [/* as above */] }, 4000);
  const section = out.slice(out.indexOf("## Working sets"));
  for (const word of ["should", "consider", "recommend", "merge these", "split"])
    expect(section.toLowerCase()).not.toContain(word);
});

it("drops a working set naming a module the budget trimmed away", () => {
  // budget small enough that module "b" loses its heading
  const out = renderMap({ ...analysisWithManyModules, workingSets: [
    { name: "a/x.ts", modules: ["a", "b"], files: ["a/x.ts", "b/y.ts"] },
  ] }, 200);
  if (out.includes("## Working sets")) expect(out).not.toContain("a/x.ts");
});

it("regenerates byte-identically", () => {
  expect(renderMap(a, 4000)).toBe(renderMap(a, 4000));
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm --filter @octoshell/graph test -- render`

- [ ] **Step 3: Implement — the dangling-reference filter first**

Mirror `visibleEdges` exactly; this is criterion 6 and it is the same invariant, restated at a new surface:

```ts
  // Criterion 6, and the third surface this invariant has had to be pinned at
  // (in-memory Analysis, then the Graphify branch, then rendered markdown).
  // Same rule as `visibleEdges`: a working set naming a module the budget cut
  // is a dangling reference in a committed artifact. Pinned at the boundary
  // the harm crosses — the rendered file — not at the layer it was found in.
  const visibleSets = (keptModules: number): WorkingSet[] => {
    const shown = new Set(ranked.slice(0, keptModules).map((m) => m.name));
    return analysis.workingSets.filter((w) => w.modules.every((m) => shown.has(m)));
  };

  // Slice by SET, then flat-map to lines — never the reverse. `visibleEdges`
  // returns lines and is sliced by line because one edge is exactly one line;
  // a working set is a header plus N file lines, so slicing its lines would cut
  // a set mid-membership and render a header claiming "10 files" above four of
  // them. That is the partial-presented-as-total defect the Modules header
  // comment already guards, reintroduced at a new surface.
  const setLines = (sets: WorkingSet[]): string[] =>
    sets.flatMap((w) => [
      `- **${w.name}** — ${w.files.length} files across ${w.modules.join(", ")}`,
      ...w.files.map((f) => `  - ${f}`),
    ]);
```

- [ ] **Step 4: Implement — the section, and a third participant in the budget loop**

`compose` gains a `keptSets` parameter — **a count of sets, not of lines** — and emits the section only when the sliced list is non-empty:

```ts
    const shownSets = visibleSets(keptModules).slice(0, Math.max(0, keptSets));
    // ...
    ...(shownSets.length > 0
      ? ["", "## Working sets", "", WORKING_SETS_NOTE, "", ...setLines(shownSets)]
      : []),
    ...note(analysis.workingSets.length - shownSets.length, "working set"),
```

The shrink loop currently balances two counters; extend it to three, shrinking whichever of `keptModules` / `shownEdges` / `shownSets` is largest. Termination is preserved: each branch strictly decreases one counter and all three floor at zero. A single working set larger than the whole budget is dropped entirely rather than truncated — correct, and a consequence of slicing by set.

- [ ] **Step 4b: Test that a rendered set shows its whole membership**

```ts
it("never renders a working set header above a partial file list", () => {
  const out = renderMap({ ...baseAnalysis, workingSets: [bigSet] }, 4000);
  const header = out.match(/- \*\*.+\*\* — (\d+) files across /);
  if (header) {
    const claimed = Number(header[1]);
    const rendered = out.slice(out.indexOf(header[0])).split("\n")
      .slice(1).filter((l) => l.startsWith("  - ")).length;
    expect(rendered).toBe(claimed);   // the header's count IS the membership shown
  }
});
```

> This is the assertion that makes the "slice by set" rule enforced rather than merely intended.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @octoshell/graph test -- render`

- [ ] **Step 6: Look at the real output**

```bash
pnpm --filter @octoshell/graph build && node packages/graph/dist/octograph.mjs map && sed -n '/## Working sets/,$p' .octobots/graph/map.md
```

Expect the three real sets (#97, #77, #111) and **not** #24. Read it as a person would: does it say something true and useful?

- [ ] **Step 7: Commit**

```bash
pnpm --filter @octoshell/graph test && pnpm --filter @octoshell/graph typecheck && pnpm --filter @octoshell/graph lint
git add packages/graph/src/render.ts packages/graph/test/render.test.ts
git commit -m "feat(graph): render the Working sets section in map.md"
```

---

### Task 4: End-to-end — suppression under thin history, no dangling module, byte-identical rerun, and the section that must stay silent

**Role:** `qa-engineer`

**Files:**
- Modify: `packages/graph/test/e2e.test.ts`

This is the mission's verification task. Its criteria are the mission's hazards, not "write tests":

- [ ] **Step 1: A fixture repo below the threshold produces a `map.md` with no `## Working sets` heading at all** — not a heading with a caveat, not an empty section. Built through the CLI (`runCli`), against the rendered file, using `mkdtempClean()`.
- [ ] **Step 2: A fixture repo above the threshold with a genuine cross-module co-change pattern produces the section, and every module named in it has a heading in `## Modules`.** Assert by parsing the rendered markdown, not by reading `Analysis`.
- [ ] **Step 3: The section contains no recommendation vocabulary,** asserted over the rendered file.
- [ ] **Step 4: Two consecutive `map` runs over an unchanged commit produce byte-identical `map.md`,** with the section present.
- [ ] **Step 5: `map.md` stays within `budgetTokens`** on a fixture with many working sets — assert `estimateTokens(rendered) <= budget`.
- [ ] **Step 6: Run the whole suite, typecheck, lint, build, and the pack bundle.** Confirm the bundle still runs under bare `node` with no `node_modules`.
- [ ] **Step 7: Commit.**

---

## Self-Review

**Spec coverage.** Mission criteria → tasks: C1 boundary filter → T1S1–4. C2 names modules + files → T3S3. C3 suppression below threshold → T2S4–5, T4S1. C4 no recommendation → T3S1, T4S3. C5 entity-schema set on this repo → T1S9. C6 dangling reference → T3S3, T4S2. C7 budget + byte-identity → T3S4, T4S4–5.

**Gap this plan adds to the mission's criteria.** The noise-floor exclusion (T1S5–6) is not in any of the seven criteria, and without it community #24 (`package.json` + `pnpm-lock.yaml`) ships as a working set. **Add it as an eighth criterion on the board before execution** — this campaign's recurring defect is work whose correctness no criterion states.

**Reviewed by tech-lead 2026-08-10**, who independently re-measured the baseline table (10 communities, 4 crossing, #24 = `package.json` + `pnpm-lock.yaml`, `classifyPair` → `"mechanical"`, zero test files in any community) and cleared the determinism risk: `louvain()` has no randomness to seed, and three consecutive runs over unchanged HEAD produced byte-identical partitions including Map iteration order. Four blocking findings were raised and are folded in above: the `"candidate"` discriminant, the false test-subject claim in the rationale comment, slicing working sets by set rather than by line, and tying criterion 3 to `doctor()` itself rather than to `minCommits`.

**Not in scope, deliberately:** `clusters.json` does not carry working sets. `StoredGraph.clusters` exists for the Jaccard stability remap; nothing reads working sets across runs, and adding a field no consumer reads is how `clusterIds` shipped fabricated in M2.
