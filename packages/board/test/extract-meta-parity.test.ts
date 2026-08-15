import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPhases } from "../src/extract-meta.js";

const DIR = join(import.meta.dirname, "fixtures", "workflow-corpus");
const PACK = join(
  import.meta.dirname,
  "..", "..", "..",
  "apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/extract-meta.mjs",
);

describe("the two extractors stay in step", () => {
  it("agrees on every workflow in the corpus", async () => {
    const mirror = (await import(PACK)) as { extractPhases: typeof extractPhases };
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(join(DIR, file), "utf8");
      expect(JSON.stringify(mirror.extractPhases(source)), file).toBe(
        JSON.stringify(extractPhases(source)),
      );
    }
  });
});
