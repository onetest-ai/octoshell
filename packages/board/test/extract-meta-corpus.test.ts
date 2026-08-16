import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPhases } from "../src/extract-meta.js";

const DIR = join(import.meta.dirname, "fixtures", "workflow-corpus");
const scripts = readdirSync(DIR).filter((f) => f.endsWith(".js"));

describe("extraction over real workflow scripts", () => {
  it("has the whole corpus", () => {
    expect(scripts).toHaveLength(9);
  });

  for (const file of scripts) {
    describe(file, () => {
      const source = readFileSync(join(DIR, file), "utf8");

      it("parses and yields at least one phase with at least one step", () => {
        const { phases } = extractPhases(source);
        expect(phases.length).toBeGreaterThan(0);
        expect(phases.some((p) => p.steps.length > 0)).toBe(true);
      });

      it("gives every step a non-empty id and label, and unique ids", () => {
        const steps = extractPhases(source).phases.flatMap((p) => p.steps);
        for (const step of steps) {
          expect(step.id).toMatch(/\S/);
          expect(step.label).toMatch(/\S/);
        }
        expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
      });

      it("only ever depends on a step that exists", () => {
        const steps = extractPhases(source).phases.flatMap((p) => p.steps);
        const ids = new Set(steps.map((s) => s.id));
        for (const step of steps) for (const dep of step.dependsOn ?? []) expect(ids.has(dep)).toBe(true);
      });

      it("matches its recorded snapshot", () => {
        expect(extractPhases(source).phases).toMatchSnapshot();
      });
    });
  }
});
