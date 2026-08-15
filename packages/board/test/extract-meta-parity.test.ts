import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPhases } from "../src/extract-meta.js";
import { EXTRACTOR_SOURCES } from "./fixtures/extractor-sources.js";

const DIR = join(import.meta.dirname, "fixtures", "workflow-corpus");
const PACK = join(
  import.meta.dirname,
  "..", "..", "..",
  "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/extract-meta.mjs",
);

async function mirror(): Promise<{ extractPhases: typeof extractPhases }> {
  return (await import(PACK)) as { extractPhases: typeof extractPhases };
}

describe("the two extractors stay in step", () => {
  it("agrees on every workflow in the corpus", async () => {
    const pack = await mirror();
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(join(DIR, file), "utf8");
      expect(JSON.stringify(pack.extractPhases(source)), file).toBe(
        JSON.stringify(extractPhases(source)),
      );
    }
  });

  // The corpus is real code and therefore narrow: none of the nine workflows uses `pipeline()`, a
  // `workflow()` node, `backend`, `kind: 'command'` or a binary-expression label, so those branches
  // had a unit test on the TS side and no guard on the mirror at all. Driving the unit suite's own
  // sources through both extractors closes that: every branch a unit test covers is parity-covered
  // by construction, and a new unit fixture is parity-covered the moment it is added.
  it("agrees on every shape the unit tests exercise", async () => {
    const pack = await mirror();
    const shapes = Object.entries(EXTRACTOR_SOURCES);
    expect(shapes.length).toBeGreaterThan(20);
    for (const [name, source] of shapes) {
      expect(JSON.stringify(pack.extractPhases(source)), name).toBe(
        JSON.stringify(extractPhases(source)),
      );
    }
  });
});
