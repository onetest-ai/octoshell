# octograph diff-impact and vault evidence tier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give octograph a diff-scoped `impact` command and make `.agents/knowledge/` a first-class, graded evidence tier that `impact`, `map` and `drift` all cite.

**Architecture:** Two new pure modules in `packages/graph/src` — `vault.ts` (read `.agents/knowledge/**/*.md`, match notes to paths in two never-blended modes) and `diff-impact.ts` (git range → changed set → union of existing `impact()` rows, deduped, partitioned into source/tests). Then three edits: `cli.ts` gains `impact --diff`, `doctor.ts` grades the vault as a fifth input, and `render.ts`/`drift.ts` cite notes. Nothing writes to the vault.

**Tech Stack:** TypeScript (ESM, `NodeNext`, `strict`, `noUncheckedIndexedAccess`), vitest, `js-yaml@5.2.2` (already a dependency of `packages/graph`), `node:child_process` for git (as `harvest.ts` already does).

**Spec:** `docs/superpowers/specs/2026-08-13-octograph-diff-impact-and-vault-tier-design.md`

## Global Constraints

- **Relative imports MUST carry the `.js` extension** even though source is `.ts` (`import { x } from "./foo.js"`). `module: "NodeNext"`.
- **`noUncheckedIndexedAccess` is on.** Every `array[i]` is `T | undefined` and must be narrowed before use.
- **No new runtime dependency.** The package bundles to a ~202 KB self-contained file that runs under bare `node`: no LLM, no network, no embeddings, no install step.
- **Nothing in this package parses source code.** "Identifiers" means path segments. `vault.ts` parses markdown frontmatter and prose — it must not become a route to parsing `.ts` files.
- **New public API must be re-exported from `src/index.ts`** or it does not exist outside the package (`index.ts` says so at the top).
- **Optional inputs never throw.** Absent, unreadable, or malformed input degrades the answer; it does not raise. `readGraphify` in `src/graphify.ts` is the reference implementation of this contract.
- **Every answer states how it knows.** Two evidence modes are never blended into one score or one label. `own`'s `provenance` / `predicted` is the precedent.
- **`js-yaml@5.2.2` throws on an empty, whitespace-only, or comment-only document** — it does not return `undefined`. Verified 2026-08-09, recorded in `.agents/knowledge/practices/js-yaml-empty-doc-and-bool-parsing.md`. Every `load()` call in this plan is wrapped in `try`/`catch`.
- **Per-package commands** (run from `packages/graph`): `pnpm test`, `pnpm typecheck`, `pnpm lint`. From the repo root, `pnpm --filter @octoshell/graph test`.
- **Task 10 is not optional.** Any change under `packages/graph` regenerates the shipped `octograph.mjs` payload and obliges the full eleven-file pack version cohort. See `.agents/knowledge/architecture/pack-version-is-one-unit.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/graph/src/vault.ts` | **NEW** — read `.agents/knowledge/**/*.md`; match notes to paths (`cited` / `predicted`) |
| `packages/graph/src/diff-impact.ts` | **NEW** — resolve a git range to a changed set; union `impact()` over it |
| `packages/graph/src/config.ts` | **EDIT** — add `vaultPath`, `diffBase` |
| `packages/graph/src/cli.ts` | **EDIT** — `impact --diff` parsing and rendering |
| `packages/graph/src/doctor.ts` | **EDIT** — vault check |
| `packages/graph/src/render.ts` | **EDIT** — module purpose lines; one entry per module |
| `packages/graph/src/drift.ts` | **EDIT** — `known` marking on a pair |
| `packages/graph/src/index.ts` | **EDIT** — re-export new API |
| `packages/graph/test/vault.test.ts` | **NEW** |
| `packages/graph/test/vault-calibration.test.ts` | **NEW** — runs against the real repo vault, not a fixture |
| `packages/graph/test/diff-impact.test.ts` | **NEW** |

Tasks 1–7 are phase 1 (diff-impact shipping with vault citations). Tasks 8–9 are phase 2 (map/drift enrichment). Task 10 ships the pack.

---

### Task 1: `vault.ts` — read the notes

**Files:**
- Create: `packages/graph/src/vault.ts`
- Modify: `packages/graph/src/config.ts` (add `vaultPath`)
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/vault.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VaultNote` (`{ note: string; name: string; description: string; verified: string | null; body: string }`) and `readVault(repoRoot: string, vaultPath?: string): VaultNote[]`. Tasks 2, 3, 7, 8, 9 all consume these.

- [ ] **Step 1: Write the failing test**

Create `packages/graph/test/vault.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readVault } from "../src/vault.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function repoWithNotes(notes: Record<string, string>): string {
  const root = mkdtempClean("vault-");
  for (const [rel, body] of Object.entries(notes)) {
    const abs = join(root, ".agents", "knowledge", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("readVault", () => {
  it("returns an empty list when there is no vault", () => {
    expect(readVault(mkdtempClean("novault-"))).toEqual([]);
  });

  it("reads frontmatter and keeps the body", () => {
    const root = repoWithNotes({
      "architecture/dual.md": [
        "---",
        "name: two schemas, one shape",
        "description: entity-io.mjs and entity-schema.ts must move together",
        "verified: 2026-08-09",
        "---",
        "",
        "Body names packages/board/src/entity-schema.ts here.",
        "",
      ].join("\n"),
    });
    expect(readVault(root)).toEqual([
      {
        note: "architecture/dual.md",
        name: "two schemas, one shape",
        description: "entity-io.mjs and entity-schema.ts must move together",
        verified: "2026-08-09",
        body: "\nBody names packages/board/src/entity-schema.ts here.\n",
      },
    ]);
  });

  it("does not throw on an empty frontmatter block (js-yaml 5.2.2 throws on an empty document)", () => {
    const root = repoWithNotes({ "practices/empty.md": "---\n---\nbody\n" });
    const notes = readVault(root);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.name).toBe("empty");
    expect(notes[0]?.description).toBe("");
  });

  it("falls back to the filename stem when frontmatter is absent or unparseable", () => {
    const root = repoWithNotes({
      "practices/no-frontmatter.md": "just prose, no fence\n",
      "practices/broken.md": "---\nname: [unterminated\n---\nbody\n",
    });
    const names = readVault(root).map((n) => n.name).sort();
    expect(names).toEqual(["broken", "no-frontmatter"]);
  });

  it("flattens a folded multi-line description onto one line", () => {
    const root = repoWithNotes({
      "practices/folded.md": "---\ndescription: >-\n  first line\n  second line\n---\nbody\n",
    });
    expect(readVault(root)[0]?.description).toBe("first line second line");
  });

  it("ignores non-markdown files and README.md", () => {
    const root = repoWithNotes({
      "README.md": "---\nname: charter\n---\n",
      "practices/notes.txt": "not markdown",
      "practices/real.md": "---\nname: real\n---\n",
    });
    expect(readVault(root).map((n) => n.note)).toEqual(["practices/real.md"]);
  });

  it("returns notes in a deterministic order", () => {
    const root = repoWithNotes({
      "z/last.md": "---\nname: z\n---\n",
      "a/first.md": "---\nname: a\n---\n",
    });
    expect(readVault(root).map((n) => n.note)).toEqual(["a/first.md", "z/last.md"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- vault`
Expected: FAIL — `Failed to resolve import "../src/vault.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/graph/src/vault.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { compare } from "./rollup.js";

/** One committed knowledge note, reduced to what path-matching needs. */
export interface VaultNote {
  /** Path relative to the vault root, e.g. "architecture/dual-schema-entity-io.md". */
  note: string;
  /** Frontmatter `name`, or the filename stem when absent or unparseable. */
  name: string;
  /** Frontmatter `description`, flattened to one line. Empty string when absent. */
  description: string;
  /** Frontmatter `verified` or `created`, as written. Null when neither is present. */
  verified: string | null;
  /** Everything after the frontmatter block. The whole file when there is none. */
  body: string;
}

/** Where the vault lives by default. Overridable per repo via `vaultPath`. */
export const DEFAULT_VAULT_PATH = ".agents/knowledge";

/**
 * A leading YAML frontmatter block. Non-greedy so a body containing its own
 * `---` (a markdown horizontal rule, which several notes in this repo use)
 * cannot swallow the rest of the file into the frontmatter.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * A folded YAML scalar (`description: >-`) arrives with embedded newlines, and
 * a description is interpolated into single-line CLI output and into `map.md`,
 * which is line-oriented. Collapse every run of whitespace to one space, once,
 * here — not at each of the three call sites.
 */
const oneLine = (v: string): string => v.replace(/\s+/gu, " ").trim();

/** Every `*.md` under `dir`, depth-first, as paths relative to `dir`. */
function markdownFiles(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent or unreadable — an empty vault, never a throw
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...markdownFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * Read every note in the vault.
 *
 * Never throws. An absent vault, an unreadable file, an empty frontmatter
 * block (which `js-yaml@5.2.2` throws on rather than returning `undefined` —
 * see `.agents/knowledge/practices/js-yaml-empty-doc-and-bool-parsing.md`), or
 * malformed YAML each degrade to a thinner answer, exactly as `readGraphify`
 * degrades on a malformed `graph.json`. This is an OPTIONAL evidence tier; it
 * must not be able to break a `map` or `impact` run.
 *
 * `README.md` files are skipped at every level: the vault's own charter and
 * per-folder READMEs describe the layer, they are not facts about code, and
 * matching them would attach "here is what this folder is for" to a source
 * path as though it were a finding.
 */
export function readVault(repoRoot: string, vaultPath: string = DEFAULT_VAULT_PATH): VaultNote[] {
  const root = join(repoRoot, ...vaultPath.split("/"));
  const notes: VaultNote[] = [];

  for (const rel of markdownFiles(root)) {
    if (rel.endsWith("README.md")) continue;

    let raw: string;
    try {
      raw = readFileSync(join(root, ...rel.split("/")), "utf8");
    } catch {
      continue;
    }

    const stem = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/u, "");
    const match = FRONTMATTER.exec(raw);
    const body = match === null ? raw : raw.slice(match[0].length);

    let front: Record<string, unknown> = {};
    if (match?.[1] !== undefined) {
      try {
        const doc: unknown = loadYaml(match[1]);
        if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
          front = doc as Record<string, unknown>;
        }
      } catch {
        // Empty, whitespace-only, or malformed frontmatter. The note still
        // counts — its BODY is where citations live, and that parsed fine.
      }
    }

    const description = str(front.description);
    notes.push({
      note: rel,
      name: str(front.name) ?? stem,
      description: description === null ? "" : oneLine(description),
      verified: str(front.verified) ?? str(front.created),
      body,
    });
  }

  // Deterministic, by the same comparator every other ordering in this package
  // uses — `readdirSync` order is filesystem-dependent, and this list reaches a
  // committed artifact through `render.ts`.
  return notes.sort((a, b) => compare(a.note, b.note));
}
```

- [ ] **Step 4: Add the `vaultPath` config key**

In `packages/graph/src/config.ts`, add to the `Config` interface, next to `excludePaths`:

```ts
  /** Where the committed knowledge vault lives, relative to the repo root.
   *  An OPTIONAL evidence tier: a repo without one still gets every other
   *  answer, just without note citations. */
  vaultPath: string;
```

Add to `DEFAULTS`:

```ts
  vaultPath: ".agents/knowledge",
```

In `loadConfig`'s `octograph.yaml` reader, accept the key the same way `out` is accepted (a string, validated as repo content). Follow the existing `out` handling exactly — do not invent a second validation style.

- [ ] **Step 5: Re-export from `index.ts`**

In `packages/graph/src/index.ts`, after the `readGraphify` line:

```ts
export { readVault, DEFAULT_VAULT_PATH, type VaultNote } from "./vault.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test -- vault && pnpm typecheck && pnpm lint`
Expected: all vault tests PASS, typecheck clean, lint clean.

- [ ] **Step 7: Commit**

```bash
git add packages/graph/src/vault.ts packages/graph/src/config.ts packages/graph/src/index.ts packages/graph/test/vault.test.ts
git commit -m "feat(graph): read the committed knowledge vault as an optional evidence tier"
```

---

### Task 2: `vault.ts` — the `cited` matcher

**Files:**
- Modify: `packages/graph/src/vault.ts`
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/vault.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `VaultNote` from Task 1.
- Produces: `VaultMatch` (`{ path: string; note: string; description: string; mode: "cited" | "predicted"; confidence: number }`), `citedPaths(note: VaultNote, candidates: ReadonlySet<string>): string[]`, and `matchCited(notes: readonly VaultNote[], candidates: readonly string[]): VaultMatch[]`. Tasks 5, 8, 9 consume `matchCited`.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/vault.test.ts`:

```ts
import { citedPaths, matchCited } from "../src/vault.js";

const note = (body: string): VaultNote => ({
  note: "architecture/dual.md",
  name: "dual",
  description: "two schemas",
  verified: "2026-08-09",
  body,
});

describe("citedPaths", () => {
  const candidates = new Set([
    "packages/board/src/entity-schema.ts",
    "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs",
  ]);

  it("extracts every candidate path the body names", () => {
    expect(
      citedPaths(
        note(
          "The pair is packages/board/src/entity-schema.ts and\n"
            + "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs.\n",
        ),
        candidates,
      ),
    ).toEqual([
      "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs",
      "packages/board/src/entity-schema.ts",
    ]);
  });

  it("drops path-shaped prose that is not a real file", () => {
    // Every one of these is produced by a path regex over THIS repo's real
    // notes: a tag, a line-number list, a slashed phrase, a bare package name.
    expect(
      citedPaths(
        note("tags: area/board\nlines 19/25/53/64\ncampaign/mission/task/bug\n@octoshell/board\n"),
        candidates,
      ),
    ).toEqual([]);
  });

  it("drops a bare basename — a citation must be unambiguous", () => {
    expect(citedPaths(note("entity-schema.ts moved"), candidates)).toEqual([]);
  });

  it("does not count a path named only in the note's own frontmatter", () => {
    // `body` excludes frontmatter by construction (Task 1), so an `aliases:`
    // entry that happens to look like a path is not a citation.
    expect(citedPaths(note(""), candidates)).toEqual([]);
  });

  it("deduplicates a path named more than once", () => {
    const body = "packages/board/src/entity-schema.ts ... packages/board/src/entity-schema.ts";
    expect(citedPaths(note(body), candidates)).toEqual(["packages/board/src/entity-schema.ts"]);
  });
});

describe("matchCited", () => {
  it("emits one match per (path, note) pair, with confidence 1", () => {
    const notes: VaultNote[] = [
      { ...note("names packages/board/src/entity-schema.ts"), note: "a.md" },
      { ...note("also names packages/board/src/entity-schema.ts"), note: "b.md" },
    ];
    const matches = matchCited(notes, ["packages/board/src/entity-schema.ts"]);
    expect(matches).toEqual([
      {
        path: "packages/board/src/entity-schema.ts",
        note: "a.md",
        description: "two schemas",
        mode: "cited",
        confidence: 1,
      },
      {
        path: "packages/board/src/entity-schema.ts",
        note: "b.md",
        description: "two schemas",
        mode: "cited",
        confidence: 1,
      },
    ]);
  });

  it("returns nothing when no note names any candidate", () => {
    expect(matchCited([note("no paths here")], ["packages/board/src/entity-schema.ts"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- vault`
Expected: FAIL — `citedPaths is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/graph/src/vault.ts`:

```ts
/** How a note was tied to a path. Never blended — the `own` precedent. */
export type VaultMode = "cited" | "predicted";

export interface VaultMatch {
  /** The source path the note is about. */
  path: string;
  /** `VaultNote.note`. */
  note: string;
  description: string;
  mode: VaultMode;
  /** 1 for `cited` (it is a fact); the normalized tf-idf score for `predicted`. */
  confidence: number;
}

/**
 * Path-shaped tokens: anything containing a `/` and made of characters a
 * repo-relative path in this codebase actually uses.
 *
 * DELIBERATELY over-inclusive. It matches `area/board`, `19/25/53/64`,
 * `campaign/mission/task/bug` and `@octoshell/board` too — every one of those
 * comes out of this repo's real notes. They are removed by resolving against
 * the candidate corpus below, NOT by making this pattern cleverer: a regex
 * tuned to reject prose would eventually reject a real path (a directory
 * legitimately named `mission`), and a citation matcher that silently drops a
 * real citation is worse than one that proposes a candidate and has it
 * rejected by a set lookup.
 */
const PATH_TOKEN = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+/gu;

/**
 * The repo-relative paths a note's body explicitly names.
 *
 * "Explicitly" means an EXACT match against a path the repository actually
 * has. A bare basename (`entity-schema.ts`) is not a citation: two files can
 * share one, and attaching a note to the wrong one is precisely the
 * plausible-but-wrong answer the `cited` tier exists to avoid. A caller who
 * wants fuzzier reach has `matchPredicted`, which says so in its label.
 */
export function citedPaths(note: VaultNote, candidates: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const token of note.body.matchAll(PATH_TOKEN)) {
    const raw = token[0];
    // Trailing punctuation: prose ends a sentence naming a path with ".",
    // "," or ")" and the token grabs it.
    const cleaned = raw.replace(/[.,;:)\]]+$/u, "");
    if (candidates.has(cleaned)) found.add(cleaned);
  }
  return [...found].sort(compare);
}

/**
 * Every (path, note) pair where the note's body names the path outright.
 *
 * Ordered by path then note, through the same comparator the rest of this
 * package uses — these rows reach `map.md`, a committed artifact, so a
 * filesystem-dependent order would churn the diff between two identical runs.
 */
export function matchCited(
  notes: readonly VaultNote[],
  candidates: readonly string[],
): VaultMatch[] {
  const set = new Set(candidates);
  const out: VaultMatch[] = [];
  for (const note of notes) {
    for (const path of citedPaths(note, set)) {
      out.push({
        path,
        note: note.note,
        description: note.description,
        mode: "cited",
        confidence: 1,
      });
    }
  }
  return out.sort((a, b) => compare(a.path, b.path) || compare(a.note, b.note));
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Extend the Task 1 export line:

```ts
export {
  readVault,
  citedPaths,
  matchCited,
  DEFAULT_VAULT_PATH,
  type VaultNote,
  type VaultMatch,
  type VaultMode,
} from "./vault.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test -- vault && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/graph/src/vault.ts packages/graph/src/index.ts packages/graph/test/vault.test.ts
git commit -m "feat(graph): match vault notes to the paths their bodies cite"
```

---

### Task 3: `vault.ts` — the `predicted` matcher, behind a calibration gate

**Files:**
- Modify: `packages/graph/src/vault.ts`
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/vault.test.ts`, `packages/graph/test/vault-calibration.test.ts` (new)

**Interfaces:**
- Consumes: `VaultNote`, `VaultMatch` from Tasks 1–2; `tokenize` and `LexicalOptions` from `src/lexical.ts`.
- Produces: `matchPredicted(notes: readonly VaultNote[], paths: readonly string[], opts?: LexicalOptions): VaultMatch[]`.

**This task has a real gate.** `.agents/knowledge/practices/knowledge-vault-sentence-filenames-confound-lexical-matching.md` records that this repo's sentence-shaped note filenames out-scored real source files for 5 of 8 provenance-attributed tasks when scored without stopword filtering. That was the *criteria → file* direction; this is *path → note*. The confound neither automatically transfers nor automatically vanishes. **If Step 6 cannot produce a defensible floor, ship `cited` only** — delete `matchPredicted`, keep Tasks 1–2, and record why in the calibration test as a skipped test with the observed numbers. A tier that fires rarely and correctly beats one that fires often and plausibly.

- [ ] **Step 1: Write the failing unit test**

Append to `packages/graph/test/vault.test.ts`:

```ts
import { matchPredicted } from "../src/vault.js";

describe("matchPredicted", () => {
  const notes: VaultNote[] = [
    {
      note: "practices/dist-before-typecheck.md",
      name: "dependents read built dist, not src",
      description: "rebuild a package before typechecking its dependents",
      verified: "2026-08-09",
      body: "",
    },
    {
      note: "testing/graph-ci-checkout-is-shallow.md",
      name: "CI checkout is shallow so live history tests return empty",
      description: "actions/checkout fetches depth 1",
      verified: "2026-08-11",
      body: "",
    },
  ];

  it("labels every match `predicted`, never `cited`", () => {
    for (const m of matchPredicted(notes, ["packages/graph/src/harvest.ts"])) {
      expect(m.mode).toBe("predicted");
    }
  });

  it("scores a topically matching note above an unrelated one", () => {
    const matches = matchPredicted(notes, ["packages/graph/test/e2e.test.ts"], {
      confidenceFloor: 0,
      runnerUpMargin: 0,
    });
    expect(matches[0]?.note).toBe("testing/graph-ci-checkout-is-shallow.md");
  });

  it("answers nothing when no note clears the confidence floor", () => {
    expect(matchPredicted(notes, ["src/unrelated-domain-thing.ts"], { confidenceFloor: 0.99 }))
      .toEqual([]);
  });

  it("never emits a match for a path no note relates to, at the default floor", () => {
    expect(matchPredicted(notes, ["LICENSE"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- vault`
Expected: FAIL — `matchPredicted is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/graph/src/vault.ts` (add `import { tokenize, CONFIDENCE_FLOOR, type LexicalOptions } from "./lexical.js";` to the imports):

```ts
/**
 * Notes that are probably about a path, by token overlap.
 *
 * The DIRECTION is the opposite of `lexical.ts`'s: there, English prose
 * (acceptance criteria) is the query and file paths are the corpus. Here a
 * path is the query and notes are the corpus. That matters, because
 * `.agents/knowledge/`'s filenames are compressed English sentences, and
 * scoring English against English is what produced the confound recorded in
 * `practices/knowledge-vault-sentence-filenames-confound-lexical-matching.md`.
 * Running it the other way makes the query a short, dense, identifier-shaped
 * token list, which is why this direction is worth trying at all — and why it
 * still had to be calibrated against the real vault before shipping (see
 * `test/vault-calibration.test.ts`).
 *
 * Always `predicted`. This function has no route to `cited`, so no caller can
 * accidentally present a guess as a fact.
 */
export function matchPredicted(
  notes: readonly VaultNote[],
  paths: readonly string[],
  opts: LexicalOptions = {},
): VaultMatch[] {
  const floor = opts.confidenceFloor ?? CONFIDENCE_FLOOR;
  const margin = opts.runnerUpMargin ?? 0;

  // idf over the note corpus: a token in every note (`graph`, `test`)
  // distinguishes nothing, exactly as in lexical.ts.
  const df = new Map<string, number>();
  const noteTokens = notes.map((n) => {
    const tokens = new Set(tokenize(`${n.name} ${n.description} ${n.note}`));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });
  const idf = (t: string): number =>
    Math.log((notes.length + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const out: VaultMatch[] = [];
  for (const path of paths) {
    const query = [...new Set(tokenize(path))];
    const mass = query.reduce((sum, t) => sum + idf(t), 0);
    if (mass === 0) continue;

    const scored = notes
      .map((n, i) => {
        const tokens = noteTokens[i];
        if (tokens === undefined) return { note: n, score: 0 };
        const hit = query.reduce((sum, t) => (tokens.has(t) ? sum + idf(t) : sum), 0);
        return { note: n, score: hit / mass };
      })
      .filter((s) => s.score >= floor)
      .sort((x, y) => y.score - x.score || compare(x.note.note, y.note.note));

    const top = scored[0];
    if (top === undefined) continue;
    // A top match a near-tied runner-up is crowding says "could be either",
    // which is a coin flip, not a prediction — the same rule and the same
    // reasoning as `lexical.ts`'s RUNNER_UP_MARGIN.
    const next = scored.find((s) => s.score !== top.score);
    if (next !== undefined && top.score - next.score < margin) continue;

    out.push({
      path,
      note: top.note.note,
      description: top.note.description,
      mode: "predicted",
      confidence: top.score,
    });
  }
  return out.sort((a, b) => compare(a.path, b.path) || compare(a.note, b.note));
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd packages/graph && pnpm test -- vault`
Expected: PASS.

- [ ] **Step 5: Write the calibration test against the REAL vault**

Create `packages/graph/test/vault-calibration.test.ts`. A synthetic fixture never contains sentence-named files, which is exactly how the original confound stayed invisible.

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readVault, matchPredicted, matchCited } from "../src/vault.js";

/** This repo's own root — packages/graph/test → ../../.. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const HAS_VAULT = existsSync(join(REPO_ROOT, ".agents", "knowledge"));

describe.skipIf(!HAS_VAULT)("vault matching, calibrated against this repo's real vault", () => {
  const notes = readVault(REPO_ROOT);

  it("reads the real vault", () => {
    expect(notes.length).toBeGreaterThan(10);
  });

  it("cites the dual-schema pair — the flagship coupling in docs/octograph.md", () => {
    const pair = [
      "packages/board/src/entity-schema.ts",
      "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/entity-io.mjs",
    ];
    const cited = matchCited(notes, pair);
    // ONE note must cite BOTH halves — that is what makes the pair "known".
    const byNote = new Map<string, Set<string>>();
    for (const m of cited) {
      const seen = byNote.get(m.note) ?? new Set<string>();
      seen.add(m.path);
      byNote.set(m.note, seen);
    }
    const covering = [...byNote.entries()].filter(([, paths]) => paths.size === 2);
    expect(covering.map(([note]) => note)).toContain(
      "architecture/dual-schema-entity-io.md",
    );
  });

  it("does not predict a note for a path with no topical relationship", () => {
    // LICENSE shares no distinctive token with any note in this vault.
    expect(matchPredicted(notes, ["LICENSE"])).toEqual([]);
  });

  it("predicts the graph package's own notes for a graph source path", () => {
    const matches = matchPredicted(notes, ["packages/graph/src/analyze.ts"]);
    for (const m of matches) expect(m.note).toMatch(/graph|practices|testing/u);
  });
});
```

- [ ] **Step 6: Run the calibration test and make the ship/no-ship decision**

Run: `cd packages/graph && pnpm test -- vault-calibration`

Expected: PASS. If the third case fails — a graph source path predicting an unrelated note — raise `CONFIDENCE_FLOOR` for this direction and re-run. If no floor separates signal from noise across the whole vault, **remove `matchPredicted` and its unit tests**, keep `matchCited`, and replace the calibration test's predicted cases with a single `it.skip` whose body records the observed scores and the date. Then update the spec's "Calibration hazard" paragraph to say the tier did not ship.

- [ ] **Step 7: Re-export and commit**

Add `matchPredicted` to the `index.ts` export block from Task 2.

```bash
git add packages/graph/src/vault.ts packages/graph/src/index.ts packages/graph/test/vault.test.ts packages/graph/test/vault-calibration.test.ts
git commit -m "feat(graph): predict vault notes for a path, calibrated against the real vault"
```

---

### Task 4: `diff-impact.ts` — resolve a git range to a changed set

**Files:**
- Create: `packages/graph/src/diff-impact.ts`
- Modify: `packages/graph/src/config.ts` (add `diffBase`)
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/diff-impact.test.ts`

**Interfaces:**
- Consumes: `isExcludedPath` from `src/noise.ts`.
- Produces: `DiffScope` (`{ kind: "branch" } | { kind: "staged" } | { kind: "worktree" } | { kind: "since"; rev: string }`) and `changedPaths(repoRoot: string, scope: DiffScope, base: string, excludePaths: readonly string[]): string[]`. Task 6 consumes both.

- [ ] **Step 1: Write the failing test**

Create `packages/graph/test/diff-impact.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedPaths } from "../src/diff-impact.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** A repo with `main` at one commit and a branch two commits ahead. */
function repoWithBranch(): string {
  const root = mkdtempClean("diff-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  write(root, "src/base.ts", "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "feature");
  write(root, "src/one.ts", "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  write(root, "src/two.ts", "two\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "two");
  return root;
}

describe("changedPaths", () => {
  it("branch scope returns every path the branch changed against the base", () => {
    const root = repoWithBranch();
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });

  it("branch scope also includes uncommitted work", () => {
    const root = repoWithBranch();
    write(root, "src/three.ts", "three\n");
    git(root, "add", "-A");
    write(root, "src/four.ts", "four\n"); // untracked, unstaged
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/four.ts",
      "src/one.ts",
      "src/three.ts",
      "src/two.ts",
    ]);
  });

  it("staged scope returns only what is in the index", () => {
    const root = repoWithBranch();
    write(root, "src/staged.ts", "s\n");
    git(root, "add", "src/staged.ts");
    write(root, "src/loose.ts", "l\n");
    expect(changedPaths(root, { kind: "staged" }, "main", [])).toEqual(["src/staged.ts"]);
  });

  it("worktree scope returns uncommitted work only, not the branch's commits", () => {
    const root = repoWithBranch();
    write(root, "src/loose.ts", "l\n");
    expect(changedPaths(root, { kind: "worktree" }, "main", [])).toEqual(["src/loose.ts"]);
  });

  it("applies excludePaths, so the diff obeys the same exclusions as the graph", () => {
    const root = repoWithBranch();
    write(root, ".octobots/board.yaml", "x\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "board");
    expect(changedPaths(root, { kind: "branch" }, "main", [".octobots/"])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });

  it("returns an empty list when the base ref does not exist, rather than throwing", () => {
    const root = repoWithBranch();
    expect(changedPaths(root, { kind: "branch" }, "no-such-ref", [])).toEqual([]);
  });

  it("returns an empty list outside a git repository, rather than throwing", () => {
    expect(changedPaths(mkdtempClean("nogit-"), { kind: "branch" }, "main", [])).toEqual([]);
  });

  it("deduplicates a path that is both committed on the branch and modified in the worktree", () => {
    const root = repoWithBranch();
    write(root, "src/one.ts", "one, edited\n");
    expect(changedPaths(root, { kind: "branch" }, "main", [])).toEqual([
      "src/one.ts",
      "src/two.ts",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- diff-impact`
Expected: FAIL — `Failed to resolve import "../src/diff-impact.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/graph/src/diff-impact.ts`:

```ts
import { execFileSync } from "node:child_process";
import { isExcludedPath } from "./noise.js";
import { compare } from "./rollup.js";

/** Which change set `impact --diff` measures. */
export type DiffScope =
  | { kind: "branch" }
  | { kind: "staged" }
  | { kind: "worktree" }
  | { kind: "since"; rev: string };

/**
 * Run git and return stdout, or null on any failure.
 *
 * `execFileSync` (never `execSync`): a ref name reaches this from the CLI, and
 * a shell would interpret it. Nothing here is a shell command.
 *
 * Null, not a throw, on every failure — not a git repository, an unknown base
 * ref, an unborn HEAD. `impact --diff` is answerable-or-not, and a missing
 * answer is reported by the caller as "we cannot see", never as a crash.
 */
function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Split a NUL-delimited git list.
 *
 * `-z` throughout, exactly as `harvest.ts` reads `git log`: POSIX forbids only
 * `/` and NUL in a path, so a repo-relative path may legally contain a
 * NEWLINE. A line-split list silently turns one such path into two entries,
 * neither of which is a real file.
 */
function nulList(out: string | null): string[] {
  if (out === null) return [];
  return out.split("\0").filter((s) => s !== "");
}

/** `git status --porcelain -z` records: 2 status chars, a space, then the path. */
function porcelainPaths(out: string | null): string[] {
  const paths: string[] = [];
  const records = nulList(out);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // A rename record is `R  <new>` followed by a SEPARATE NUL-terminated
    // record holding the OLD path. Consume it, and keep the new path only —
    // the old one no longer exists, so no co-change row could name it.
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
    paths.push(path);
  }
  return paths;
}

/**
 * The repo-relative paths a scope covers, sorted and deduplicated.
 *
 * `branch` — the default — is `merge-base(base, HEAD)..HEAD` PLUS uncommitted
 * work. That is the question an executing agent actually has: a mission is a
 * feature branch and a task is a small PR into it, so "what has this branch
 * touched so far" spans several commits and whatever is not committed yet.
 * Measuring only `HEAD~1..HEAD` would answer for the last commit, which is
 * never the unit of work here.
 *
 * Exclusions are applied HERE, not by the caller: `excludePaths` governs the
 * whole graph (docs/octograph.md, "Exclusions apply to the whole graph"), and
 * a changed path that is not in the graph cannot produce a co-change row
 * anyway. Filtering here keeps the reported `changed` list honest about what
 * was actually analysed.
 */
export function changedPaths(
  repoRoot: string,
  scope: DiffScope,
  base: string,
  excludePaths: readonly string[],
): string[] {
  const uncommitted = (): string[] => [
    ...porcelainPaths(git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"])),
  ];

  let paths: string[];
  switch (scope.kind) {
    case "staged":
      paths = nulList(git(repoRoot, ["diff", "--name-only", "-z", "--cached"]));
      break;
    case "worktree":
      paths = uncommitted();
      break;
    case "since":
      paths = nulList(git(repoRoot, ["diff", "--name-only", "-z", `${scope.rev}..HEAD`]));
      break;
    case "branch": {
      const mergeBase = git(repoRoot, ["merge-base", base, "HEAD"])?.trim();
      const committed =
        mergeBase === undefined || mergeBase === ""
          ? []
          : nulList(git(repoRoot, ["diff", "--name-only", "-z", `${mergeBase}..HEAD`]));
      paths = [...committed, ...uncommitted()];
      break;
    }
  }

  const kept = new Set(paths.filter((p) => !isExcludedPath(p, excludePaths)));
  return [...kept].sort(compare);
}
```

- [ ] **Step 4: Add the `diffBase` config key**

In `packages/graph/src/config.ts`, add to `Config`:

```ts
  /** The ref `impact --diff` measures a branch against. `main` here because a
   *  mission is a feature branch off it; a repo whose trunk is named otherwise
   *  sets this once in octograph.yaml rather than passing --base every run. */
  diffBase: string;
```

Add to `DEFAULTS`: `diffBase: "main",`. Accept it in the `octograph.yaml` reader as a string, following the existing `out` handling.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test -- diff-impact && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/graph/src/diff-impact.ts packages/graph/src/config.ts packages/graph/test/diff-impact.test.ts
git commit -m "feat(graph): resolve a git range to the set of changed paths"
```

---

### Task 5: `diff-impact.ts` — union `impact()` over the changed set

**Files:**
- Modify: `packages/graph/src/diff-impact.ts`
- Modify: `packages/graph/src/index.ts`
- Test: `packages/graph/test/diff-impact.test.ts`

**Interfaces:**
- Consumes: `impact`, `ImpactRow` from `src/impact.ts`; `edgeWeight`, `Edge` from `src/weights.ts`; `rankScore` from `src/rank.ts`; `isTestPath` from `src/noise.ts`; `VaultNote`, `matchCited` from `src/vault.ts`.
- Produces: `DiffImpactRow` (`ImpactRow & { predictedBy: string[]; notes: VaultMatch[] }`), `DiffImpactAnswer` (`{ changed: string[]; source: DiffImpactRow[]; tests: DiffImpactRow[] }`), and `diffImpact(changed, edges, files, notes, limit?, minSupport?): DiffImpactAnswer`. Task 6 consumes all three.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/diff-impact.test.ts`:

```ts
import { diffImpact } from "../src/diff-impact.js";
import type { Edge } from "../src/weights.js";
import type { VaultNote } from "../src/vault.js";

const FILES = ["a.ts", "b.ts", "c.ts", "d.test.ts", "e.ts"];
const edge = (a: number, b: number, npmi: number, support: number): Edge => ({
  a,
  b,
  npmi,
  support,
  confidence: 0.5,
});

describe("diffImpact", () => {
  it("returns nothing for an empty changed set", () => {
    expect(diffImpact([], [], FILES, [])).toEqual({ changed: [], source: [], tests: [] });
  });

  it("drops rows that are themselves in the changed set", () => {
    // a<->b, and BOTH are changed: b is not something you might have missed.
    const edges = [edge(0, 1, 0.9, 10)];
    expect(diffImpact(["a.ts", "b.ts"], edges, FILES, []).source).toEqual([]);
  });

  it("partitions rows into source and tests", () => {
    const edges = [edge(0, 2, 0.9, 10), edge(0, 3, 0.8, 10)];
    const answer = diffImpact(["a.ts"], edges, FILES, []);
    expect(answer.source.map((r) => r.path)).toEqual(["c.ts"]);
    expect(answer.tests.map((r) => r.path)).toEqual(["d.test.ts"]);
  });

  it("records every changed path that pulled a row in", () => {
    // c.ts co-changes with both a.ts and b.ts.
    const edges = [edge(0, 2, 0.9, 10), edge(1, 2, 0.9, 10)];
    const answer = diffImpact(["a.ts", "b.ts"], edges, FILES, []);
    expect(answer.source[0]?.predictedBy).toEqual(["a.ts", "b.ts"]);
  });

  it("ranks a row two changed files predict above an equally scored row only one predicts", () => {
    // c.ts pulled by a.ts and b.ts; e.ts pulled by a.ts alone, same weight.
    const edges = [edge(0, 2, 0.9, 10), edge(1, 2, 0.9, 10), edge(0, 4, 0.9, 10)];
    const answer = diffImpact(["a.ts", "b.ts"], edges, FILES, []);
    expect(answer.source.map((r) => r.path)).toEqual(["c.ts", "e.ts"]);
  });

  it("attaches cited vault notes to a row", () => {
    const notes: VaultNote[] = [
      {
        note: "architecture/pair.md",
        name: "pair",
        description: "a and c move together",
        verified: "2026-08-13",
        body: "the pair is a.ts and c.ts",
      },
    ];
    const answer = diffImpact(["a.ts"], [edge(0, 2, 0.9, 10)], FILES, notes);
    expect(answer.source[0]?.notes).toEqual([
      {
        path: "c.ts",
        note: "architecture/pair.md",
        description: "a and c move together",
        mode: "cited",
        confidence: 1,
      },
    ]);
  });

  it("caps source and tests independently at the limit", () => {
    const edges = [edge(0, 1, 0.9, 10), edge(0, 2, 0.8, 10), edge(0, 3, 0.7, 10)];
    const answer = diffImpact(["a.ts"], edges, FILES, [], 1);
    expect(answer.source).toHaveLength(1);
    expect(answer.tests).toHaveLength(1);
  });

  it("ignores a changed path that is not in the co-change graph", () => {
    expect(diffImpact(["unknown.ts"], [edge(0, 1, 0.9, 10)], FILES, []).source).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- diff-impact`
Expected: FAIL — `diffImpact is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `packages/graph/src/diff-impact.ts` (extend the imports):

```ts
import { impact, type ImpactRow } from "./impact.js";
import { isTestPath } from "./noise.js";
import { rankScore } from "./rank.js";
import { edgeWeight, type Edge } from "./weights.js";
import { matchCited, type VaultMatch, type VaultNote } from "./vault.js";

export interface DiffImpactRow extends ImpactRow {
  /** Which changed paths pulled this row in, sorted. */
  predictedBy: string[];
  /** Vault notes about this row. `cited` only — see `diffImpact`. */
  notes: VaultMatch[];
}

export interface DiffImpactAnswer {
  /** The changed set actually analysed, after exclusions. */
  changed: string[];
  /** Files that co-change with the changed set and are not tests. */
  source: DiffImpactRow[];
  /** Files that co-change with the changed set and are tests. */
  tests: DiffImpactRow[];
}

/**
 * What else history says moves with everything you changed.
 *
 * `limit` means two different things on purpose, and `--help` says so: the
 * inner `impact()` keeps its own per-path default so no single changed file
 * can flood the union, and `limit` caps each of `source` and `tests` after the
 * merge. An unqualified "limit" on a command that fans out over N paths is a
 * number a reader would otherwise have to infer.
 *
 * Only `cited` notes are attached. A `predicted` note is a guess about
 * relevance layered on top of a co-change row that is already probabilistic,
 * and stacking two soft signals into one line is exactly the blending `own`
 * refuses to do. A caller who wants the predicted tier asks `vault.ts` for it
 * directly and labels it themselves.
 */
export function diffImpact(
  changed: readonly string[],
  edges: Edge[],
  files: string[],
  notes: readonly VaultNote[],
  limit = 20,
  minSupport = 2,
): DiffImpactAnswer {
  const changedSet = new Set(changed);
  const merged = new Map<string, { row: ImpactRow; score: number; by: Set<string> }>();

  for (const path of changed) {
    for (const row of impact(path, edges, files, undefined, minSupport)) {
      if (changedSet.has(row.path)) continue; // you already touched it
      const score = rankScore(edgeWeight({ ...row, a: 0, b: 0 } as Edge), row.support, minSupport);
      const existing = merged.get(row.path);
      if (existing === undefined) {
        merged.set(row.path, { row, score, by: new Set([path]) });
      } else {
        existing.by.add(path);
        if (score > existing.score) {
          existing.score = score;
          existing.row = row;
        }
      }
    }
  }

  const cited = matchCited(notes, [...merged.keys()]);
  const notesFor = new Map<string, VaultMatch[]>();
  for (const m of cited) {
    const list = notesFor.get(m.path);
    if (list === undefined) notesFor.set(m.path, [m]);
    else list.push(m);
  }

  const rows: Array<{ row: DiffImpactRow; score: number }> = [...merged.values()].map((e) => ({
    row: {
      ...e.row,
      predictedBy: [...e.by].sort(compare),
      notes: notesFor.get(e.row.path) ?? [],
    },
    score: e.score,
  }));

  // Strength first; then how many independent changed files point at it — a
  // file three of your changes all pull on is stronger evidence than one a
  // single change pulls on; then the shared comparator, for determinism.
  rows.sort(
    (x, y) =>
      y.score - x.score
      || y.row.predictedBy.length - x.row.predictedBy.length
      || compare(x.row.path, y.row.path),
  );

  const keep = limit > 0 ? limit : 0;
  return {
    changed: [...changed],
    source: rows.filter((r) => !isTestPath(r.row.path)).slice(0, keep).map((r) => r.row),
    tests: rows.filter((r) => isTestPath(r.row.path)).slice(0, keep).map((r) => r.row),
  };
}
```

**Implementation note for Step 3:** the `edgeWeight({ ...row, a: 0, b: 0 } as Edge)` cast above is a smell. `ImpactRow` already carries `npmi` as an `edgeWeight` result (see `impact.ts`: *"`ImpactRow.npmi` still reports the plain `edgeWeight` value"*), so use `rankScore(row.npmi, row.support, minSupport)` directly and delete both the cast and the `edgeWeight` import. Verify against `impact.ts` before writing, and keep whichever is true there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test -- diff-impact && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Re-export from `index.ts`**

```ts
export {
  changedPaths,
  diffImpact,
  type DiffScope,
  type DiffImpactRow,
  type DiffImpactAnswer,
} from "./diff-impact.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/graph/src/diff-impact.ts packages/graph/src/index.ts packages/graph/test/diff-impact.test.ts
git commit -m "feat(graph): union impact over a changed set, split source from tests"
```

---

### Task 6: `cli.ts` — `impact --diff`

**Files:**
- Modify: `packages/graph/src/cli.ts`
- Test: `packages/graph/test/cli.test.ts`

**Interfaces:**
- Consumes: `changedPaths`, `diffImpact`, `DiffScope` from Task 4–5; `readVault` from Task 1; `Config.diffBase`, `Config.vaultPath` from Tasks 1 and 4.
- Produces: no new exported API. `ParsedCommand` gains `diff: DiffScope | null` and `base: string | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/cli.test.ts`:

```ts
describe("impact --diff parsing", () => {
  it("rejects --diff together with a positional path", () => {
    const result = parseArgs(["impact", "--diff", "src/a.ts"]);
    expect(result.ok).toBe(true); // parseArgs accepts; runCli rejects
    const run = runCli(["impact", "--diff", "src/a.ts"], process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--diff and a <path> are mutually exclusive");
  });

  it("rejects an unknown scope flag by name", () => {
    const run = runCli(["impact", "--diff", "--sInce"], process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--sInce");
  });

  it("requires a value for --since and --base", () => {
    expect(parseArgs(["impact", "--diff", "--since"])).toEqual({
      ok: false,
      error: "--since requires a value",
    });
    expect(parseArgs(["impact", "--diff", "--base"])).toEqual({
      ok: false,
      error: "--base requires a value",
    });
  });

  it("rejects two scope flags at once", () => {
    const run = runCli(["impact", "--diff", "--staged", "--worktree"], process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("only one of --staged, --worktree, --since");
  });

  it("requires --diff before a scope flag", () => {
    const run = runCli(["impact", "--staged"], process.cwd());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--staged requires --diff");
  });
});
```

Note: `--since` already exists on `map`/`drift` as a history window (see `ParsedCommand.since`). Under `impact --diff` it names a git revision instead. Reuse the same parsed field only if that is unambiguous in `runCli`; if it is not, add a distinct `diffSince` field and say why in a comment. Check `cli.ts`'s existing `--since` handling before writing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- cli`
Expected: FAIL — no `--diff` handling; the unknown-flag `default` case rejects it.

- [ ] **Step 3: Extend `parseArgs`**

In `packages/graph/src/cli.ts`, add to `ParsedCommand`:

```ts
  /** Non-null when `--diff` was given: which change set to measure. */
  diff: DiffScope | null;
  /** `--base <ref>`; falls back to `Config.diffBase`. */
  base: string | undefined;
```

Add these `case` arms to the flag `switch`, alongside `--json` and `--out`. Follow the existing "recognition first, consumption second" rule — each is a literal string in the `switch`, never derived:

```ts
      case "--diff":
        sawDiff = true;
        break;
      case "--staged":
      case "--worktree":
        if (scopeFlag !== null) return { ok: false, error: DUPLICATE_SCOPE };
        scopeFlag = arg;
        break;
      case "--base": {
        const value = takeValue();
        if (value === null) return missingValue();
        base = value;
        break;
      }
```

Declare `let sawDiff = false; let scopeFlag: string | null = null; let base: string | undefined;` beside the existing `let json = false;`, and resolve the scope after the loop:

```ts
  // `--diff` names the QUESTION; the scope flags narrow it. A scope flag alone
  // is rejected rather than implying `--diff`, for the same reason this parser
  // rejects an unknown flag instead of ignoring it: a user who typed
  // `impact --staged` and got a whole-branch answer would have no way to tell.
  if (!sawDiff && scopeFlag !== null) {
    return { ok: false, error: `${scopeFlag} requires --diff` };
  }
  let diff: DiffScope | null = null;
  if (sawDiff) {
    if (scopeFlag === "--staged") diff = { kind: "staged" };
    else if (scopeFlag === "--worktree") diff = { kind: "worktree" };
    else if (since !== undefined) diff = { kind: "since", rev: since };
    else diff = { kind: "branch" };
  }
```

with `const DUPLICATE_SCOPE = "only one of --staged, --worktree, --since may be given";` at module scope.

- [ ] **Step 4: Reject `--diff` with a positional, and route the command**

In `runCli`, replace the existing `impact` arity check:

```ts
  if (command === "impact") {
    if (diff !== null && positionals.length > 0) {
      return usageError("--diff and a <path> are mutually exclusive");
    }
    if (diff === null && positionals.length !== 1) {
      return usageError("impact requires exactly one <path> argument, or --diff");
    }
  }
```

and in the command `switch`:

```ts
      case "impact": {
        if (diff !== null) {
          return runDiffImpactCommand(repoRoot, config, since, now, diff, base ?? config.diffBase, json);
        }
        const path = positionals[0];
        if (path === undefined) return usageError("impact requires exactly one <path> argument");
        return runImpactCommand(repoRoot, config, since, now, path, json);
      }
```

- [ ] **Step 5: Write `runDiffImpactCommand`**

Add beside `runImpactCommand`, following its structure for building `edges`/`files` (read it first and reuse the same helper, do not duplicate the harvest/weigh pipeline):

```ts
/**
 * `impact --diff` — what else moves, given everything this branch changed.
 *
 * An empty answer is rendered WITH `doctor`'s history verdict. On a repo that
 * squash-merges, the fine-grained co-change this reads was discarded at merge
 * time, so "no rows" means "we cannot see", not "nothing else moves" —
 * `docs/octograph.md` § Honest limits, and the phrasing the knowledge-explorer
 * skill requires of anyone reporting an empty graph result.
 */
function runDiffImpactCommand(
  repoRoot: string,
  config: Config,
  since: string | undefined,
  now: number,
  scope: DiffScope,
  base: string,
  json: boolean,
): CliResult {
  const changed = changedPaths(repoRoot, scope, base, config.excludePaths);
  const { edges, files } = buildGraph(repoRoot, config, since, now); // reuse runImpactCommand's helper
  const notes = readVault(repoRoot, config.vaultPath);
  const answer = diffImpact(changed, edges, files, notes, undefined, config.minSupport);

  if (json) return { exitCode: 0, stdout: `${JSON.stringify(answer, null, 2)}\n`, stderr: "" };

  const lines: string[] = [`changed: ${changed.length} file(s)`];
  if (changed.length === 0) {
    lines.push("", "nothing changed against the base — no impact to report");
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  const section = (title: string, rows: DiffImpactRow[]): void => {
    lines.push("", title);
    if (rows.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const r of rows) {
      lines.push(
        `  ${oneLine(r.path)}  npmi=${r.npmi.toFixed(3)}  support=${r.support}`
          + `  via ${r.predictedBy.map(oneLine).join(", ")}`,
      );
      for (const n of r.notes) lines.push(`      known: ${oneLine(n.note)} — ${n.description}`);
    }
  };
  section("you may also need to change:", answer.source);
  section("tests that historically move with this:", answer.tests);

  if (answer.source.length === 0 && answer.tests.length === 0) {
    const report = doctor(repoRoot, config);
    if (report.status !== "ok") {
      lines.push(
        "",
        `history is ${report.status} — this is missing evidence, not evidence of absence.`,
        "run `octograph doctor` for what is degraded and how to fix it.",
      );
    }
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
}
```

`oneLine` is already imported into `cli.ts` from `render.ts` for `own`'s output — reuse it, do not re-declare.

- [ ] **Step 6: Update `--help`**

Add to the usage text, wherever `impact <path>` is documented:

```
  impact --diff [--staged|--worktree|--since <rev>] [--base <ref>]
        What else moves, given everything changed against <ref> (default: main)
        plus uncommitted work. Rows are capped per section; each changed file
        contributes at most 20 candidates before the merge.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test && pnpm typecheck && pnpm lint`
Expected: the whole `packages/graph` suite PASSES.

- [ ] **Step 8: Try it against this repo**

Run: `cd packages/graph && node bin/octograph.mjs impact --diff --base main`
Expected: a `changed:` count matching this branch's diff, and either rows or the `missing evidence` note. Paste the real output into the commit body.

- [ ] **Step 9: Commit**

```bash
git add packages/graph/src/cli.ts packages/graph/test/cli.test.ts
git commit -m "feat(graph): impact --diff, scoped to the branch, with vault citations"
```

---

### Task 7: `doctor.ts` — grade the vault

**Files:**
- Modify: `packages/graph/src/doctor.ts`
- Test: `packages/graph/test/doctor.test.ts`

**Interfaces:**
- Consumes: `readVault`, `citedPaths` from Tasks 1–2; `Config.vaultPath` from Task 1.
- Produces: one more `Check` in `Report.checks`, named `"knowledge vault"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/doctor.test.ts`:

```ts
/** Write a knowledge note into an existing fixture repo. */
function writeNote(root: string, rel: string, body: string): void {
  const abs = join(root, ".agents", "knowledge", rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("knowledge vault check", () => {
  it("reports missing when there is no vault, and never degrades status", () => {
    const report = doctor(healthyRepo(), DEFAULTS);
    expect(check(report, "knowledge vault")?.state).toBe("missing");
    expect(check(report, "knowledge vault")?.required).toBe(false);
    expect(check(report, "knowledge vault")?.fix).toBeTruthy();
    expect(report.status).toBe("ok"); // an optional input never moves status
  });

  it("reports how many notes cite at least one path in the graph", () => {
    const repo = healthyRepo(); // commits a0.ts..a11.ts and b0.ts..b11.ts
    writeNote(repo, "architecture/pair.md", "---\nname: pair\n---\na0.ts and b0.ts move together\n");
    writeNote(repo, "practices/loose.md", "---\nname: loose\n---\nno paths at all\n");
    const detail = check(doctor(repo, DEFAULTS), "knowledge vault")?.detail ?? "";
    expect(detail).toContain("2 notes");
    expect(detail).toContain("1 citing");
  });

  it("keeps every check name unique with the vault check present", () => {
    const names = doctor(healthyRepo(), DEFAULTS).checks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

`healthyRepo()`, `check()`, `buildRepo`, `mkdtempClean` and `DEFAULTS` are already imported at the top of `doctor.test.ts` — reuse them. `healthyRepo()` commits twelve pairs `a<i>.ts` / `b<i>.ts`, so `a0.ts` and `b0.ts` are real paths in the graph. The uniqueness assertion may already exist in this file; extend the existing case rather than adding a second.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- doctor`
Expected: FAIL — no check named `knowledge vault`.

- [ ] **Step 3: Write the implementation**

In `packages/graph/src/doctor.ts`, add a check beside the existing graphify check. It must satisfy both documented invariants: one check per input name, and every non-`ok` check names a `fix`.

```ts
  // The vault is an OPTIONAL tier, so `required: false` — it never moves
  // `status`, exactly like graphify. It is graded anyway because an absent
  // vault changes what `drift` can claim: without it, a coupling can be
  // ranked but not called already-documented, and a reader has no way to
  // tell "nothing documents this" from "nothing was read".
  const notes = readVault(repoRoot, config.vaultPath);
  if (notes.length === 0) {
    checks.push({
      name: "knowledge vault",
      state: "missing",
      required: false,
      detail: `not found at ${config.vaultPath} — drift can rank a coupling but cannot say whether it is already documented`,
      fix: `create ${config.vaultPath}/ and record verified, cross-role facts there (see AGENTS.md § Agent memory)`,
    });
  } else {
    const candidates = new Set(files);
    const citing = notes.filter((n) => citedPaths(n, candidates).length > 0).length;
    checks.push({
      name: "knowledge vault",
      state: "ok",
      required: false,
      detail: `${notes.length} notes, ${citing} citing at least one path in the graph`,
    });
  }
```

`files` here is the candidate corpus `doctor` already computes for its composition check — reuse it; do not re-harvest.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Run doctor against this repo**

Run: `cd packages/graph && node bin/octograph.mjs doctor`
Expected: a `[ok] knowledge vault: 2x notes, N citing at least one path in the graph` line. Paste it into the commit body.

- [ ] **Step 6: Commit**

```bash
git add packages/graph/src/doctor.ts packages/graph/test/doctor.test.ts
git commit -m "feat(graph): grade the knowledge vault as an optional doctor input"
```

---

### Task 8: `render.ts` — module purpose lines

**Files:**
- Modify: `packages/graph/src/render.ts`
- Modify: `packages/graph/src/analyze.ts` (only if `Analysis` must carry the new data — prefer passing it into `renderMap`)
- Test: `packages/graph/test/render.test.ts`

**Interfaces:**
- Consumes: `VaultMatch` from Task 2; `OwnAnswer` from `src/own.ts`.
- Produces: `renderMap(analysis: Analysis, budgetTokens: number, purpose?: ReadonlyMap<string, string>): string` — a third, optional parameter mapping module name to a one-line purpose string. Optional so every existing caller and test keeps working unchanged.

**The hazard this task exists to avoid:** `render.ts` currently assumes one module renders one line, and slices two parallel lists — `lines` (built from `ranked`) and `ranked` itself — with the same `keptModules` counter (`render.ts:118`, `render.ts:151`). If a module starts rendering two lines and `lines` becomes longer than `ranked`, those slices name different sets, and `visibleEdges` / `visibleSets` will emit an edge or a working set referencing a module with no heading — a dangling reference in a committed artifact that an agent loads as architecture truth.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/render.test.ts`:

```ts
/** The many-module fixture the existing truncation tests already build. */
const many: Analysis = {
  ...analysis,
  modules: Array.from({ length: 500 }, (_, i) => ({
    id: i,
    name: `module/number-${i}`,
    members: [`module/number-${i}/file.ts`],
    layer: 0,
  })),
};

describe("module purpose lines", () => {
  // `analysis` is the file-level fixture: modules `packages/board` and `apps/ext`.
  const purpose = new Map([["packages/board", "M3 - Drift, doctor and the shipped CLI (provenance)"]]);

  it("renders a purpose line under a module that has one", () => {
    const out = renderMap(analysis, 2000, purpose);
    expect(out).toContain("- **packages/board**");
    expect(out).toContain("  - M3 - Drift, doctor and the shipped CLI (provenance)");
  });

  it("renders nothing extra for a module without one", () => {
    const lines = renderMap(analysis, 2000, purpose).split("\n");
    const i = lines.findIndex((l) => l.startsWith("- **apps/ext**"));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]?.startsWith("  - ")).toBe(false);
  });

  it("escapes a purpose line through oneLine, so it cannot inject a row", () => {
    const out = renderMap(analysis, 2000, new Map([["packages/board", "M3\n  - apps/injected"]]));
    expect(out).not.toContain("\n  - apps/injected");
    expect(out).toContain("\\x0a");
  });

  it("ignores a purpose entry for a module that does not exist", () => {
    const out = renderMap(analysis, 2000, new Map([["no/such-module", "orphan"]]));
    expect(out).not.toContain("orphan");
  });

  it("never emits an edge naming a module the budget cut, with purpose lines present", () => {
    const withPurpose = new Map(many.modules.map((m) => [m.name, `owned by ${m.name}`]));
    const out = renderMap(many, 300, withPurpose); // a budget that forces truncation
    const headings = new Set(
      out
        .split("\n")
        .filter((l) => l.startsWith("- **"))
        .map((l) => l.slice(4, l.indexOf("**", 4))),
    );
    for (const line of out.split("\n")) {
      const edge = /^- (.+) [↔→] (.+) \(/u.exec(line);
      const from = edge?.[1];
      const to = edge?.[2];
      if (from !== undefined && to !== undefined) {
        expect(headings.has(from)).toBe(true);
        expect(headings.has(to)).toBe(true);
      }
    }
  });

  it("stays under the token budget with purpose lines present", () => {
    const withPurpose = new Map(many.modules.map((m) => [m.name, `owned by ${m.name}`]));
    expect(estimateTokens(renderMap(many, 300, withPurpose))).toBeLessThanOrEqual(300);
  });

  it("is byte-identical across runs with purpose lines present", () => {
    expect(renderMap(analysis, 2000, purpose)).toBe(renderMap(analysis, 2000, purpose));
  });
});
```

`analysis` and `estimateTokens` are already in scope at the top of `render.test.ts` — do not redeclare them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- render`
Expected: FAIL — `renderMap` takes two arguments.

- [ ] **Step 3: Change `lines` to one entry per module**

In `packages/graph/src/render.ts`, replace the `lines` build (currently `render.ts:115-119`):

```ts
  // ONE ENTRY PER MODULE, even when that entry spans several rendered lines.
  //
  // `keptModules` slices BOTH this list and `ranked` (see `shownModules`), and
  // the two must name the same set or `visibleEdges`/`visibleSets` will keep an
  // edge whose endpoint lost its heading — a dangling reference in a committed
  // artifact an agent reads as architecture truth. Keeping the entry, rather
  // than the line, as the unit is what makes that invariant survive a module
  // rendering more than one line. The shrink loop below already weighs sections
  // by RENDERED LINES rather than item counts (see its comment), so the extra
  // lines are costed correctly without touching it.
  const lines: string[] = [];
  for (const m of ranked) {
    const layer = m.layer === null ? "" : ` [layer ${m.layer}]`;
    const head = `- **${oneLine(m.name)}**${layer} — ${countLabel(m.members)}`;
    const why = purpose?.get(m.name);
    lines.push(why === undefined ? head : `${head}\n  - ${oneLine(why)}`);
  }
```

Add the parameter:

```ts
export function renderMap(
  analysis: Analysis,
  budgetTokens: number,
  /** Module name → a one-line "what this is for", already labelled with its
   *  own evidence mode by the caller (`provenance` / `predicted` / a cited
   *  note). `render` does not decide what counts as evidence; it escapes and
   *  budgets whatever it is handed. */
  purpose?: ReadonlyMap<string, string>,
): string {
```

- [ ] **Step 4: Fix the shrink loop's line accounting**

The loop compares `keptModules` (now an *entry* count) against line counts. Replace that one comparison so modules are also measured in lines:

```ts
    const moduleLineCount = lines.slice(0, keptModules).join("\n").split("\n").length;
    if (moduleLineCount >= shownEdges && moduleLineCount >= setLineCount) {
      keptModules = shrink(keptModules);
    } else if (shownEdges >= moduleLineCount && shownEdges >= setLineCount) {
      keptEdges = shrink(shownEdges);
    } else {
      keptSets = shrink(shownSets);
    }
```

Keep the existing `if (keptModules + shownEdges + shownSets === 0) break;` termination guard exactly as it is — each branch still strictly decreases its own counter.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test -- render && pnpm test -- map-reproducibility && pnpm typecheck && pnpm lint`
Expected: PASS, including every existing truncation and dangling-reference test.

- [ ] **Step 6: Build the purpose map in `cli.ts`'s map command**

In `runMapCommand`, assemble the map and pass it as `renderMap`'s third argument. Module identity comes from the spine's `moduleOf`, exactly as `analyze` does — never re-derived here.

```ts
/**
 * Module name → a one-line "what this is for".
 *
 * Two sources, each carrying its own label into the string, because `render`
 * escapes and budgets what it is handed but does not decide what counts as
 * evidence. A module's owner is the mission of the MOST-attributed task among
 * its files — one line per module is the budget, so a module owned by three
 * tasks names the one with the most files rather than listing all three.
 */
function purposeByModule(
  answers: readonly OwnAnswer[],
  notes: readonly VaultNote[],
  files: readonly string[],
  moduleOf: (p: string) => string,
): Map<string, string> {
  const tally = new Map<string, Map<string, { label: string; n: number }>>();
  for (const a of answers) {
    const mod = moduleOf(a.path);
    const byMission = tally.get(mod) ?? new Map<string, { label: string; n: number }>();
    const key = a.mission;
    const seen = byMission.get(key);
    const label = `${a.missionName} (${a.mode})`;
    if (seen === undefined) byMission.set(key, { label, n: 1 });
    else seen.n += 1;
    tally.set(mod, byMission);
  }

  const citedByModule = new Map<string, string>();
  for (const m of matchCited(notes, files)) {
    const mod = moduleOf(m.path);
    // First wins: `matchCited` is sorted by path then note, so this is stable
    // across runs — `map.md` is committed and must not churn between two
    // identical runs.
    if (!citedByModule.has(mod)) citedByModule.set(mod, m.note);
  }

  const out = new Map<string, string>();
  for (const mod of new Set([...tally.keys(), ...citedByModule.keys()])) {
    const missions = [...(tally.get(mod)?.values() ?? [])].sort(
      (x, y) => y.n - x.n || compare(x.label, y.label),
    );
    const parts: string[] = [];
    const top = missions[0];
    if (top !== undefined) parts.push(top.label);
    const note = citedByModule.get(mod);
    if (note !== undefined) parts.push(`see ${note}`);
    if (parts.length > 0) out.set(mod, parts.join(" — "));
  }
  return out;
}
```

Call it with the answers `runOwnCommand` already produces for a whole-repo inventory (`own` with `path === null`), the vault notes, the candidate corpus, and `spine.moduleOf`. If `runMapCommand` does not currently build a `BoardView`, guard the whole call: a repo with no board still gets vault-only purpose lines, and a repo with neither gets an unchanged `map.md`.

- [ ] **Step 7: Rebuild this repo's map and read it**

Run: `cd packages/graph && node bin/octograph.mjs map --out .octograph`
Expected: `.octograph/map.md` with purpose lines under the modules that have one, and still under the token budget.

- [ ] **Step 8: Commit**

```bash
git add packages/graph/src/render.ts packages/graph/src/cli.ts packages/graph/test/render.test.ts
git commit -m "feat(graph): say what each module is for in map.md, from the board and the vault"
```

---

### Task 9: `drift.ts` — mark a pair the vault already documents

**Files:**
- Modify: `packages/graph/src/drift.ts`
- Modify: `packages/graph/src/cli.ts` (render the marker)
- Test: `packages/graph/test/drift.test.ts`

**Interfaces:**
- Consumes: `VaultNote`, `citedPaths` from Tasks 1–2.
- Produces: `DriftRow` gains `known: string | null` — the note that cites **both** files, or null. `drift(edges, files, spine, limit?, minSupport?, notes?)` gains an optional sixth parameter.

- [ ] **Step 1: Write the failing test**

Append to `packages/graph/test/drift.test.ts`:

```ts
import type { VaultNote } from "../src/vault.js";

describe("vault marking", () => {
  // `edges`, `files` and `spine` are the file-level fixtures: drift's top row
  // is svc/a/client.ts <-> svc/b/api.ts, the cross-boundary finding.
  const driftEdges = [edge(0, 1, 1.0), edge(2, 3, 0.95), edge(2, 4, 0.85)];

  const note = (name: string, body: string): VaultNote => ({
    note: `architecture/${name}.md`,
    name,
    description: `${name} description`,
    verified: "2026-08-13",
    body,
  });

  it("marks a pair one note cites both halves of", () => {
    const notes = [note("pair", "the pair is svc/a/client.ts and svc/b/api.ts")];
    const rows = drift(driftEdges, files, spine, 20, 2, notes);
    expect(rows[0]?.a).toBe("svc/a/client.ts");
    expect(rows[0]?.known).toBe("architecture/pair.md");
  });

  it("does not mark a pair whose halves are cited by DIFFERENT notes", () => {
    // The claim is about the PAIR. Two notes each describing one file are not
    // a record that the two are coupled — which is the whole finding.
    const notes = [
      note("left", "svc/a/client.ts alone"),
      note("right", "svc/b/api.ts alone"),
    ];
    expect(drift(driftEdges, files, spine, 20, 2, notes)[0]?.known).toBeNull();
  });

  it("does not mark on a bare basename", () => {
    const notes = [note("loose", "client.ts and api.ts")];
    expect(drift(driftEdges, files, spine, 20, 2, notes)[0]?.known).toBeNull();
  });

  it("leaves known null when no notes are supplied", () => {
    expect(drift(driftEdges, files, spine)[0]?.known).toBeNull();
  });
});
```

`edge`, `files` and `spine` are already declared at the top of `drift.test.ts` — reuse them, do not redeclare.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/graph && pnpm test -- drift`
Expected: FAIL — `known` is not a property of `DriftRow`.

- [ ] **Step 3: Write the implementation**

In `packages/graph/src/drift.ts`, add to `DriftRow`:

```ts
  /**
   * The vault note that cites BOTH files, or null.
   *
   * One note naming both, never two notes naming one each: the finding is that
   * the two files are coupled, and two notes that each describe one file are
   * not a record of that. `null` on a strongly-supported row is the promotion
   * candidate the knowledge-explorer skill asks for — coupling the history
   * proves and the vault has not recorded.
   */
  known: string | null;
```

Add the parameter and, after the rows are scored and sliced, resolve `known` for the survivors only — never for every candidate pair, which would cost a full vault scan per edge:

```ts
export function drift(
  edges: Edge[],
  files: string[],
  spine: Spine,
  limit = 20,
  minSupport = 2,
  notes: readonly VaultNote[] = [],
): DriftRow[] {
```

```ts
  // Resolve citations for the SURVIVORS only. `citedPaths` scans a note body
  // per call, and drift's candidate set is every co-change edge in the repo —
  // resolving before the slice would scan the whole vault thousands of times
  // to label twenty rows.
  const candidates = new Set(kept.flatMap((r) => [r.a, r.b]));
  const cites = notes.map((n) => ({ note: n.note, paths: new Set(citedPaths(n, candidates)) }));
  for (const row of kept) {
    const covering = cites.find((c) => c.paths.has(row.a) && c.paths.has(row.b));
    row.known = covering?.note ?? null;
  }
```

- [ ] **Step 4: Render the marker in `cli.ts`**

In `runDriftCommand`, append `  [known: <note>]` to a row that has one. Escape it through `oneLine`, like every other path this CLI prints.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/graph && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Verify the flagship pair against this repo**

Run: `cd packages/graph && node bin/octograph.mjs drift | grep -i entity`

Expected: the `entity-io.mjs ↔ entity-schema.ts` row carries `[known: architecture/dual-schema-entity-io.md]`. **If it does not, the citation matcher is wrong** — that pair is the flagship example in `docs/octograph.md` and the note names both files by full repo-relative path (verified 2026-08-13). Do not proceed until it does. Paste the real line into the commit body.

- [ ] **Step 7: Commit**

```bash
git add packages/graph/src/drift.ts packages/graph/src/cli.ts packages/graph/test/drift.test.ts
git commit -m "feat(graph): mark a drifting pair the vault already documents"
```

---

### Task 10: Ship the pack — version cohort and skill prose

**Files:**
- Modify: `apps/vscode-extension/src/host/octobots-skill.ts` (`OCTOBOTS_PACK_VERSION`)
- Modify: all five `apps/vscode-extension/resources/octobots-pack/skill/*/SKILL.md` (frontmatter `version:`)
- Modify: `apps/vscode-extension/resources/octobots-pack/hooks/primer.mjs` (banner)
- Modify: `apps/vscode-extension/resources/octobots-pack/tokenomics/run.mjs` (banner)
- Modify: `apps/vscode-extension/resources/octobots-pack/tokenomics/backfill-worklog-sha.mjs` (banner)
- Regenerate: `apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs`
- Modify: `apps/vscode-extension/scripts/graph-payload-versions.json`
- Modify: `docs/octograph.md`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: pack v52, installable.

**Why this is one task and cannot be split:** `packStatus` reports a workspace up to date only when **every** marker equals `OCTOBOTS_PACK_VERSION`. There is no partial state. Miss one hand-edited marker and every workspace already running the current payload is told it is stale; miss the payload regeneration or its hash and every workspace keeps running a stale `octograph.mjs` forever with nothing saying so. Verified 2026-08-13 — see `.agents/knowledge/architecture/pack-version-is-one-unit.md`.

- [ ] **Step 1: Add the skill prose**

`knowledge-explorer/SKILL.md` — add to the query ladder table:

```
| I changed these files — what else moves, and what covers it? | `impact --diff` |
```

and after the table:

> `drift` marks a pair the vault already documents as `[known: <note>]`. An unmarked pair with
> strong support is a promotion candidate: coupling the history proves and the vault has not
> recorded. That is the loop — the graph is how the vault grows.

`mission-execution/SKILL.md` — before a task is declared done: run `impact --diff` and account for every row, either by changing the file or by saying why it does not need to change.

`mission-completion-gate/SKILL.md` — the `tests that historically move with this` section feeds the gate's coverage question.

- [ ] **Step 2: Bump the nine hand-edited markers**

51 → 52 in: `OCTOBOTS_PACK_VERSION`; the `version:` frontmatter of `knowledge-explorer`, `mission-completion-gate`, `mission-execution`, `mission-planner`, `workflow-designer`; the `// octobots-pack-version:` banner in `primer.mjs`, `run.mjs`, `backfill-worklog-sha.mjs`.

- [ ] **Step 3: Regenerate the payload**

```bash
cd apps/vscode-extension && node scripts/graph-payload.mjs --write
```

Never hand-edit the payload's banner. Confirm it reads `// octobots-pack-version: 52`.

- [ ] **Step 4: Record the new hash**

```bash
shasum -a 256 apps/vscode-extension/resources/octobots-pack/graph/octograph.mjs
```

Add `"52": "<that hash>"` to `apps/vscode-extension/scripts/graph-payload-versions.json`. Leave every prior entry untouched.

- [ ] **Step 5: Document the new commands**

In `docs/octograph.md`, add to the command table:

```
| `impact --diff` | I changed these files — what else moves, and what covers it? |
```

and a short section showing real output from this repo, plus a sentence on the vault tier under *What it needs, and what it will tell you*.

- [ ] **Step 6: Run the full verification**

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
```

Expected: green everywhere. `octobots-skill.test.ts` fails by skill name if a `SKILL.md` version is stale; `graph-payload.test.ts` fails if the payload bytes are not recorded against version 52.

- [ ] **Step 7: Commit**

```bash
git add apps/vscode-extension docs/octograph.md
git commit -m "feat(pack): release v52 — impact --diff and the vault evidence tier"
```

---

## Verification before the mission PR

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green from the repo root.
- [ ] `node packages/graph/bin/octograph.mjs doctor` shows the `knowledge vault` check.
- [ ] `node packages/graph/bin/octograph.mjs drift | grep entity` shows `[known: architecture/dual-schema-entity-io.md]`.
- [ ] `node packages/graph/bin/octograph.mjs impact --diff` returns rows for this very branch, or the `missing evidence` note with `doctor`'s verdict.
- [ ] `packStatus(repo).upToDate === true` after `installPack` (asserted by the extension suite).
- [ ] The `.agents/knowledge/README.md` stale-gap paragraph is filed as a separate issue, not fixed here.
