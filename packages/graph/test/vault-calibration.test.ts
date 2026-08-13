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
