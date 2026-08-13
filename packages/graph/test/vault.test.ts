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

  // Each input below MUST match FRONTMATTER (a real line between the fences)
  // so `loadYaml` is actually reached and actually throws. `"---\n---\n"` does
  // NOT match — the fences are adjacent — so it exercises the no-frontmatter
  // branch instead and would pass with the try/catch deleted.
  it.each([
    ["empty", "---\n\n---\nbody\n"],
    ["whitespace", "---\n   \n---\nbody\n"],
    ["comment-only", "---\n# just a comment\n---\nbody\n"],
  ])("does not throw on %s frontmatter (js-yaml 5.2.2 throws on such a document)", (label, raw) => {
    const root = repoWithNotes({ [`practices/${label}.md`]: raw });
    const notes = readVault(root);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.name).toBe(label);
    expect(notes[0]?.description).toBe("");
    expect(notes[0]?.body).toBe("body\n");
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
