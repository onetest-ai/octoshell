# Octograph Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/graph` — a zero-runtime-dependency library and CLI that mines git history into a module architecture map, contrasts it with the declared structure, and reports hidden coupling.

**Architecture:** Pure functions over a git log. Harvest commits → weight pairs by recency-decayed nPMI → quarantine hubs → Louvain communities → stabilise cluster IDs against the previously committed artifact → roll up to modules → contrast with a declared spine. No source parsing, no LLM, no embeddings, no server. esbuild bundles the same source into a self-contained `.mjs` for the Octobots pack, so there is exactly one implementation.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`, `noUncheckedIndexedAccess`), vitest 2, esbuild. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-octograph-design.md`

## Global Constraints

- **Zero runtime dependencies.** `packages/graph/package.json` has an empty `dependencies`. This is what lets esbuild emit a self-contained `.mjs`. Dev dependencies are fine.
- **ESM + NodeNext.** Every relative import carries a `.js` extension even though source is `.ts`. `import { harvest } from "./harvest.js"`.
- **`strict` + `noUncheckedIndexedAccess`** are on. Indexing an array yields `T | undefined` — handle it, never `!`.
- **No LLM, no embeddings, no network, no daemon.** Any task introducing one is wrong.
- **Never parse source code.** No tree-sitter, no AST, no regex-based symbol extraction. Import edges come only from a declared spine (manifests, directories, or Graphify's output).
- **Determinism.** Same commit + same config → byte-identical output. No `Date.now()` in graph computation; pass a reference timestamp in. Louvain uses a fixed seed.
- **Package name:** `@octoshell/graph`. **Tool name:** `octograph`.
- **Defaults, from the spec:** mega-commit cap 50 files; decay half-life 180 days; min-support 2; hub Z-threshold 3.0; `map.md` budget ~2000 tokens estimated at `chars/4`; `doctor` degraded threshold 200 analysable commits.

## Scope

**In:** package bootstrap, harvest, co-change weighting, clustering, stability, module rollup, declared spine, Graphify adapter, `map`, `impact`, `drift`, `doctor`, config, pack bundle.

**Out (separate plans):** the board overlay (`own`, `conflicts`), the interactive `setup` installer, and the VS Code extension bridge.

## File Structure

```
packages/graph/
  package.json          zero deps, build/test/typecheck/lint scripts
  tsconfig.json         extends ../../tsconfig.base.json
  src/
    types.ts            shared types, no logic
    config.ts           octograph.json load/merge/defaults
    harvest.ts          git log -> Commit[]           (A1)
    cochange.ts         pair counts, decay, nPMI       (A2, A3)
    hubs.ts             weighted-degree Z quarantine   (A4)
    louvain.ts          community detection            (A5)
    stability.ts        Jaccard cluster-ID remap       (A5b)
    components.ts       disconnected-component bridge  (A5e)
    rollup.ts           module projection + naming     (A5c, A5d)
    spine.ts            declared-spine precedence      (Input 2)
    graphify.ts         graph.json adapter             (Input 2 tier 1)
    layers.ts           topological layer ranks        (A4b)
    noise.ts            noise-floor classifiers        (A6)
    drift.ts            declared-vs-actual diff        (A6)
    render.ts           map.md + token budget          (A9)
    doctor.ts           health checks + exit states    (D10)
    cli.ts              arg parsing + dispatch
    index.ts            public API re-exports
  test/
    fixtures/repo.ts    scripted git fixture builder
    <module>.test.ts    one per source module
```

---

### Task 1: Package bootstrap, git fixture builder, and harvest

**Files:**
- Create: `packages/graph/package.json`, `packages/graph/tsconfig.json`
- Create: `packages/graph/src/types.ts`, `packages/graph/src/harvest.ts`, `packages/graph/src/index.ts`
- Test: `packages/graph/test/fixtures/repo.ts`, `packages/graph/test/harvest.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `Commit { sha: string; files: string[]; timestamp: number }`, `harvest(repoRoot: string, opts?: HarvestOptions): Commit[]`, `HarvestOptions { maxCommitFiles?: number; since?: string }`. The fixture builder `buildRepo(commits: CommitSpec[]): string` is used by every later test.

- [ ] **Step 1: Create the package manifest**

`packages/graph/package.json`:

```json
{
  "name": "@octoshell/graph",
  "version": "0.0.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {},
  "devDependencies": {
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "typescript": "^5.5.0",
    "eslint": "^9.0.0"
  }
}
```

`packages/graph/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Then run `pnpm install` from the repo root so the workspace picks the package up.

- [ ] **Step 2: Write the fixture builder**

This is used by every later task's tests, so it must be right. `packages/graph/test/fixtures/repo.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface CommitSpec {
  /** Repo-relative paths touched by this commit. */
  files: string[];
  /** Age of the commit in days. Defaults to 0 (now). */
  daysAgo?: number;
}

function gitIn(root: string) {
  return (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
}

/**
 * Add commits to an existing fixture repo. `seq` seeds file contents so a
 * second call writes different bytes and git actually records a change.
 */
export function appendCommits(root: string, commits: CommitSpec[], seq = 1000): void {
  const git = gitIn(root);
  commits.forEach((spec, i) => {
    for (const rel of spec.files) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      // Content must change or git records no diff for the file.
      writeFileSync(abs, `content ${seq + i}\n`);
    }
    git(["add", "-A"]);
    const when = new Date(Date.UTC(2026, 0, 1) - (spec.daysAgo ?? 0) * 86400000).toISOString();
    git(["commit", "-q", "-m", `commit ${seq + i}`], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });
  });
}

/** Build a throwaway git repo with a scripted history. Returns its path. */
export function buildRepo(commits: CommitSpec[]): string {
  const root = mkdtempSync(join(tmpdir(), "octograph-"));
  const git = gitIn(root);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  appendCommits(root, commits, 0);
  return root;
}
```

- [ ] **Step 3: Write the failing harvest test**

`packages/graph/test/harvest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { harvest } from "../src/harvest.js";
import { buildRepo } from "./fixtures/repo.js";

describe("harvest", () => {
  it("returns one entry per commit, newest first, with the files it touched", () => {
    const repo = buildRepo([
      { files: ["a.ts", "b.ts"] },
      { files: ["c.ts"] },
    ]);
    const commits = harvest(repo);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.files).toEqual(["c.ts"]);
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
});

function commits0Timestamp(repo: string): number {
  const c = harvest(repo)[0];
  if (!c) throw new Error("expected a commit");
  return c.timestamp;
}
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- harvest`
Expected: FAIL — cannot resolve `../src/harvest.js`.

- [ ] **Step 5: Write types and the harvest implementation**

`packages/graph/src/types.ts`:

```ts
/** One commit reduced to what co-change analysis needs. */
export interface Commit {
  sha: string;
  files: string[];
  /** Author timestamp, epoch milliseconds. */
  timestamp: number;
}
```

`packages/graph/src/harvest.ts`:

```ts
import { execFileSync } from "node:child_process";
import type { Commit } from "./types.js";

export interface HarvestOptions {
  /** Commits touching more files than this are dropped: rename sweeps and
   *  formatter runs assert coupling between every pair they touch, which is
   *  false and swamps the signal. */
  maxCommitFiles?: number;
  /** Passed through to `git log --since`. */
  since?: string;
}

const RECORD = " ";

/** Read a repo's history into commits, newest first. */
export function harvest(repoRoot: string, opts: HarvestOptions = {}): Commit[] {
  const maxFiles = opts.maxCommitFiles ?? 50;
  const args = ["log", "--no-merges", "--name-only", `--pretty=format:${RECORD}%H %at`];
  if (opts.since) args.push(`--since=${opts.since}`);

  const raw = execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
    encoding: "utf8",
  });

  const out: Commit[] = [];
  for (const block of raw.split(RECORD)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const header = lines[0];
    if (!header) continue;
    const [sha, at] = header.trim().split(" ");
    if (!sha || !at) continue;
    const files = [...new Set(lines.slice(1).filter((l) => l.length > 0))];
    if (files.length < 2 || files.length > maxFiles) continue;
    out.push({ sha, files, timestamp: Number(at) * 1000 });
  }
  return out;
}
```

Note `files.length < 2`: a single-file commit contributes no pair, so it is dropped here rather than filtered downstream.

`packages/graph/src/index.ts`:

```ts
export { harvest, type HarvestOptions } from "./harvest.js";
export type { Commit } from "./types.js";
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- harvest`
Expected: PASS, 3 tests.

Then `pnpm --filter @octoshell/graph typecheck` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/graph pnpm-lock.yaml
git commit -m "feat(graph): package bootstrap, git fixture builder, harvest"
```

---

### Task 2: Co-change pair counting with recency decay

**Files:**
- Create: `packages/graph/src/cochange.ts`
- Test: `packages/graph/test/cochange.test.ts`

**Interfaces:**
- Consumes: `Commit` from Task 1.
- Produces: `countPairs(commits: Commit[], opts: DecayOptions): PairTable`, where `PairTable { files: string[]; single: number[]; pairs: Map<number, Map<number, PairStat>>; commitCount: number }` and `PairStat { support: number; weight: number }`. Files are interned to integer ids; `pairs` is keyed `i -> j` with `i < j`. Later tasks index `files[i]` to recover a path.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/cochange.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
import type { Commit } from "../src/types.js";

const NOW = Date.UTC(2026, 0, 1);
const day = 86400000;

function commit(files: string[], daysAgo: number): Commit {
  return { sha: "x".repeat(40), files, timestamp: NOW - daysAgo * day };
}

describe("countPairs", () => {
  it("counts each unordered pair once per commit", () => {
    const table = countPairs([commit(["a", "b", "c"], 0)], { now: NOW });
    expect(table.commitCount).toBe(1);
    // 3 files -> 3 pairs
    let n = 0;
    for (const row of table.pairs.values()) n += row.size;
    expect(n).toBe(3);
  });

  it("weights a recent commit above an old one at equal support", () => {
    const recent = countPairs([commit(["a", "b"], 0)], { now: NOW, halfLifeDays: 180 });
    const old = countPairs([commit(["a", "b"], 360)], { now: NOW, halfLifeDays: 180 });
    expect(statOf(recent)).toBeGreaterThan(statOf(old) * 3);
  });

  it("decays by exactly one half over one half-life", () => {
    const t = countPairs([commit(["a", "b"], 180)], { now: NOW, halfLifeDays: 180 });
    expect(statOf(t)).toBeCloseTo(0.5, 5);
  });

  it("tracks per-file commit counts for later PMI denominators", () => {
    const table = countPairs(
      [commit(["a", "b"], 0), commit(["a", "c"], 0)],
      { now: NOW },
    );
    const ai = table.files.indexOf("a");
    expect(table.single[ai]).toBe(2);
  });
});

function statOf(t: ReturnType<typeof countPairs>): number {
  const row = [...t.pairs.values()][0];
  const stat = row ? [...row.values()][0] : undefined;
  if (!stat) throw new Error("expected a pair");
  return stat.weight;
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- cochange`
Expected: FAIL — cannot resolve `../src/cochange.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/cochange.ts`:

```ts
import type { Commit } from "./types.js";

export interface DecayOptions {
  /** Reference "now" in epoch ms. Passed in rather than read from the clock so
   *  the same commit always produces the same graph. */
  now: number;
  /** Days after which a commit's contribution halves. */
  halfLifeDays?: number;
}

export interface PairStat {
  /** Number of commits touching both files. */
  support: number;
  /** Sum of per-commit decay factors. */
  weight: number;
}

export interface PairTable {
  /** Interned paths; every id below indexes this array. */
  files: string[];
  /** single[i] = number of commits touching file i. */
  single: number[];
  /** i -> j -> stat, always i < j. */
  pairs: Map<number, Map<number, PairStat>>;
  commitCount: number;
}

export function countPairs(commits: Commit[], opts: DecayOptions): PairTable {
  const halfLife = opts.halfLifeDays ?? 180;
  const lambda = Math.LN2 / (halfLife * 86400000);

  const ids = new Map<string, number>();
  const files: string[] = [];
  const single: number[] = [];
  const pairs = new Map<number, Map<number, PairStat>>();

  const idOf = (path: string): number => {
    let id = ids.get(path);
    if (id === undefined) {
      id = files.length;
      ids.set(path, id);
      files.push(path);
      single.push(0);
    }
    return id;
  };

  for (const c of commits) {
    const age = Math.max(0, opts.now - c.timestamp);
    const decay = Math.exp(-lambda * age);
    const list = [...new Set(c.files.map(idOf))].sort((a, b) => a - b);

    for (const i of list) single[i] = (single[i] ?? 0) + 1;

    for (let x = 0; x < list.length; x++) {
      const i = list[x];
      if (i === undefined) continue;
      let row = pairs.get(i);
      if (!row) pairs.set(i, (row = new Map()));
      for (let y = x + 1; y < list.length; y++) {
        const j = list[y];
        if (j === undefined) continue;
        const stat = row.get(j);
        if (stat) {
          stat.support += 1;
          stat.weight += decay;
        } else {
          row.set(j, { support: 1, weight: decay });
        }
      }
    }
  }

  return { files, single, pairs, commitCount: commits.length };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- cochange`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): co-change pair counting with recency decay"
```

---

### Task 3: Normalized PMI edge weighting

**Files:**
- Create: `packages/graph/src/weights.ts`
- Test: `packages/graph/test/weights.test.ts`

**Interfaces:**
- Consumes: `PairTable` from Task 2.
- Produces: `weighEdges(table: PairTable, opts?: WeightOptions): Edge[]` where `Edge { a: number; b: number; support: number; npmi: number; confidence: number }`. Every later task consumes `Edge[]`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/weights.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { countPairs } from "../src/cochange.js";
import { weighEdges } from "../src/weights.js";
import type { Commit } from "../src/types.js";

const NOW = Date.UTC(2026, 0, 1);
const c = (files: string[]): Commit => ({ sha: "s", files, timestamp: NOW });

describe("weighEdges", () => {
  it("gives a perfectly co-occurring pair an nPMI of 1", () => {
    const edges = weighEdges(countPairs([c(["a", "b"]), c(["a", "b"])], { now: NOW }), {
      minSupport: 1,
    });
    const ab = edges.find((e) => e.support === 2);
    expect(ab?.npmi).toBeCloseTo(1, 5);
  });

  it("ranks a hub pairing below a genuine pairing at equal support", () => {
    // `lock` appears in every commit (a hub); `x`/`y` only appear together.
    const commits = [
      c(["lock", "x", "y"]),
      c(["lock", "p"]),
      c(["lock", "q"]),
      c(["lock", "r"]),
      c(["lock", "x", "y"]),
    ];
    const edges = weighEdges(countPairs(commits, { now: NOW }), { minSupport: 2 });
    const byKey = (a: string, b: string) => {
      const t = countPairs(commits, { now: NOW });
      const ai = t.files.indexOf(a);
      const bi = t.files.indexOf(b);
      return edges.find(
        (e) => (e.a === ai && e.b === bi) || (e.a === bi && e.b === ai),
      );
    };
    const xy = byKey("x", "y");
    const lockX = byKey("lock", "x");
    expect(xy).toBeDefined();
    expect(lockX).toBeDefined();
    expect(xy!.npmi).toBeGreaterThan(lockX!.npmi);
  });

  it("drops pairs below minSupport", () => {
    const edges = weighEdges(countPairs([c(["a", "b"])], { now: NOW }), { minSupport: 2 });
    expect(edges).toHaveLength(0);
  });

  it("reports confidence as the weaker directional share", () => {
    // a appears 3x, b appears 2x, together 2x -> min(2/3, 2/2) = 0.666…
    const edges = weighEdges(
      countPairs([c(["a", "b"]), c(["a", "b"]), c(["a", "z"])], { now: NOW }),
      { minSupport: 2 },
    );
    const ab = edges.find((e) => e.support === 2);
    expect(ab?.confidence).toBeCloseTo(2 / 3, 5);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- weights`
Expected: FAIL — cannot resolve `../src/weights.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/weights.ts`:

```ts
import type { PairTable } from "./cochange.js";

export interface WeightOptions {
  /** Pairs seen fewer times than this are noise. */
  minSupport?: number;
}

export interface Edge {
  a: number;
  b: number;
  support: number;
  /** Normalized pointwise mutual information, in [-1, 1]. */
  npmi: number;
  /** min(P(a|b), P(b|a)) — how much of the rarer file's history is shared. */
  confidence: number;
}

/**
 * Weight pairs by normalized PMI.
 *
 * Raw counts are useless here: a lockfile co-changes with everything, so
 * frequency alone ranks mechanical noise above real coupling. PMI divides out
 * each file's own churn; normalizing bounds the result to [-1, 1] so a single
 * threshold means the same thing in a small repo and a large one.
 */
export function weighEdges(table: PairTable, opts: WeightOptions = {}): Edge[] {
  const minSupport = opts.minSupport ?? 2;
  const n = table.commitCount;
  const out: Edge[] = [];
  if (n === 0) return out;

  for (const [i, row] of table.pairs) {
    for (const [j, stat] of row) {
      if (stat.support < minSupport) continue;
      const ci = table.single[i];
      const cj = table.single[j];
      if (ci === undefined || cj === undefined) continue;

      const pab = stat.support / n;
      const pmi = Math.log(pab / ((ci / n) * (cj / n)));
      // -log(pab) is 0 only when pab === 1, i.e. the pair is in every commit.
      const denom = -Math.log(pab);
      const npmi = denom === 0 ? 1 : pmi / denom;

      out.push({
        a: i,
        b: j,
        support: stat.support,
        npmi,
        confidence: Math.min(stat.support / ci, stat.support / cj),
      });
    }
  }

  // Deterministic order: strongest first, ties broken by file id.
  out.sort((x, y) => y.npmi - x.npmi || x.a - y.a || x.b - y.b);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- weights`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): normalized PMI edge weighting"
```

---

### Task 4: Hub quarantine by weighted degree

**Files:**
- Create: `packages/graph/src/hubs.ts`
- Test: `packages/graph/test/hubs.test.ts`

**Interfaces:**
- Consumes: `Edge[]` from Task 3.
- Produces: `detectHubs(edges: Edge[], fileCount: number, opts?: HubOptions): Set<number>`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/hubs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectHubs } from "../src/hubs.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi = 0.5): Edge => ({
  a, b, support: 3, npmi, confidence: 0.5,
});

describe("detectHubs", () => {
  it("flags a node connected to far more of the graph than the rest", () => {
    // node 0 touches 0..19; every other node touches only node 0 plus a neighbour.
    const edges: Edge[] = [];
    for (let i = 1; i <= 20; i++) edges.push(edge(0, i));
    for (let i = 1; i < 20; i += 2) edges.push(edge(i, i + 1));
    expect(detectHubs(edges, 21, { zThreshold: 3 }).has(0)).toBe(true);
  });

  it("flags nothing in a uniform graph", () => {
    const edges = [edge(0, 1), edge(1, 2), edge(2, 3), edge(3, 0)];
    expect(detectHubs(edges, 4, { zThreshold: 3 }).size).toBe(0);
  });

  it("returns an empty set for fewer than three nodes", () => {
    expect(detectHubs([edge(0, 1)], 2).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- hubs`
Expected: FAIL — cannot resolve `../src/hubs.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/hubs.ts`:

```ts
import type { Edge } from "./weights.js";

export interface HubOptions {
  /** Standard deviations above mean strength before a node is a hub. */
  zThreshold?: number;
}

/**
 * Find nodes that bridge unrelated parts of the graph.
 *
 * Adapted from wikis' `graph_topology.detect_hubs`, which measures IN-DEGREE
 * because its AST graph is directed. Co-occurrence has no direction, so
 * in-degree is undefined here — weighted degree (strength) is the analogue.
 *
 * nPMI already suppresses hub *weight*; quarantine is still needed because a
 * hub *bridges* communities and distorts partitioning even at low weight.
 */
export function detectHubs(
  edges: Edge[],
  fileCount: number,
  opts: HubOptions = {},
): Set<number> {
  const z = opts.zThreshold ?? 3;
  const hubs = new Set<number>();
  if (fileCount < 3) return hubs;

  const strength = new Array<number>(fileCount).fill(0);
  for (const e of edges) {
    strength[e.a] = (strength[e.a] ?? 0) + e.npmi;
    strength[e.b] = (strength[e.b] ?? 0) + e.npmi;
  }

  const mean = strength.reduce((a, b) => a + b, 0) / fileCount;
  const variance =
    strength.reduce((acc, s) => acc + (s - mean) ** 2, 0) / fileCount;
  const sd = Math.sqrt(variance);
  if (sd === 0) return hubs;

  strength.forEach((s, i) => {
    if ((s - mean) / sd > z) hubs.add(i);
  });
  return hubs;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- hubs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): hub quarantine by weighted degree z-score"
```

---

### Task 5: Louvain community detection with auto-tuned resolution

**Files:**
- Create: `packages/graph/src/louvain.ts`
- Test: `packages/graph/test/louvain.test.ts`

**Interfaces:**
- Consumes: `Edge[]` (Task 3), hub set (Task 4).
- Produces: `autoResolution(nodeCount: number): number` and `louvain(edges: Edge[], opts?: LouvainOptions): Map<number, number>` mapping node id → community id. Excluded (hub) nodes are absent from the map.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/louvain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { autoResolution, louvain } from "../src/louvain.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi: number): Edge => ({
  a, b, support: 5, npmi, confidence: 0.8,
});

describe("autoResolution", () => {
  it("follows gamma = max(0.3, 1 - 0.2*log10(n))", () => {
    expect(autoResolution(1)).toBe(1.0);
    expect(autoResolution(100)).toBeCloseTo(0.6, 5);
    expect(autoResolution(1_000_000)).toBe(0.3);
  });
});

describe("louvain", () => {
  it("separates two dense clusters joined by one weak edge", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.9), edge(0, 2, 0.9),
      edge(3, 4, 0.9), edge(4, 5, 0.9), edge(3, 5, 0.9),
      edge(2, 3, 0.05),
    ];
    const parts = louvain(edges);
    expect(parts.get(0)).toBe(parts.get(1));
    expect(parts.get(0)).toBe(parts.get(2));
    expect(parts.get(3)).toBe(parts.get(4));
    expect(parts.get(0)).not.toBe(parts.get(3));
  });

  it("is deterministic across runs", () => {
    const edges: Edge[] = [
      edge(0, 1, 0.9), edge(1, 2, 0.8), edge(2, 3, 0.7),
      edge(3, 4, 0.6), edge(4, 0, 0.5),
    ];
    expect([...louvain(edges)]).toEqual([...louvain(edges)]);
  });

  it("omits excluded nodes from the partition", () => {
    const edges = [edge(0, 1, 0.9), edge(1, 2, 0.9)];
    const parts = louvain(edges, { exclude: new Set([1]) });
    expect(parts.has(1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- louvain`
Expected: FAIL — cannot resolve `../src/louvain.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/louvain.ts`:

```ts
import type { Edge } from "./weights.js";

export interface LouvainOptions {
  /** Nodes to leave out of clustering (hubs). */
  exclude?: Set<number>;
  /** Resolution gamma. Defaults to autoResolution(nodeCount). */
  resolution?: number;
  maxPasses?: number;
}

/**
 * Resolution by graph size. Verbatim from wikis'
 * `graph_clustering.auto_resolution`: lower gamma yields fewer, larger
 * communities, and the constant is tuned so typical repos land in a sane range.
 */
export function autoResolution(nodeCount: number): number {
  if (nodeCount < 2) return 1.0;
  return Math.max(0.3, 1.0 - 0.2 * Math.log10(nodeCount));
}

/**
 * Louvain modularity maximisation over the weighted undirected graph.
 *
 * Deterministic: nodes are visited in ascending id order and ties are broken
 * toward the lower community id, so no seed or RNG is involved. That matters
 * because the output is a committed artifact — see stability.ts.
 */
export function louvain(edges: Edge[], opts: LouvainOptions = {}): Map<number, number> {
  const exclude = opts.exclude ?? new Set<number>();
  const kept = edges.filter((e) => !exclude.has(e.a) && !exclude.has(e.b));

  const nodes = [...new Set(kept.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const community = new Map<number, number>();
  nodes.forEach((n) => community.set(n, n));
  if (nodes.length === 0) return community;

  const gamma = opts.resolution ?? autoResolution(nodes.length);
  const maxPasses = opts.maxPasses ?? 20;

  // Adjacency with positive weights only: a negative nPMI means the pair
  // co-occurs less than chance, which is evidence of separation, not a link.
  const adj = new Map<number, Map<number, number>>();
  const strength = new Map<number, number>();
  let totalWeight = 0;
  for (const e of kept) {
    const w = Math.max(0, e.npmi);
    if (w === 0) continue;
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]] as const) {
      let row = adj.get(u);
      if (!row) adj.set(u, (row = new Map()));
      row.set(v, (row.get(v) ?? 0) + w);
      strength.set(u, (strength.get(u) ?? 0) + w);
    }
    totalWeight += w;
  }
  if (totalWeight === 0) return community;
  const m2 = 2 * totalWeight;

  const commStrength = new Map<number, number>();
  for (const n of nodes) commStrength.set(n, strength.get(n) ?? 0);

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const n of nodes) {
      const own = community.get(n);
      if (own === undefined) continue;
      const kn = strength.get(n) ?? 0;

      // Weight from n into each neighbouring community.
      const into = new Map<number, number>();
      for (const [nb, w] of adj.get(n) ?? []) {
        const c = community.get(nb);
        if (c === undefined || nb === n) continue;
        into.set(c, (into.get(c) ?? 0) + w);
      }

      commStrength.set(own, (commStrength.get(own) ?? 0) - kn);
      let best = own;
      let bestGain = (into.get(own) ?? 0) - (gamma * kn * (commStrength.get(own) ?? 0)) / m2;

      for (const [c, wIn] of into) {
        if (c === own) continue;
        const gain = wIn - (gamma * kn * (commStrength.get(c) ?? 0)) / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = gain;
        }
      }

      commStrength.set(best, (commStrength.get(best) ?? 0) + kn);
      if (best !== own) {
        community.set(n, best);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return community;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- louvain`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): louvain community detection with auto-tuned resolution"
```

---

### Task 6: Cluster ID stability via Jaccard remap

**Files:**
- Create: `packages/graph/src/stability.ts`
- Test: `packages/graph/test/stability.test.ts`

**Interfaces:**
- Consumes: partition maps from Task 5.
- Produces: `jaccard(a: Set<string>, b: Set<string>): number` and `remapClusters(oldClusters: Map<number, string[]>, newClusters: Map<number, string[]>, opts?): Map<number, number>` (new id → stable id).

**Why this task matters:** without it the committed artifact churns on every run even when nothing architectural changed, which destroys the entire "architecture drift shows up in code review" premise. This is the product's single point of failure.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/stability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { jaccard, remapClusters } from "../src/stability.js";

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint ones", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("treats two empty sets as 0 rather than NaN", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("remapClusters", () => {
  it("keeps the old id when membership is mostly preserved", () => {
    const oldC = new Map([[7, ["a", "b", "c", "d"]]]);
    const newC = new Map([[0, ["a", "b", "c", "e"]]]); // jaccard 3/5 = 0.6
    expect(remapClusters(oldC, newC).get(0)).toBe(7);
  });

  it("issues a fresh id when the cluster is genuinely new", () => {
    const oldC = new Map([[7, ["a", "b"]]]);
    const newC = new Map([[0, ["x", "y", "z"]]]);
    expect(remapClusters(oldC, newC).get(0)).toBe(8); // max(old) + 1
  });

  it("never assigns one old id to two new clusters", () => {
    const oldC = new Map([[3, ["a", "b", "c", "d"]]]);
    const newC = new Map([
      [0, ["a", "b"]],
      [1, ["c", "d"]],
    ]);
    const remap = remapClusters(oldC, newC, { threshold: 0.3 });
    expect(new Set(remap.values()).size).toBe(2);
  });

  it("is stable when nothing changed at all", () => {
    const clusters = new Map([[0, ["a", "b"]], [1, ["c", "d"]]]);
    const remap = remapClusters(clusters, clusters);
    expect(remap.get(0)).toBe(0);
    expect(remap.get(1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- stability`
Expected: FAIL — cannot resolve `../src/stability.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/stability.ts`:

```ts
export interface RemapOptions {
  /** Minimum overlap for a new cluster to inherit an old id. */
  threshold?: number;
}

/** |A ∩ B| / |A ∪ B|. Two empty sets are 0, not NaN — callers never ask. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pin fresh cluster ids onto the previous run's ids.
 *
 * Louvain is deterministic given the same graph, but the ids it assigns are
 * arbitrary — insertion order. The same logical module can come back labelled 7
 * instead of 3, which would rewrite most of map.md on a run where nothing
 * changed. Since the previous run is a committed artifact, the "old clusters"
 * input is simply read back from it: the artifact makes its own stability
 * computable, with no state store.
 *
 * Ported from wikis' `cluster_stability.compute_jaccard_remap`. The 0.5
 * threshold requires more than half the union preserved: lower matches
 * unrelated clusters, higher breaks ids on minor churn.
 */
export function remapClusters(
  oldClusters: Map<number, string[]>,
  newClusters: Map<number, string[]>,
  opts: RemapOptions = {},
): Map<number, number> {
  const threshold = opts.threshold ?? 0.5;
  const oldSets = new Map<number, Set<string>>();
  for (const [id, members] of oldClusters) oldSets.set(id, new Set(members));

  let nextId = oldClusters.size === 0 ? 0 : Math.max(...oldClusters.keys()) + 1;
  const claimed = new Set<number>();
  const remap = new Map<number, number>();

  // Score every (new, old) candidate, then assign greedily best-first so the
  // strongest match wins an id rather than whichever iterated first.
  const candidates: Array<{ newId: number; oldId: number; score: number }> = [];
  for (const [newId, members] of newClusters) {
    const set = new Set(members);
    for (const [oldId, oldSet] of oldSets) {
      const score = jaccard(set, oldSet);
      if (score >= threshold) candidates.push({ newId, oldId, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.newId - y.newId || x.oldId - y.oldId);

  for (const { newId, oldId } of candidates) {
    if (remap.has(newId) || claimed.has(oldId)) continue;
    remap.set(newId, oldId);
    claimed.add(oldId);
  }

  for (const newId of [...newClusters.keys()].sort((a, b) => a - b)) {
    if (!remap.has(newId)) remap.set(newId, nextId++);
  }
  return remap;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- stability`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): jaccard cluster-id remap for artifact stability"
```

---

### Task 7: Disconnected-component bridging

**Files:**
- Create: `packages/graph/src/components.ts`
- Test: `packages/graph/test/components.test.ts`

**Interfaces:**
- Consumes: `Edge[]` (Task 3), `files: string[]` (Task 2).
- Produces: `findComponents(edges: Edge[], nodes: number[]): number[][]` and `bridgeComponents(edges: Edge[], files: string[]): Edge[]` (input edges plus synthetic bridges).

- [ ] **Step 1: Write the failing test**

`packages/graph/test/components.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bridgeComponents, findComponents } from "../src/components.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number): Edge => ({
  a, b, support: 3, npmi: 0.7, confidence: 0.6,
});

describe("findComponents", () => {
  it("groups nodes reachable from each other", () => {
    const comps = findComponents([edge(0, 1), edge(2, 3)], [0, 1, 2, 3]);
    expect(comps).toHaveLength(2);
    expect(comps.map((c) => c.length).sort()).toEqual([2, 2]);
  });
});

describe("bridgeComponents", () => {
  const files = ["src/a/one.ts", "src/a/two.ts", "src/b/three.ts", "src/b/four.ts"];

  it("connects an isolated component to the most directory-similar one", () => {
    const bridged = bridgeComponents([edge(0, 1), edge(2, 3)], files);
    expect(bridged.length).toBeGreaterThan(2);
    expect(findComponents(bridged, [0, 1, 2, 3])).toHaveLength(1);
  });

  it("gives bridges a low weight so they connect without distorting", () => {
    const bridged = bridgeComponents([edge(0, 1), edge(2, 3)], files);
    const synthetic = bridged.filter((e) => e.support === 0);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const s of synthetic) expect(s.npmi).toBeLessThan(0.1);
  });

  it("adds nothing when the graph is already connected", () => {
    const edges = [edge(0, 1), edge(1, 2), edge(2, 3)];
    expect(bridgeComponents(edges, files)).toHaveLength(edges.length);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- components`
Expected: FAIL — cannot resolve `../src/components.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/components.ts`:

```ts
import type { Edge } from "./weights.js";

/** Weight given to synthetic bridge edges: enough to connect, too little to cluster. */
const BRIDGE_WEIGHT = 0.01;

/** Connected components, largest first. */
export function findComponents(edges: Edge[], nodes: number[]): number[][] {
  const adj = new Map<number, number[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }

  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop();
      if (n === undefined) continue;
      comp.push(n);
      for (const nb of adj.get(n) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp.sort((a, b) => a - b));
  }
  comps.sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
  return comps;
}

const dirOf = (p: string): string => p.split("/").slice(0, -1).join("/");

/** Histogram of directory prefixes across a component's files. */
function dirHistogram(comp: number[], files: string[]): Map<string, number> {
  const hist = new Map<string, number>();
  for (const n of comp) {
    const path = files[n];
    if (path === undefined) continue;
    const parts = dirOf(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      hist.set(prefix, (hist.get(prefix) ?? 0) + 1);
    }
  }
  return hist;
}

function similarity(a: Map<string, number>, b: Map<string, number>): number {
  let score = 0;
  for (const [k, v] of a) score += Math.min(v, b.get(k) ?? 0);
  return score;
}

/**
 * Connect isolated components via directory proximity.
 *
 * Louvain emits at least one community per connected component regardless of
 * resolution, so an unbridged co-change graph produces a long tail of junk
 * single-file "modules". Ported from wikis'
 * `graph_topology.bridge_disconnected_components`.
 */
export function bridgeComponents(edges: Edge[], files: string[]): Edge[] {
  const nodes = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const comps = findComponents(edges, nodes);
  if (comps.length <= 1) return edges;

  const hists = comps.map((c) => dirHistogram(c, files));
  const out = [...edges];

  for (let i = 1; i < comps.length; i++) {
    const comp = comps[i];
    const hist = hists[i];
    if (!comp || !hist) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let j = 0; j < i; j++) {
      const other = hists[j];
      if (!other) continue;
      const score = similarity(hist, other);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    const target = comps[bestIdx];
    const from = comp[0];
    const to = target?.[0];
    if (from === undefined || to === undefined) continue;
    out.push({
      a: Math.min(from, to),
      b: Math.max(from, to),
      support: 0, // synthetic: no commit backs this edge
      npmi: BRIDGE_WEIGHT,
      confidence: 0,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- components`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): bridge disconnected components by directory proximity"
```

---

### Task 8: Module rollup and PageRank naming

**Files:**
- Create: `packages/graph/src/rollup.ts`
- Test: `packages/graph/test/rollup.test.ts`

**Interfaces:**
- Consumes: `Edge[]` (Task 3), `files: string[]` (Task 2), partitions (Task 5).
- Produces: `pageRank(edges: Edge[], nodes: number[]): Map<number, number>`, `nameCluster(members: number[], edges: Edge[], files: string[], k?: number): string[]`, `rollUp(edges: Edge[], files: string[], moduleOf: (path: string) => string): ModuleEdge[]` where `ModuleEdge { from: string; to: string; weight: number }`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/rollup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nameCluster, pageRank, rollUp } from "../src/rollup.js";
import type { Edge } from "../src/weights.js";

const edge = (a: number, b: number, npmi = 0.5): Edge => ({
  a, b, support: 4, npmi, confidence: 0.5,
});

describe("pageRank", () => {
  it("ranks a well-connected node above a leaf", () => {
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    const pr = pageRank(edges, [0, 1, 2, 3]);
    expect(pr.get(0)!).toBeGreaterThan(pr.get(1)!);
  });
});

describe("nameCluster", () => {
  it("returns the most central members, most central first", () => {
    const files = ["hub.ts", "leaf1.ts", "leaf2.ts", "leaf3.ts"];
    const edges = [edge(0, 1), edge(0, 2), edge(0, 3)];
    expect(nameCluster([0, 1, 2, 3], edges, files, 2)[0]).toBe("hub.ts");
  });
});

describe("rollUp", () => {
  const files = ["pkg/a/x.ts", "pkg/a/y.ts", "pkg/b/z.ts"];
  const moduleOf = (p: string) => p.split("/").slice(0, 2).join("/");

  it("drops intra-module edges", () => {
    expect(rollUp([edge(0, 1)], files, moduleOf)).toHaveLength(0);
  });

  it("sums weights across collapsed edges", () => {
    const edges = [edge(0, 2, 0.4), edge(1, 2, 0.3)];
    const rolled = rollUp(edges, files, moduleOf);
    expect(rolled).toHaveLength(1);
    expect(rolled[0]?.weight).toBeCloseTo(0.7, 5);
  });

  it("orders endpoints deterministically", () => {
    const rolled = rollUp([edge(2, 0, 0.5)], files, moduleOf);
    expect(rolled[0]?.from).toBe("pkg/a");
    expect(rolled[0]?.to).toBe("pkg/b");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- rollup`
Expected: FAIL — cannot resolve `../src/rollup.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/rollup.ts`:

```ts
import type { Edge } from "./weights.js";

export interface ModuleEdge {
  from: string;
  to: string;
  weight: number;
}

/**
 * PageRank over the undirected projection.
 *
 * Undirected specifically so hub-like nodes (touched by everything) and
 * authority-like nodes (everything touches them) rank comparably instead of one
 * drowning the other. From wikis' `select_central_symbols`.
 */
export function pageRank(
  edges: Edge[],
  nodes: number[],
  damping = 0.85,
  iterations = 40,
): Map<number, number> {
  const adj = new Map<number, Array<[number, number]>>();
  const strength = new Map<number, number>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    const w = Math.max(0, e.npmi);
    if (w === 0) continue;
    adj.get(e.a)?.push([e.b, w]);
    adj.get(e.b)?.push([e.a, w]);
    strength.set(e.a, (strength.get(e.a) ?? 0) + w);
    strength.set(e.b, (strength.get(e.b) ?? 0) + w);
  }

  const n = nodes.length;
  let rank = new Map(nodes.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((x) => [x, (1 - damping) / n]));
    for (const node of nodes) {
      const share = (rank.get(node) ?? 0) * damping;
      const total = strength.get(node) ?? 0;
      if (total === 0) {
        for (const other of nodes) next.set(other, (next.get(other) ?? 0) + share / n);
        continue;
      }
      for (const [nb, w] of adj.get(node) ?? []) {
        next.set(nb, (next.get(nb) ?? 0) + (share * w) / total);
      }
    }
    rank = next;
  }
  return rank;
}

/** Label a community by its most central members. A cluster has no name of its own. */
export function nameCluster(
  members: number[],
  edges: Edge[],
  files: string[],
  k = 5,
): string[] {
  const inside = new Set(members);
  const sub = edges.filter((e) => inside.has(e.a) && inside.has(e.b));
  const pr = pageRank(sub, members);
  return [...members]
    .sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0) || a - b)
    .slice(0, k)
    .map((id) => files[id])
    .filter((p): p is string => p !== undefined);
}

/**
 * Project file-level edges up to modules: remap endpoints to their parent
 * module, drop self-loops (intra-module churn is not a signal), sum weights.
 * The shape of wikis' `architectural_projection`, with symbol->parent replaced
 * by file->module.
 */
export function rollUp(
  edges: Edge[],
  files: string[],
  moduleOf: (path: string) => string,
): ModuleEdge[] {
  const acc = new Map<string, ModuleEdge>();
  for (const e of edges) {
    const pa = files[e.a];
    const pb = files[e.b];
    if (pa === undefined || pb === undefined) continue;
    const ma = moduleOf(pa);
    const mb = moduleOf(pb);
    if (ma === mb) continue;
    const [from, to] = ma < mb ? [ma, mb] : [mb, ma];
    const key = `${from} ${to}`;
    const existing = acc.get(key);
    if (existing) existing.weight += e.npmi;
    else acc.set(key, { from, to, weight: e.npmi });
  }
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || x.from.localeCompare(y.from) || x.to.localeCompare(y.to),
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- rollup`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): module rollup and pagerank cluster naming"
```

---

### Task 9: Declared spine from manifests and directories, with layer ranks

**Files:**
- Create: `packages/graph/src/spine.ts`, `packages/graph/src/layers.ts`
- Test: `packages/graph/test/spine.test.ts`, `packages/graph/test/layers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (reads the filesystem).
- Produces: `declaredSpine(repoRoot: string, files: string[]): Spine` where `Spine { source: "graphify" | "manifests" | "directories"; modules: string[]; moduleOf(path: string): string; imports: ModuleEdge[] }`, and `layerRanks(modules: string[], imports: ModuleEdge[]): Map<string, number> | null`.

- [ ] **Step 1: Write the failing spine test**

`packages/graph/test/spine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredSpine } from "../src/spine.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spine-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("declaredSpine", () => {
  it("prefers workspace manifests over directories", () => {
    const root = repoWith({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/one/package.json": '{"name":"one"}',
      "packages/two/package.json": '{"name":"two"}',
    });
    const spine = declaredSpine(root, ["packages/one/a.ts", "packages/two/b.ts"]);
    expect(spine.source).toBe("manifests");
    expect(spine.moduleOf("packages/one/a.ts")).toBe("packages/one");
  });

  it("falls back to top-level directories with no manifest", () => {
    const root = repoWith({ "README.md": "hi" });
    const spine = declaredSpine(root, ["src/a/x.ts", "docs/b.md"]);
    expect(spine.source).toBe("directories");
    expect(spine.moduleOf("src/a/x.ts")).toBe("src/a");
  });

  it("lists every module it found", () => {
    const root = repoWith({ "README.md": "hi" });
    const spine = declaredSpine(root, ["src/a/x.ts", "src/b/y.ts"]);
    expect(spine.modules.sort()).toEqual(["src/a", "src/b"]);
  });
});
```

- [ ] **Step 2: Write the failing layers test**

`packages/graph/test/layers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { layerRanks } from "../src/layers.js";

describe("layerRanks", () => {
  it("ranks entry points at 0 and their dependencies below", () => {
    const ranks = layerRanks(["app", "lib", "core"], [
      { from: "app", to: "lib", weight: 1 },
      { from: "lib", to: "core", weight: 1 },
    ]);
    expect(ranks?.get("app")).toBe(0);
    expect(ranks?.get("lib")).toBe(1);
    expect(ranks?.get("core")).toBe(2);
  });

  it("contracts a cycle to a single rank rather than looping forever", () => {
    const ranks = layerRanks(["a", "b"], [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "a", weight: 1 },
    ]);
    expect(ranks).not.toBeNull();
    expect(ranks?.get("a")).toBe(ranks?.get("b"));
  });

  it("ranks a module downstream of a cycle strictly deeper than the cycle", () => {
    // a -> b, b <-> c (cycle), c -> d. `d` is not in the cycle and must not
    // be flattened into it — a naive Kahn sweep stalls at the cycle and dumps
    // everything downstream into one rank.
    const ranks = layerRanks(["a", "b", "c", "d"], [
      { from: "a", to: "b", weight: 1 },
      { from: "b", to: "c", weight: 1 },
      { from: "c", to: "b", weight: 1 },
      { from: "c", to: "d", weight: 1 },
    ]);
    expect(ranks?.get("a")).toBe(0);
    expect(ranks?.get("b")).toBe(ranks?.get("c"));
    expect(ranks?.get("d")).toBeGreaterThan(ranks?.get("c") ?? 0);
  });

  it("returns null with no import edges — ranks must not be guessed", () => {
    expect(layerRanks(["a", "b"], [])).toBeNull();
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `pnpm --filter @octoshell/graph test -- spine layers`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the spine**

`packages/graph/src/spine.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleEdge } from "./rollup.js";

export interface Spine {
  source: "graphify" | "manifests" | "directories";
  modules: string[];
  moduleOf(path: string): string;
  /** Directed module dependencies. Empty unless the source supplies them. */
  imports: ModuleEdge[];
}

/** Directories a workspace manifest names, e.g. `packages/*` -> packages/one, packages/two. */
function workspaceRoots(repoRoot: string): string[] {
  const globs: string[] = [];

  const ws = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(ws)) {
    // Deliberately not a YAML parse: we need one list of strings, and the
    // package must stay dependency-free.
    for (const line of readFileSync(ws, "utf8").split("\n")) {
      const m = /^\s*-\s*['"]?([^'"]+)['"]?\s*$/.exec(line);
      if (m?.[1]) globs.push(m[1]);
    }
  }

  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
      const w = (parsed as { workspaces?: unknown }).workspaces;
      const list = Array.isArray(w) ? w : (w as { packages?: unknown })?.packages;
      if (Array.isArray(list)) for (const g of list) if (typeof g === "string") globs.push(g);
    } catch {
      /* a malformed manifest is not fatal — fall through to directories */
    }
  }

  const out: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const base = glob.slice(0, -2);
      const dir = join(repoRoot, base);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (statSync(join(dir, entry)).isDirectory()) out.push(`${base}/${entry}`);
      }
    } else {
      out.push(glob);
    }
  }

  // Single-package repos with their own manifest still count as one module.
  for (const marker of ["go.mod", "Cargo.toml", "pyproject.toml"]) {
    if (out.length === 0 && existsSync(join(repoRoot, marker))) out.push(".");
  }

  return [...new Set(out)].sort();
}

/** Two path segments: `src/host/x.ts` -> `src/host`. */
function twoSegmentModule(path: string): string {
  const parts = path.split("/");
  return parts.length <= 1 ? "." : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

export function declaredSpine(repoRoot: string, files: string[]): Spine {
  const roots = workspaceRoots(repoRoot);

  if (roots.length > 1 || (roots.length === 1 && roots[0] !== ".")) {
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    const moduleOf = (path: string): string =>
      sorted.find((r) => path === r || path.startsWith(`${r}/`)) ?? twoSegmentModule(path);
    const modules = [...new Set(files.map(moduleOf))].sort();
    return { source: "manifests", modules, moduleOf, imports: [] };
  }

  const moduleOf = twoSegmentModule;
  const modules = [...new Set(files.map(moduleOf))].sort();
  return { source: "directories", modules, moduleOf, imports: [] };
}
```

- [ ] **Step 5: Implement layer ranks**

`packages/graph/src/layers.ts`:

```ts
import type { ModuleEdge } from "./rollup.js";

/**
 * Rank modules by dependency depth: 0 = nothing depends on it (entry point).
 *
 * Requires a DIRECTED spine — co-change edges carry no direction, so with no
 * import edges this returns null and `map` omits ranks rather than guessing.
 * Cycles are contracted to one rank and are themselves worth reporting.
 */
export function layerRanks(
  modules: string[],
  imports: ModuleEdge[],
): Map<string, number> | null {
  if (imports.length === 0) return null;

  const out = new Map<string, string[]>(modules.map((m) => [m, []]));
  const inn = new Map<string, string[]>(modules.map((m) => [m, []]));
  for (const e of imports) {
    if (!out.has(e.from) || !inn.has(e.to)) continue;
    out.get(e.from)?.push(e.to);
    inn.get(e.to)?.push(e.from);
  }

  // Contract strongly connected components first (Kosaraju). Without this, a
  // naive Kahn sweep stalls at the first cycle and dumps the cycle AND
  // everything downstream of it into one flat rank — so a module three hops
  // past a cycle would rank identically to the cycle itself.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const to of (out.get(n) ?? []).slice().sort()) visit(to);
    order.push(n);
  };
  for (const m of [...modules].sort()) visit(m);

  const compOf = new Map<string, number>();
  let comps = 0;
  const assign = (n: string, id: number): void => {
    if (compOf.has(n)) return;
    compOf.set(n, id);
    for (const from of (inn.get(n) ?? []).slice().sort()) assign(from, id);
  };
  for (const n of [...order].reverse()) {
    if (!compOf.has(n)) assign(n, comps++);
  }

  // Kahn's algorithm over the condensation, which is a DAG by construction.
  const compIn = new Array<number>(comps).fill(0);
  const compOut: number[][] = Array.from({ length: comps }, () => []);
  const seenEdge = new Set<string>();
  for (const e of imports) {
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}->${b}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    compOut[a]?.push(b);
    compIn[b] = (compIn[b] ?? 0) + 1;
  }

  const compRank = new Array<number>(comps).fill(0);
  let frontier = compIn.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  let depth = 0;
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const c of frontier) {
      compRank[c] = depth;
      for (const to of compOut[c] ?? []) {
        compIn[to] = (compIn[to] ?? 0) - 1;
        if (compIn[to] === 0) next.push(to);
      }
    }
    frontier = [...new Set(next)].sort((a, b) => a - b);
    depth++;
  }

  const rank = new Map<string, number>();
  for (const m of modules) {
    const c = compOf.get(m);
    rank.set(m, c === undefined ? 0 : (compRank[c] ?? 0));
  }
  return rank;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- spine layers`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): declared spine from manifests/directories, layer ranks"
```

---

### Task 10: Graphify adapter

**Files:**
- Create: `packages/graph/src/graphify.ts`
- Modify: `packages/graph/src/spine.ts` (add the graphify tier to the precedence chain)
- Test: `packages/graph/test/graphify.test.ts`

**Interfaces:**
- Consumes: `Spine`, `ModuleEdge`.
- Produces: `readGraphify(repoRoot: string, moduleOf: (p: string) => string): ModuleEdge[] | null`.

**Read surface is deliberately narrow:** file→file import edges only. Graphify's symbols, communities, rationale nodes and confidence tags are ignored. It is a fast-moving project with hundreds of open issues; a narrow surface means a schema change breaks one function, not the tool.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/graphify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGraphify } from "../src/graphify.js";

const moduleOf = (p: string) => p.split("/").slice(0, 2).join("/");

function repoWithGraph(graph: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "gfy-"));
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(join(root, "graphify-out", "graph.json"), JSON.stringify(graph));
  return root;
}

describe("readGraphify", () => {
  it("returns null when graphify has not run", () => {
    expect(readGraphify(mkdtempSync(join(tmpdir(), "none-")), moduleOf)).toBeNull();
  });

  it("extracts module-level import edges and drops self-loops", () => {
    const root = repoWithGraph({
      nodes: [
        { id: "1", file: "pkg/a/x.ts" },
        { id: "2", file: "pkg/b/y.ts" },
        { id: "3", file: "pkg/a/z.ts" },
      ],
      edges: [
        { source: "1", target: "2", type: "imports" },
        { source: "1", target: "3", type: "imports" },
      ],
    });
    const edges = readGraphify(root, moduleOf);
    expect(edges).toEqual([{ from: "pkg/a", to: "pkg/b", weight: 1 }]);
  });

  it("ignores non-import edge types", () => {
    const root = repoWithGraph({
      nodes: [{ id: "1", file: "pkg/a/x.ts" }, { id: "2", file: "pkg/b/y.ts" }],
      edges: [{ source: "1", target: "2", type: "mentions" }],
    });
    expect(readGraphify(root, moduleOf)).toEqual([]);
  });

  it("returns null rather than throwing on malformed json", () => {
    const root = mkdtempSync(join(tmpdir(), "bad-"));
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    writeFileSync(join(root, "graphify-out", "graph.json"), "{not json");
    expect(readGraphify(root, moduleOf)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- graphify`
Expected: FAIL — cannot resolve `../src/graphify.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/graphify.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleEdge } from "./rollup.js";

/** Edge types we treat as a declared dependency. Everything else is ignored. */
const IMPORT_TYPES = new Set(["imports", "import", "calls", "inherits", "extends"]);

interface RawNode { id?: unknown; file?: unknown; path?: unknown; file_path?: unknown }
interface RawEdge { source?: unknown; target?: unknown; type?: unknown; kind?: unknown }

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Read module-level import edges out of a Graphify graph.json, if one exists.
 * Never throws: absent or malformed output degrades the spine, it does not
 * break the tool.
 */
export function readGraphify(
  repoRoot: string,
  moduleOf: (path: string) => string,
): ModuleEdge[] | null {
  const path = join(repoRoot, "graphify-out", "graph.json");
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  const doc = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;

  const fileOf = new Map<string, string>();
  for (const raw of doc.nodes as RawNode[]) {
    const id = str(raw.id);
    const file = str(raw.file) ?? str(raw.path) ?? str(raw.file_path);
    if (id && file) fileOf.set(id, file);
  }

  const acc = new Map<string, ModuleEdge>();
  for (const raw of doc.edges as RawEdge[]) {
    const type = (str(raw.type) ?? str(raw.kind) ?? "").toLowerCase();
    if (!IMPORT_TYPES.has(type)) continue;
    const from = str(raw.source);
    const to = str(raw.target);
    if (!from || !to) continue;
    const fa = fileOf.get(from);
    const fb = fileOf.get(to);
    if (!fa || !fb) continue;

    const ma = moduleOf(fa);
    const mb = moduleOf(fb);
    if (ma === mb) continue;

    const key = `${ma} ${mb}`;
    const existing = acc.get(key);
    if (existing) existing.weight += 1;
    else acc.set(key, { from: ma, to: mb, weight: 1 });
  }

  return [...acc.values()].sort(
    (x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to),
  );
}
```

- [ ] **Step 4: Wire it into the precedence chain**

In `packages/graph/src/spine.ts`, add the import and consult Graphify first. Insert at the top of `declaredSpine`, before `const roots = workspaceRoots(repoRoot)`:

```ts
import { readGraphify } from "./graphify.js";
```

Then restructure the function so **boundaries and edges are chosen independently**. Graphify supplies
precise *import edges*; it says nothing about module boundaries, so it must not downgrade them.
Replace the whole body of `declaredSpine` with:

```ts
export function declaredSpine(repoRoot: string, files: string[]): Spine {
  // 1. Pick the best available module BOUNDARY.
  const roots = workspaceRoots(repoRoot);
  const manifestBased = roots.length > 1 || (roots.length === 1 && roots[0] !== ".");

  let moduleOf: (path: string) => string;
  if (manifestBased) {
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    moduleOf = (path: string): string =>
      sorted.find((r) => path === r || path.startsWith(`${r}/`)) ?? twoSegmentModule(path);
  } else {
    moduleOf = twoSegmentModule;
  }

  // 2. Independently, pick the best available EDGE source. Graphify only wins
  //    on edges — using its presence to also downgrade boundaries to the crude
  //    two-segment heuristic would make the highest-fidelity tier produce the
  //    worst module names in any repo whose packages sit deeper than two
  //    segments (`services/team-a/api-gateway`).
  const imports = readGraphify(repoRoot, moduleOf) ?? [];
  const source: Spine["source"] =
    imports.length > 0 ? "graphify" : manifestBased ? "manifests" : "directories";

  const modules = [...new Set(files.map(moduleOf))].sort();
  return { source, modules, moduleOf, imports };
}
```

- [ ] **Step 5: Add the precedence test to `spine.test.ts`**

```ts
it("takes edges from graphify while keeping manifest boundaries", () => {
  const root = repoWith({
    "pnpm-workspace.yaml": "packages:\n  - 'services/*'\n",
    "services/team-a/package.json": '{"name":"a"}',
    "services/team-b/package.json": '{"name":"b"}',
    "graphify-out/graph.json": JSON.stringify({
      nodes: [
        { id: "1", file: "services/team-a/src/x.ts" },
        { id: "2", file: "services/team-b/src/y.ts" },
      ],
      edges: [{ source: "1", target: "2", type: "imports" }],
    }),
  });
  const spine = declaredSpine(root, [
    "services/team-a/src/x.ts",
    "services/team-b/src/y.ts",
  ]);
  expect(spine.source).toBe("graphify");
  expect(spine.imports.length).toBeGreaterThan(0);
  // Boundaries still come from the manifest, NOT the two-segment fallback:
  // "services/team-a", never "services/team".
  expect(spine.moduleOf("services/team-a/src/x.ts")).toBe("services/team-a");
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- graphify spine`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): graphify adapter as the top declared-spine tier"
```

---

### Task 11: Config file and the `map` renderer

**Files:**
- Create: `packages/graph/src/config.ts`, `packages/graph/src/render.ts`, `packages/graph/src/analyze.ts`
- Test: `packages/graph/test/config.test.ts`, `packages/graph/test/render.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: `loadConfig(repoRoot: string, overrides?: Partial<Config>): Config`; `analyze(repoRoot: string, config: Config, opts: AnalyzeOptions): { analysis: Analysis; edges: Edge[]; files: string[] }` — note it returns the edge list and interned file table alongside the summary, because Tasks 12 and 13 need them; `renderMap(analysis: Analysis, budgetTokens: number): string`; `estimateTokens(text: string): number`.

**Why config exists:** if a local run and a CI run use different `halfLifeDays`/`minSupport`/`maxCommitFiles`, the committed artifact churns on every CI run *regardless* of the stability remap, defeating the lockfile model.

- [ ] **Step 1: Write the failing config test**

`packages/graph/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), "cfg-")))).toEqual(DEFAULTS);
  });

  it("merges octograph.json over the defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), JSON.stringify({ halfLifeDays: 90 }));
    const cfg = loadConfig(root);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.minSupport).toBe(DEFAULTS.minSupport);
  });

  it("lets explicit overrides beat the file", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), JSON.stringify({ halfLifeDays: 90 }));
    expect(loadConfig(root, { halfLifeDays: 30 }).halfLifeDays).toBe(30);
  });

  it("ignores a malformed config rather than crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(root, "octograph.json"), "{oops");
    expect(loadConfig(root)).toEqual(DEFAULTS);
  });
});
```

- [ ] **Step 2: Write the failing render test**

`packages/graph/test/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateTokens, renderMap } from "../src/render.js";
import type { Analysis } from "../src/analyze.js";

const analysis: Analysis = {
  commitCount: 400,
  fileCount: 120,
  spineSource: "manifests",
  modules: [
    { id: 0, name: "packages/board", members: ["packages/board/src/a.ts"], layer: 1 },
    { id: 1, name: "apps/ext", members: ["apps/ext/src/b.ts"], layer: 0 },
  ],
  moduleEdges: [{ from: "apps/ext", to: "packages/board", weight: 3.2 }],
  hubs: ["package.json"],
  bridged: 0,
  clusterIds: { kept: 2, fresh: 0 },
};

describe("renderMap", () => {
  it("lists every module and its layer", () => {
    const md = renderMap(analysis, 2000);
    expect(md).toContain("packages/board");
    expect(md).toContain("apps/ext");
  });

  it("stays within the token budget by dropping least-central modules", () => {
    const big: Analysis = {
      ...analysis,
      modules: Array.from({ length: 500 }, (_, i) => ({
        id: i,
        name: `module/number-${i}`,
        members: [`module/number-${i}/file.ts`],
        layer: 0,
      })),
    };
    expect(estimateTokens(renderMap(big, 500))).toBeLessThanOrEqual(500);
  });

  it("is byte-identical across runs for the same input", () => {
    expect(renderMap(analysis, 2000)).toBe(renderMap(analysis, 2000));
  });

  it("notes when the map was truncated", () => {
    const big: Analysis = {
      ...analysis,
      modules: Array.from({ length: 500 }, (_, i) => ({
        id: i, name: `m/${i}`, members: [`m/${i}/f.ts`], layer: 0,
      })),
    };
    expect(renderMap(big, 300)).toContain("truncated");
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `pnpm --filter @octoshell/graph test -- config render`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement config**

`packages/graph/src/config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  maxCommitFiles: number;
  halfLifeDays: number;
  minSupport: number;
  minCommits: number;
  hubZThreshold: number;
  budgetTokens: number;
  out: string | null;
}

export const DEFAULTS: Config = {
  maxCommitFiles: 50,
  halfLifeDays: 180,
  minSupport: 2,
  minCommits: 200,
  hubZThreshold: 3,
  budgetTokens: 2000,
  out: null,
};

const NUMERIC = [
  "maxCommitFiles", "halfLifeDays", "minSupport",
  "minCommits", "hubZThreshold", "budgetTokens",
] as const;

/** Defaults <- octograph.json <- explicit overrides. */
export function loadConfig(repoRoot: string, overrides: Partial<Config> = {}): Config {
  const cfg: Config = { ...DEFAULTS };
  const path = join(repoRoot, "octograph.json");

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const key of NUMERIC) {
        const v = parsed[key];
        if (typeof v === "number" && Number.isFinite(v)) cfg[key] = v;
      }
      if (typeof parsed.out === "string") cfg.out = parsed.out;
    } catch {
      /* malformed config: fall back to defaults rather than failing the run */
    }
  }

  return { ...cfg, ...overrides };
}
```

- [ ] **Step 5: Implement the analysis pipeline**

`packages/graph/src/analyze.ts`:

```ts
import { harvest } from "./harvest.js";
import { countPairs } from "./cochange.js";
import { weighEdges, type Edge } from "./weights.js";
import { detectHubs } from "./hubs.js";
import { bridgeComponents } from "./components.js";
import { louvain } from "./louvain.js";
import { nameCluster, rollUp, type ModuleEdge } from "./rollup.js";
import { declaredSpine } from "./spine.js";
import { layerRanks } from "./layers.js";
import type { Config } from "./config.js";

export interface ModuleSummary {
  id: number;
  name: string;
  members: string[];
  layer: number | null;
}

export interface Analysis {
  commitCount: number;
  fileCount: number;
  spineSource: "graphify" | "manifests" | "directories";
  modules: ModuleSummary[];
  moduleEdges: ModuleEdge[];
  hubs: string[];
  bridged: number;
  clusterIds: { kept: number; fresh: number };
}

export interface AnalyzeOptions {
  /** Reference time for decay. Passed in for determinism. */
  now: number;
  /** Passed straight through to `git log --since`. */
  since?: string;
}

export function analyze(repoRoot: string, config: Config, opts: AnalyzeOptions): {
  analysis: Analysis;
  edges: Edge[];
  files: string[];
  spine: Spine;
} {
  const commits = harvest(repoRoot, {
    maxCommitFiles: config.maxCommitFiles,
    since: opts.since,
  });
  const table = countPairs(commits, { now: opts.now, halfLifeDays: config.halfLifeDays });
  const edges = weighEdges(table, { minSupport: config.minSupport });

  const hubIds = detectHubs(edges, table.files.length, { zThreshold: config.hubZThreshold });

  // Bridge the edge set that clustering will ACTUALLY see. A hub, by
  // definition, touches much of the graph, so it is often the only thing
  // holding two regions in one component. Bridging before hub removal would
  // see a connected graph, add nothing, and then louvain would strip the hub
  // edges and disconnect those regions anyway — reintroducing the long tail of
  // junk single-file modules that A5e exists to prevent.
  const clusterable = edges.filter((e) => !hubIds.has(e.a) && !hubIds.has(e.b));
  const bridgedEdges = bridgeComponents(clusterable, table.files);
  const synthetic = bridgedEdges.length - clusterable.length;

  const partition = louvain(bridgedEdges, { exclude: hubIds });
  const byCommunity = new Map<number, number[]>();
  for (const [node, comm] of partition) {
    const list = byCommunity.get(comm);
    if (list) list.push(node);
    else byCommunity.set(comm, [node]);
  }

  const spine = declaredSpine(repoRoot, table.files);
  const moduleEdges = spine.imports.length > 0
    ? spine.imports
    : rollUp(edges, table.files, spine.moduleOf);
  const ranks = layerRanks(spine.modules, spine.imports);

  // A4, second half: hubs were excluded from clustering, now reattach them by
  // plurality vote so real files do not silently vanish from the map.
  const homeOf = new Map<number, number>();
  for (const hub of hubIds) {
    const votes = new Map<number, number>();
    for (const e of edges) {
      const other = e.a === hub ? e.b : e.b === hub ? e.a : -1;
      if (other === -1 || hubIds.has(other)) continue;
      const comm = partition.get(other);
      if (comm === undefined) continue;
      votes.set(comm, (votes.get(comm) ?? 0) + Math.max(0, e.npmi));
    }
    let best = -1;
    let bestWeight = -1;
    for (const [comm, w] of [...votes].sort((x, y) => x[0] - y[0])) {
      if (w > bestWeight) {
        best = comm;
        bestWeight = w;
      }
    }
    if (best !== -1) homeOf.set(hub, best);
  }

  const pathsOf = (ids: number[]): string[] =>
    ids
      .map((n) => table.files[n])
      .filter((p): p is string => p !== undefined)
      .sort();

  // Name each community by its most central member, mapped through the spine.
  // Two communities can resolve to the same declared module — which is the
  // EXPECTED case, since declared and discovered structure disagreeing is the
  // whole premise — so merge them rather than emitting duplicate headings.
  const merged = new Map<string, number[]>();
  for (const [comm, members] of [...byCommunity.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0] - b[0],
  )) {
    const primary = nameCluster(members, bridgedEdges, table.files, 1)[0];
    const name = primary === undefined ? `cluster-${comm}` : spine.moduleOf(primary);
    const attached = [...members];
    for (const [hub, home] of homeOf) if (home === comm) attached.push(hub);
    const existing = merged.get(name);
    if (existing) existing.push(...attached);
    else merged.set(name, attached);
  }

  const modules: ModuleSummary[] = [...merged.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, members], i) => ({
      id: i,
      name,
      members: pathsOf(members),
      layer: ranks?.get(name) ?? null,
    }));

  return {
    analysis: {
      commitCount: commits.length,
      fileCount: table.files.length,
      spineSource: spine.source,
      modules,
      moduleEdges,
      hubs: pathsOf([...hubIds]),
      bridged: synthetic,
      clusterIds: { kept: 0, fresh: modules.length },
    },
    edges,
    files: table.files,
    spine,
  };
}
```

Add `import type { Spine } from "./spine.js";` to the imports.

`clusterIds` is a placeholder here — the stability remap runs in **Task 15**'s `cli.ts` `map` handler, against the artifact on disk, and overwrites it. `analyze()` itself is stateless.

- [ ] **Step 6: Implement the renderer**

`packages/graph/src/render.ts`:

```ts
import type { Analysis } from "./analyze.js";

/** chars/4, the same fallback wikis' token_counter uses without tiktoken.
 *  Exact enough: the budget decides how many modules to render, and that
 *  decision is not sensitive to a ±15% estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function renderMap(analysis: Analysis, budgetTokens: number): string {
  const header = [
    "# Module map",
    "",
    `- commits analysed: ${analysis.commitCount}`,
    `- files: ${analysis.fileCount}`,
    `- declared spine: ${analysis.spineSource}`,
    `- hubs quarantined: ${analysis.hubs.length}`,
    "",
    "## Modules",
    "",
  ];

  const lines: string[] = [];
  for (const m of analysis.modules) {
    const layer = m.layer === null ? "" : ` [layer ${m.layer}]`;
    lines.push(`- **${m.name}**${layer} — ${m.members.length} files`);
  }

  const edgeLines = ["", "## Dependencies", ""];
  for (const e of analysis.moduleEdges) {
    edgeLines.push(`- ${e.from} → ${e.to} (${e.weight.toFixed(2)})`);
  }

  // Trim from the tail. Modules are ordered by size (see analyze.ts), so the
  // largest survive truncation; this is not a centrality ranking.
  let kept = lines.length;
  let out = "";
  for (;;) {
    const body = lines.slice(0, kept);
    const truncated = kept < lines.length
      ? ["", `_${lines.length - kept} module(s) truncated to fit the token budget._`]
      : [];
    out = [...header, ...body, ...edgeLines, ...truncated].join("\n") + "\n";
    if (estimateTokens(out) <= budgetTokens || kept === 0) break;
    kept = Math.max(0, kept - Math.max(1, Math.ceil(kept / 8)));
  }
  return out;
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- config render`
Expected: PASS, 8 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): config file, analysis pipeline, and map renderer"
```

---

### Task 12: The `impact` query

**Files:**
- Create: `packages/graph/src/impact.ts`
- Test: `packages/graph/test/impact.test.ts`

**Interfaces:**
- Consumes: `Edge[]`, `files: string[]` (Task 11's `analyze` return).
- Produces: `impact(path: string, edges: Edge[], files: string[], limit?: number): ImpactRow[]` where `ImpactRow { path: string; npmi: number; support: number; confidence: number }`.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/impact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { impact } from "../src/impact.js";
import type { Edge } from "../src/weights.js";

const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
const edges: Edge[] = [
  { a: 0, b: 1, support: 9, npmi: 0.9, confidence: 0.9 },
  { a: 0, b: 2, support: 4, npmi: 0.4, confidence: 0.4 },
  { a: 2, b: 3, support: 8, npmi: 0.8, confidence: 0.8 },
];

describe("impact", () => {
  it("returns coupled files ranked by nPMI", () => {
    const rows = impact("a.ts", edges, files);
    expect(rows.map((r) => r.path)).toEqual(["b.ts", "c.ts"]);
  });

  it("follows edges in either direction", () => {
    expect(impact("d.ts", edges, files).map((r) => r.path)).toEqual(["c.ts"]);
  });

  it("returns an empty list for an unknown path rather than throwing", () => {
    expect(impact("nope.ts", edges, files)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(impact("a.ts", edges, files, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- impact`
Expected: FAIL — cannot resolve `../src/impact.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/impact.ts`:

```ts
import type { Edge } from "./weights.js";

export interface ImpactRow {
  path: string;
  npmi: number;
  support: number;
  confidence: number;
}

/**
 * What else moves when this file changes.
 *
 * Ranked by nPMI, not raw overlap: every file "co-changes" with the lockfile,
 * and raw counts would surface exactly that.
 */
export function impact(
  path: string,
  edges: Edge[],
  files: string[],
  limit = 20,
): ImpactRow[] {
  const id = files.indexOf(path);
  if (id === -1) return [];

  const rows: ImpactRow[] = [];
  for (const e of edges) {
    const other = e.a === id ? e.b : e.b === id ? e.a : -1;
    if (other === -1) continue;
    const p = files[other];
    if (p === undefined) continue;
    rows.push({ path: p, npmi: e.npmi, support: e.support, confidence: e.confidence });
  }

  rows.sort((x, y) => y.npmi - x.npmi || x.path.localeCompare(y.path));
  return rows.slice(0, limit);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- impact`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): impact query ranked by npmi"
```

---

### Task 13: Noise floor and `drift`

**Files:**
- Create: `packages/graph/src/noise.ts`, `packages/graph/src/drift.ts`
- Test: `packages/graph/test/noise.test.ts`, `packages/graph/test/drift.test.ts`

**Interfaces:**
- Consumes: `Edge[]`, `files`, `Spine`.
- Produces: `isTestPath(p: string): boolean`, `classifyPair(a: string, b: string): PairClass` where `PairClass = "test-subject" | "mechanical" | "intra-module" | "candidate"`, and `drift(edges, files, spine, limit?): DriftRow[]`.

**This is the command the whole design exists for.** Empirically, an unfiltered ranking is topped entirely by couplings the user already knows: test↔subject, then manifest↔lockfile, then intra-module siblings. Without the floor, the real finding is buried.

- [ ] **Step 1: Write the failing noise test**

`packages/graph/test/noise.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyPair, isTestPath } from "../src/noise.js";

describe("isTestPath", () => {
  it.each([
    "tests/test_search.py",
    "src/__tests__/a.ts",
    "src/a.test.ts",
    "src/a.spec.tsx",
    "pkg/foo_test.go",
    "backend/conftest.py",
  ])("recognises %s", (p) => expect(isTestPath(p)).toBe(true));

  it.each(["src/api/search.py", "src/latest.ts", "src/contest.ts"])(
    "does not misclassify %s",
    (p) => expect(isTestPath(p)).toBe(false),
  );
});

describe("classifyPair", () => {
  it("classifies a manifest and its lockfile as mechanical", () => {
    expect(classifyPair("package.json", "pnpm-lock.yaml")).toBe("mechanical");
    expect(classifyPair("Cargo.toml", "Cargo.lock")).toBe("mechanical");
  });

  it("classifies a test and any other file as test-subject", () => {
    expect(classifyPair("src/a.ts", "src/a.test.ts")).toBe("test-subject");
  });

  it("classifies everything else as a candidate", () => {
    expect(classifyPair("a/one.ts", "b/two.ts")).toBe("candidate");
  });
});
```

- [ ] **Step 2: Write the failing drift test**

`packages/graph/test/drift.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { drift } from "../src/drift.js";
import type { Edge } from "../src/weights.js";
import type { Spine } from "../src/spine.js";

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "svc/a/client.ts",
  "svc/a/client.test.ts",
  "svc/b/api.ts",
];

const spine: Spine = {
  source: "manifests",
  modules: ["svc/a", "svc/b", "."],
  moduleOf: (p) => (p.includes("/") ? p.split("/").slice(0, 2).join("/") : "."),
  imports: [],
};

const edge = (a: number, b: number, npmi: number): Edge => ({
  a, b, support: 8, npmi, confidence: 0.7,
});

describe("drift", () => {
  const edges = [
    edge(0, 1, 1.0),   // manifest <-> lockfile — mechanical, must not surface
    edge(2, 3, 0.95),  // client <-> its test  — test-subject, must not surface
    edge(2, 4, 0.85),  // client <-> other service's api — THE finding
  ];

  it("surfaces the cross-boundary pair", () => {
    expect(drift(edges, files, spine)[0]?.a).toBe("svc/a/client.ts");
    expect(drift(edges, files, spine)[0]?.b).toBe("svc/b/api.ts");
  });

  it("excludes mechanical and test pairs even at higher nPMI", () => {
    const paths = drift(edges, files, spine).flatMap((r) => [r.a, r.b]);
    expect(paths).not.toContain("pnpm-lock.yaml");
    expect(paths).not.toContain("svc/a/client.test.ts");
  });

  it("excludes pairs the declared spine already relates", () => {
    const withImport: Spine = {
      ...spine,
      imports: [{ from: "svc/a", to: "svc/b", weight: 1 }],
    };
    expect(drift(edges, files, withImport)).toHaveLength(0);
  });

  it("honours the limit", () => {
    expect(drift(edges, files, spine, 0)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `pnpm --filter @octoshell/graph test -- noise drift`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the noise floor**

`packages/graph/src/noise.ts`:

```ts
/** Independently-compiled path heuristics. Deterministic, language-agnostic, no parsing. */
const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?|e2e|fixtures)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /(^|\/)test_[^/]+$/i,
  /(^|\/)[^/]+_test\.[a-z0-9]+$/i,
  /(^|\/)conftest\.py$/i,
];

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}

/** Manifest -> lockfile pairs whose coupling is mechanical and already known. */
const LOCK_PAIRS: Array<[RegExp, RegExp]> = [
  [/(^|\/)package\.json$/, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/],
  [/(^|\/)Cargo\.toml$/, /(^|\/)Cargo\.lock$/],
  [/(^|\/)pyproject\.toml$/, /(^|\/)(uv\.lock|poetry\.lock)$/],
  [/(^|\/)go\.mod$/, /(^|\/)go\.sum$/],
  [/(^|\/)Gemfile$/, /(^|\/)Gemfile\.lock$/],
];

export type PairClass = "test-subject" | "mechanical" | "intra-module" | "candidate";

/**
 * Grade a pair against the noise floor.
 *
 * Order matters: mechanical is checked before test, so a lockfile inside a test
 * fixture directory is still reported as mechanical.
 */
export function classifyPair(a: string, b: string): PairClass {
  for (const [left, right] of LOCK_PAIRS) {
    if ((left.test(a) && right.test(b)) || (left.test(b) && right.test(a))) {
      return "mechanical";
    }
  }
  if (isTestPath(a) || isTestPath(b)) return "test-subject";
  return "candidate";
}
```

- [ ] **Step 5: Implement drift**

`packages/graph/src/drift.ts`:

```ts
import { classifyPair } from "./noise.js";
import type { Spine } from "./spine.js";
import type { Edge } from "./weights.js";

export interface DriftRow {
  a: string;
  b: string;
  moduleA: string;
  moduleB: string;
  npmi: number;
  support: number;
  confidence: number;
}

/**
 * Coupling the declared structure does not explain.
 *
 * A run whose top result is a manifest and its lockfile has failed, however
 * high the nPMI — hence the noise floor. With a Graphify spine, "nothing
 * imports across them" is a real claim; with only manifests it weakens to
 * "different declared modules", so precision degrades but availability does not.
 */
export function drift(
  edges: Edge[],
  files: string[],
  spine: Spine,
  limit = 20,
): DriftRow[] {
  const declared = new Set<string>();
  for (const e of spine.imports) {
    declared.add(`${e.from} ${e.to}`);
    declared.add(`${e.to} ${e.from}`);
  }

  const rows: DriftRow[] = [];
  for (const e of edges) {
    if (e.support === 0) continue; // synthetic bridge, not evidence
    const pa = files[e.a];
    const pb = files[e.b];
    if (pa === undefined || pb === undefined) continue;
    if (classifyPair(pa, pb) !== "candidate") continue;

    const ma = spine.moduleOf(pa);
    const mb = spine.moduleOf(pb);
    if (ma === mb) continue;                                  // intra-module
    if (declared.has(`${ma} ${mb}`)) continue;           // already declared

    rows.push({
      a: pa, b: pb, moduleA: ma, moduleB: mb,
      npmi: e.npmi, support: e.support, confidence: e.confidence,
    });
  }

  rows.sort((x, y) => y.npmi - x.npmi || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return rows.slice(0, limit);
}
```

- [ ] **Step 6: Exclude tests from clustering (A8: tag, never drop)**

Tests co-change with their subject constantly. Left in the partition they form test-shaped
communities and drag module boundaries toward the test tree. But they must stay in the graph —
test↔subject is the single most useful edge for "which tests must run for this change".

So they are excluded from **clustering only**, exactly like hubs.

In `packages/graph/src/analyze.ts`, add the import:

```ts
import { isTestPath } from "./noise.js";
```

and replace the partition line:

```ts
  const partition = louvain(bridgedEdges, { exclude: hubIds });
```

with:

```ts
  // A8: tests stay in `edges` (so `impact` still reports them) but are kept out
  // of clustering, where they would otherwise form test-shaped modules.
  const excluded = new Set(hubIds);
  table.files.forEach((path, i) => {
    if (isTestPath(path)) excluded.add(i);
  });
  const partition = louvain(bridgedEdges, { exclude: excluded });
```

- [ ] **Step 7: Add the clustering-exclusion test**

Append to `packages/graph/test/drift.test.ts`:

```ts
import { analyze } from "../src/analyze.js";
import { DEFAULTS } from "../src/config.js";
import { buildRepo } from "./fixtures/repo.js";

describe("test files in the pipeline", () => {
  it("keeps tests as edges but out of module membership", () => {
    const repo = buildRepo(
      Array.from({ length: 8 }, (_, i) => ({
        files: [`src/mod/f${i}.ts`, `src/mod/__tests__/f${i}.test.ts`],
      })),
    );
    const { analysis, files } = analyze(repo, DEFAULTS, { now: Date.UTC(2026, 0, 2) });

    // still present in the graph
    expect(files.some((f) => f.includes(".test."))).toBe(true);
    // but never a member of a module
    const members = analysis.modules.flatMap((m) => m.members);
    expect(members.some((f) => f.includes(".test."))).toBe(false);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- noise drift`
Expected: PASS, 17 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): noise floor, drift detection, tests out of clustering"
```

---

### Task 14: `doctor` with three exit states

**Files:**
- Create: `packages/graph/src/doctor.ts`
- Test: `packages/graph/test/doctor.test.ts`

**Interfaces:**
- Consumes: `Config`.
- Produces: `doctor(repoRoot: string, config: Config): Report` where `Report { status: "ok" | "degraded" | "blocked"; checks: Check[] }`, `Check { name: string; state: "ok" | "warn" | "missing"; detail: string; fix?: string; required: boolean }`, and `exitCode(report: Report): number`. `required` is what separates a degraded run from a merely warned one — only required inputs can force `degraded`.

**Why three states:** "required missing" and "optional missing" do not cover git history that is *present but too thin to trust*. Leaving that undefined would let two engineers ship opposite exit codes while CI gating depends on the distinction.

- [ ] **Step 1: Write the failing test**

`packages/graph/test/doctor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { doctor, exitCode } from "../src/doctor.js";
import { buildRepo } from "./fixtures/repo.js";

describe("doctor", () => {
  it("reports blocked and exits non-zero outside a git repo", () => {
    const report = doctor(mkdtempSync(join(tmpdir(), "nogit-")), DEFAULTS);
    expect(report.status).toBe("blocked");
    expect(exitCode(report)).not.toBe(0);
  });

  it("reports degraded when history is below minCommits", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }, { files: ["c.ts", "d.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    expect(report.status).toBe("degraded");
    expect(exitCode(report)).not.toBe(0);
  });

  it("names the cause and a fix for every non-ok check", () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    const report = doctor(repo, { ...DEFAULTS, minCommits: 200 });
    const history = report.checks.find((c) => c.name === "history depth");
    expect(history?.state).toBe("warn");
    expect(history?.detail).toContain("commits");
  });

  it("reports ok and exits 0 when history clears the bar", () => {
    const repo = buildRepo(
      Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })),
    );
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    expect(report.status).toBe("ok");
    expect(exitCode(report)).toBe(0);
  });

  it("treats a missing graphify as a warning, never as degraded", () => {
    const repo = buildRepo(
      Array.from({ length: 12 }, (_, i) => ({ files: [`a${i}.ts`, `b${i}.ts`] })),
    );
    const report = doctor(repo, { ...DEFAULTS, minCommits: 10 });
    expect(report.checks.find((c) => c.name === "graphify")?.state).toBe("missing");
    expect(report.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- doctor`
Expected: FAIL — cannot resolve `../src/doctor.js`.

- [ ] **Step 3: Implement**

`packages/graph/src/doctor.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { harvest } from "./harvest.js";
import type { Config } from "./config.js";

export type CheckState = "ok" | "warn" | "missing";
export type Status = "ok" | "degraded" | "blocked";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  fix?: string;
  /** Required inputs can force `degraded`; optional ones never do. */
  required: boolean;
}

export interface Report {
  status: Status;
  checks: Check[];
}

export function doctor(repoRoot: string, config: Config): Report {
  const checks: Check[] = [];

  if (!existsSync(join(repoRoot, ".git"))) {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "not a git repository — history is the only required input",
      fix: "run inside a git repository",
      required: true,
    });
    return { status: "blocked", checks };
  }
  checks.push({ name: "repository", state: "ok", detail: repoRoot, required: true });

  let analysable = 0;
  try {
    analysable = harvest(repoRoot, { maxCommitFiles: config.maxCommitFiles }).length;
  } catch {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "git log failed — no commits?",
      fix: "make at least one commit",
      required: true,
    });
    return { status: "blocked", checks };
  }

  const thin = analysable < config.minCommits;
  checks.push({
    name: "history depth",
    state: thin ? "warn" : "ok",
    detail: thin
      ? `${analysable} analysable commits — co-change needs ~${config.minCommits} to be meaningful (shallow clone, or a squashed migration?)`
      : `${analysable} analysable commits`,
    fix: thin ? "unshallow the clone, or accept sparse output" : undefined,
    required: true,
  });

  const hasGraphify = existsSync(join(repoRoot, "graphify-out", "graph.json"));
  checks.push({
    name: "graphify",
    state: hasGraphify ? "ok" : "missing",
    detail: hasGraphify
      ? "graph.json found — precise import edges available"
      : 'not installed — drift can say "different modules" but not "nothing imports across them"',
    fix: hasGraphify ? undefined : "uv tool install graphifyy",
    required: false,
  });

  const hasBoard = existsSync(join(repoRoot, ".octobots"));
  checks.push({
    name: "board",
    state: hasBoard ? "ok" : "missing",
    detail: hasBoard ? ".octobots/ found" : "no board — own/conflicts unavailable",
    required: false,
  });

  const degraded = checks.some((c) => c.required && c.state !== "ok");
  return { status: degraded ? "degraded" : "ok", checks };
}

/** `ok` -> 0; `degraded` and `blocked` -> non-zero, so CI can gate on it. */
export function exitCode(report: Report): number {
  return report.status === "ok" ? 0 : 1;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @octoshell/graph test -- doctor`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/graph
git commit -m "feat(graph): doctor with ok/degraded/blocked exit states"
```

---

### Task 15: CLI, artifact round-trip, and the pack bundle

**Files:**
- Create: `packages/graph/src/cli.ts`, `packages/graph/src/artifact.ts`, `packages/graph/scripts/bundle.mjs`
- Modify: `packages/graph/package.json` (add `bin` and `bundle` script), `packages/graph/src/index.ts`
- Test: `packages/graph/test/artifact.test.ts`, `packages/graph/test/cli.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `readArtifact(dir: string): StoredGraph | null`, `writeArtifact(dir: string, graph: StoredGraph): void`, `resolveOut(repoRoot: string, config: Config): string`, and a `main(argv: string[]): Promise<number>` CLI entry.

**The bundle matters:** `tokenomics` keeps an 838-line `.mjs` and a 309-line `.ts` that share no code and drift apart, the same hazard as `entity-schema.ts`/`entity-io.mjs`. One source bundled by esbuild avoids a third instance.

- [ ] **Step 1: Write the failing artifact test**

`packages/graph/test/artifact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.js";
import { readArtifact, resolveOut, writeArtifact } from "../src/artifact.js";

describe("resolveOut", () => {
  it("uses .octobots/graph when a board exists", () => {
    const root = mkdtempSync(join(tmpdir(), "art-"));
    mkdirSync(join(root, ".octobots"));
    expect(resolveOut(root, DEFAULTS)).toBe(join(root, ".octobots", "graph"));
  });

  it("falls back to .octograph with no board and never creates .octobots", () => {
    const root = mkdtempSync(join(tmpdir(), "art-"));
    expect(resolveOut(root, DEFAULTS)).toBe(join(root, ".octograph"));
  });

  it("honours an explicit out setting", () => {
    const root = mkdtempSync(join(tmpdir(), "art-"));
    expect(resolveOut(root, { ...DEFAULTS, out: "custom" })).toBe(join(root, "custom"));
  });
});

describe("artifact round-trip", () => {
  it("returns null before anything is written", () => {
    expect(readArtifact(mkdtempSync(join(tmpdir(), "art-")))).toBeNull();
  });

  it("round-trips clusters so stability can read the previous run", () => {
    const dir = mkdtempSync(join(tmpdir(), "art-"));
    writeArtifact(dir, { version: 1, clusters: { 3: ["a.ts"], 7: ["b.ts"] }, config: DEFAULTS });
    expect(readArtifact(dir)?.clusters[7]).toEqual(["b.ts"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @octoshell/graph test -- artifact`
Expected: FAIL — cannot resolve `../src/artifact.js`.

- [ ] **Step 3: Implement the artifact store**

`packages/graph/src/artifact.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface StoredGraph {
  version: 1;
  /** cluster id -> member paths. Read back so the Jaccard remap can pin ids. */
  clusters: Record<number, string[]>;
  /** The config that produced this artifact, so drift in settings is visible. */
  config: Config;
}

/**
 * `.octobots/graph/` when a board exists, else `.octograph/`.
 * Never creates `.octobots/` in a repo that has no board.
 */
export function resolveOut(repoRoot: string, config: Config): string {
  if (config.out) return join(repoRoot, config.out);
  if (existsSync(join(repoRoot, ".octobots"))) return join(repoRoot, ".octobots", "graph");
  return join(repoRoot, ".octograph");
}

export function readArtifact(dir: string): StoredGraph | null {
  const path = join(dir, "graph.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredGraph;
  } catch {
    return null;
  }
}

export function writeArtifact(dir: string, graph: StoredGraph): void {
  mkdirSync(dir, { recursive: true });
  // Stable key order keeps the committed diff meaningful.
  const ordered: Record<number, string[]> = {};
  for (const key of Object.keys(graph.clusters).map(Number).sort((a, b) => a - b)) {
    ordered[key] = [...(graph.clusters[key] ?? [])].sort();
  }
  writeFileSync(
    join(dir, "graph.json"),
    JSON.stringify({ ...graph, clusters: ordered }, null, 2) + "\n",
  );
}
```

- [ ] **Step 4: Implement the CLI**

`packages/graph/src/cli.ts`:

```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./analyze.js";
import { readArtifact, resolveOut, writeArtifact } from "./artifact.js";
import { loadConfig, type Config } from "./config.js";
import { doctor, exitCode } from "./doctor.js";
import { drift } from "./drift.js";
import { impact } from "./impact.js";
import { renderMap } from "./render.js";
import { remapClusters } from "./stability.js";

/**
 * Flag names are declared explicitly, NOT derived from field names. Deriving
 * them produced `--half-life-days` while the spec documents `--half-life`, and
 * an unrecognised flag is silently ignored — so a CI script following the spec
 * would quietly run with different settings and churn the artifact on every
 * run, which is exactly what the committed config exists to prevent.
 */
const FLAGS: Array<[flag: string, key: keyof Config]> = [
  ["--max-commit-files", "maxCommitFiles"],
  ["--half-life", "halfLifeDays"],
  ["--min-support", "minSupport"],
  ["--min-commits", "minCommits"],
  ["--budget", "budgetTokens"],
];

const KNOWN = new Set([...FLAGS.map(([f]) => f), "--out", "--since", "--json"]);

function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/** Reject unknown `--flags` loudly rather than ignoring them. */
export function unknownFlags(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith("--") && !KNOWN.has(a));
}

export function overridesFrom(argv: string[]): Partial<Config> {
  const out: Partial<Config> = {};
  for (const [flag, key] of FLAGS) {
    const raw = valueAfter(argv, flag);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  }
  const dir = valueAfter(argv, "--out");
  if (dir !== undefined) out.out = dir;
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "map";
  const repoRoot = process.cwd();
  const json = argv.includes("--json");

  const bad = unknownFlags(argv);
  if (bad.length > 0) {
    process.stderr.write(`unknown flag(s): ${bad.join(", ")}\n`);
    return 2;
  }

  const config = loadConfig(repoRoot, overridesFrom(argv));
  const since = valueAfter(argv, "--since");

  if (command === "doctor") {
    const report = doctor(repoRoot, config);
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(`status: ${report.status}\n\n`);
      for (const c of report.checks) {
        const mark = c.state === "ok" ? "OK  " : c.state === "warn" ? "WARN" : "MISS";
        process.stdout.write(`  ${mark}  ${c.name}: ${c.detail}\n`);
        if (c.fix) process.stdout.write(`        -> ${c.fix}\n`);
      }
    }
    return exitCode(report);
  }

  const now = Number(process.env.OCTOGRAPH_NOW ?? Date.now());
  const { analysis, edges, files, spine } = analyze(repoRoot, config, { now, since });

  if (command === "impact") {
    const target = argv.find((a) => !a.startsWith("--") && a !== "impact");
    if (!target) {
      process.stderr.write("usage: octograph impact <path>\n");
      return 2;
    }
    const rows = impact(target, edges, files);
    process.stdout.write(
      json ? JSON.stringify(rows, null, 2) + "\n"
           : rows.map((r) => `${r.npmi.toFixed(3)}  ${r.path}`).join("\n") + "\n",
    );
    return 0;
  }

  if (command === "drift") {
    // Uses the spine `analyze` already computed — one filesystem walk, and one
    // Spine, so a future fix to declaredSpine cannot reach only half the calls.
    const rows = drift(edges, files, spine);
    process.stdout.write(
      json ? JSON.stringify(rows, null, 2) + "\n"
           : rows.map((r) => `${r.npmi.toFixed(3)}  ${r.a}  <->  ${r.b}`).join("\n") + "\n",
    );
    return 0;
  }

  if (command === "map") {
    const outDir = resolveOut(repoRoot, config);

    // Pin cluster ids against the previously committed artifact. Without this
    // the map churns on every run and the committed-artifact model collapses.
    const previous = readArtifact(outDir);
    const fresh = new Map<number, string[]>(analysis.modules.map((m) => [m.id, m.members]));
    let kept = 0;
    if (previous) {
      const old = new Map<number, string[]>(
        Object.entries(previous.clusters).map(([k, v]) => [Number(k), v]),
      );
      const remap = remapClusters(old, fresh);
      const oldIds = new Set(old.keys());
      analysis.modules = analysis.modules.map((m) => {
        const stable = remap.get(m.id) ?? m.id;
        if (oldIds.has(stable)) kept++;
        return { ...m, id: stable };
      });
      analysis.clusterIds = { kept, fresh: analysis.modules.length - kept };
    }

    writeArtifact(outDir, {
      version: 1,
      clusters: Object.fromEntries(analysis.modules.map((m) => [m.id, m.members])),
      config,
    });
    writeFileSync(join(outDir, "map.md"), renderMap(analysis, config.budgetTokens));

    process.stdout.write(
      `built ${analysis.modules.length} modules from ${analysis.commitCount} commits / ${analysis.fileCount} files\n` +
        `spine: ${analysis.spineSource}   hubs quarantined: ${analysis.hubs.length}   ` +
        `bridged: ${analysis.bridged}   cluster IDs: ${analysis.clusterIds.kept} kept, ${analysis.clusterIds.fresh} new\n`,
    );
    return 0;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  return 2;
}
```

- [ ] **Step 5: Write the CLI smoke test**

`packages/graph/test/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { appendCommits, buildRepo } from "./fixtures/repo.js";

async function inRepo(repo: string, argv: string[]): Promise<number> {
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    return await main(argv);
  } finally {
    process.chdir(cwd);
  }
}

describe("cli map", () => {
  it("writes map.md and graph.json, and is stable across two runs", async () => {
    const repo = buildRepo(
      Array.from({ length: 10 }, (_, i) => ({ files: [`src/a/f${i}.ts`, `src/b/g${i}.ts`] })),
    );
    process.env.OCTOGRAPH_NOW = String(Date.UTC(2026, 0, 2));

    expect(await inRepo(repo, ["map"])).toBe(0);
    const out = join(repo, ".octograph");
    expect(existsSync(join(out, "map.md"))).toBe(true);
    const first = readFileSync(join(out, "map.md"), "utf8");

    expect(await inRepo(repo, ["map"])).toBe(0);
    expect(readFileSync(join(out, "map.md"), "utf8")).toBe(first);
  });

  it("exits non-zero from doctor on a thin repo", async () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    expect(await inRepo(repo, ["doctor"])).not.toBe(0);
  });

  it("rejects an unknown flag instead of silently ignoring it", async () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    expect(await inRepo(repo, ["map", "--half-life-days", "90"])).toBe(2);
  });

  it("applies documented numeric flags", async () => {
    const repo = buildRepo([{ files: ["a.ts", "b.ts"] }]);
    // --min-commits 1 clears the degraded bar that this thin repo would fail.
    expect(await inRepo(repo, ["doctor", "--min-commits", "1"])).toBe(0);
  });
});

/**
 * THE test the spec calls the product's single point of failure.
 *
 * "map.md regenerates byte-identically from an unchanged commit" is far weaker
 * than it sounds — any pure function satisfies it. The real risk is arbitrary
 * Louvain relabelling on a graph that CHANGED, which would rewrite the whole
 * artifact and destroy the "architecture drift shows up in code review" premise.
 * So this evolves the repo and asserts the diff stays local.
 */
describe("cluster-id stability across an evolving repo (A5b)", () => {
  it("keeps ids for untouched modules and confines the diff to what changed", async () => {
    process.env.OCTOGRAPH_NOW = String(Date.UTC(2026, 0, 2));

    const commits = [];
    for (let i = 0; i < 8; i++) commits.push({ files: [`alpha/a${i}.ts`, `alpha/b${i}.ts`] });
    for (let i = 0; i < 8; i++) commits.push({ files: [`beta/c${i}.ts`, `beta/d${i}.ts`] });
    const repo = buildRepo(commits);

    expect(await inRepo(repo, ["map"])).toBe(0);
    const out = join(repo, ".octograph");
    const firstMap = readFileSync(join(out, "map.md"), "utf8");
    const firstIds = JSON.parse(readFileSync(join(out, "graph.json"), "utf8")) as {
      clusters: Record<string, string[]>;
    };

    // Grow ONLY beta. alpha is untouched and must keep its identity.
    appendCommits(repo, [
      { files: ["beta/e1.ts", "beta/e2.ts"] },
      { files: ["beta/e2.ts", "beta/e3.ts"] },
    ]);

    expect(await inRepo(repo, ["map"])).toBe(0);
    const secondIds = JSON.parse(readFileSync(join(out, "graph.json"), "utf8")) as {
      clusters: Record<string, string[]>;
    };

    const idOfAlpha = (doc: { clusters: Record<string, string[]> }) =>
      Object.entries(doc.clusters).find(([, members]) =>
        members.some((m) => m.startsWith("alpha/")),
      )?.[0];

    expect(idOfAlpha(secondIds)).toBe(idOfAlpha(firstIds));

    // The rendered diff must be confined to the module that actually changed.
    const secondMap = readFileSync(join(out, "map.md"), "utf8");
    const changed = diffLines(firstMap, secondMap);
    expect(changed.length).toBeGreaterThan(0); // something DID change
    expect(changed.every((l) => !l.includes("alpha"))).toBe(true);
  });
});

/** Lines present in one rendering but not the other, either direction. */
function diffLines(a: string, b: string): string[] {
  const bl = new Set(b.split("\n"));
  const al = new Set(a.split("\n"));
  return [
    ...a.split("\n").filter((l) => l.trim() && !bl.has(l)),
    ...b.split("\n").filter((l) => l.trim() && !al.has(l)),
  ];
}
```

- [ ] **Step 5b: Define the package's public surface**

`CLAUDE.md`: *"Packages export their public API through `src/index.ts`."* Replace
`packages/graph/src/index.ts` with the full surface — a consumer, and the later board-overlay plan,
need all of it:

```ts
export { analyze, type Analysis, type AnalyzeOptions, type ModuleSummary } from "./analyze.js";
export { readArtifact, resolveOut, writeArtifact, type StoredGraph } from "./artifact.js";
export { countPairs, type DecayOptions, type PairStat, type PairTable } from "./cochange.js";
export { bridgeComponents, findComponents } from "./components.js";
export { DEFAULTS, loadConfig, type Config } from "./config.js";
export { doctor, exitCode, type Check, type Report, type Status } from "./doctor.js";
export { drift, type DriftRow } from "./drift.js";
export { readGraphify } from "./graphify.js";
export { harvest, type HarvestOptions } from "./harvest.js";
export { detectHubs, type HubOptions } from "./hubs.js";
export { impact, type ImpactRow } from "./impact.js";
export { layerRanks } from "./layers.js";
export { autoResolution, louvain, type LouvainOptions } from "./louvain.js";
export { classifyPair, isTestPath, type PairClass } from "./noise.js";
export { estimateTokens, renderMap } from "./render.js";
export { nameCluster, pageRank, rollUp, type ModuleEdge } from "./rollup.js";
export { declaredSpine, type Spine } from "./spine.js";
export { jaccard, remapClusters, type RemapOptions } from "./stability.js";
export type { Commit } from "./types.js";
export { weighEdges, type Edge, type WeightOptions } from "./weights.js";
```

- [ ] **Step 6: Add the bin entry and the bundler**

Add to `packages/graph/package.json`:

```json
  "bin": { "octograph": "dist/bin.js" },
```

and to its `scripts`:

```json
    "bundle": "node scripts/bundle.mjs",
```

Create `packages/graph/src/bin.ts`:

```ts
#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
```

Create `packages/graph/scripts/bundle.mjs`:

```js
// Bundle packages/graph into ONE self-contained .mjs for the Octobots pack.
// This is why the pack payload is never hand-written: tokenomics keeps an
// 838-line .mjs beside a 309-line .ts that share no code and drift apart.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(
  here,
  "../../../apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs",
);

await build({
  entryPoints: [join(here, "../src/bin.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});

console.log(`bundled -> ${out}`);
```

Add `esbuild` to `packages/graph`'s `devDependencies` (`"esbuild": "^0.23.0"`), then `pnpm install`.

- [ ] **Step 7: Run everything**

```bash
pnpm --filter @octoshell/graph test
pnpm --filter @octoshell/graph typecheck
pnpm --filter @octoshell/graph lint
pnpm --filter @octoshell/graph build
pnpm --filter @octoshell/graph bundle
```

Expected: all tests pass; `dist/` and `resources/octobots-pack/graph/octograph.mjs` both exist.

- [ ] **Step 8: Verify against this repo by hand**

```bash
node apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs doctor
```

Expected: `status: degraded`, naming both thin history and missing graphify with fixes, exit non-zero. This is success criterion 9 and 10.

- [ ] **Step 9: Commit**

```bash
git add packages/graph apps/vscode-extension/resources/octobots-pack/graph pnpm-lock.yaml
git commit -m "feat(graph): cli, committed artifact round-trip, and pack bundle"
```

---

## Deferred to later plans

- **Board overlay** — `own` and `conflicts`, the worklog/branch join, and lexical cold-start prediction. Blocked on nothing here; it is a separate data source.
- **`setup`** — the interactive installer. The only component that mutates the user's machine, so it gets its own review.
- **Extension bridge** — `src/host/octograph.ts`, the two VS Code commands, and the `primer.mjs` injection. Different package, different reviewers.

## Tech-lead review — resolutions

Reviewed by Rio, 2026-08-09. Two blocking and eight should-fix findings, all applied above.

| # | Finding | Resolution |
|---|---|---|
| B1 | The A5b stability test the spec calls "the product's single point of failure" was never written. The existing "stable across two runs" test re-ran on an *unchanged* repo — a property any pure function satisfies. | Task 15 now has an integration test that evolves the repo and asserts untouched modules keep their ids and the `map.md` diff stays confined to the changed module. |
| B2 | Hub reattachment (A4's second half) was never implemented, so hub files vanished from every module. | `analyze()` now reattaches each hub by weighted plurality vote after clustering. |
| S1 | `bridgeComponents` ran on the pre-hub-removal edge set, so it saw a connected graph, added nothing, and Louvain then disconnected regions whose only link was through a hub. | Bridging now runs on the edge set clustering actually sees. |
| S2 | `overridesFrom` derived `--half-life-days` from the field name while the spec documents `--half-life`; unknown flags were silently ignored, and `--since`/`--out` were unwired. | Flag names are now declared explicitly, unknown flags exit 2, and both missing flags are wired. |
| S3 | `layerRanks` flattened a cycle **and everything downstream of it** into one rank. *Verified empirically:* `a→b, b↔c, c→d` gave `d` rank 1, identical to the cycle. | Rewritten with Kosaraju SCC contraction. Re-verified: `a=0, b=c=1, d=2`. |
| S4 | Two communities resolving to the same declared module produced duplicate headings — the *expected* case, since declared ≠ discovered is the premise. | Communities resolving to one name are merged. |
| S5 | The Graphify tier discarded manifest boundaries, so the highest-fidelity input produced the crudest module names. | Boundaries and edges are now chosen independently; Graphify supplies only edges. |
| S6 | `index.ts`'s public surface was unspecified despite the project convention. | Enumerated in Task 15, Step 5b. |
| S7 | Task 13 claimed 15 tests; there are 17. | Corrected. |
| S8 | A comment attributed the cluster-id remap to Task 12 (the `impact` query) instead of Task 15. | Corrected. |

**Open question — decided.** `analyze()` now returns `spine`, and `cli.ts`'s `drift` branch consumes
it instead of calling `declaredSpine` a second time. Rio's reasoning: it is a cheap additive change
now and expensive to retrofit, it removes a duplicate filesystem walk that got more expensive once
the Graphify read landed, and — the real point — one `Spine` computed once means a future fix to
`declaredSpine` cannot reach only half the call sites. The dead `AnalyzeOptions.previousClusters`
field is dropped as part of the same change; stability lives in `cli.ts` against the on-disk
artifact.

**Verified by Rio, do not change:** the nPMI formula and its `denom === 0` guard; `remapClusters`'
uniqueness guarantee; `louvain`'s modularity-gain formula and its order-independent tie-break (all
three hand-traced). Also confirmed: `vitest.workspace.ts`, `turbo.json` and `eslint.config.js` are
glob-based over `packages/*`, so **no root config changes are needed** for this package.

## Follow-ups (deliberately not in this plan)

- **`louvain()` is single-level** — the aggregation/coarsening phase of canonical Louvain is not
  implemented. It converges correctly on the test cases and is a legitimate v1 simplification, but
  it is more prone to local optima on large hierarchical graphs than a multi-level implementation.
  Noted so nobody assumes parity with the `wikis` reference or networkx.
- **`pnpm coverage`** at the root is hardcoded to `coverage:board` + `coverage:pack` and will not
  pick up `packages/graph`. CI runs only lint/build/typecheck/test today, so this gates nothing —
  but it should be extended if coverage enforcement is wanted here.
- **`remapClusters` is greedy, not globally optimal.** A bipartite matching (Hungarian) could
  occasionally find a better overall assignment. Named trade-off, not an oversight.
