import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEstimateBlock, readEstimate } from "../src/estimates.js";

describe("parseEstimateBlock", () => {
  it("reads the authored fields", () => {
    const e = parseEstimateBlock(`# M1 - Thing

## Tokenomics
effort_days: 3
size_tshirt: M
complexity_score: 18
maturity: pilot
self_size: L
estimated_retrospectively: true
branches: feat/a, feat/b
`);
    expect(e).toMatchObject({
      effortDays: 3,
      sizeTshirt: "M",
      complexityScore: 18,
      maturity: "pilot",
      selfSize: "L",
      estimatedRetrospectively: true,
      branches: ["feat/a", "feat/b"],
    });
  });

  // Regression: with the `/m` flag needed for `^##`, a bare `$` terminator makes
  // the lazy body stop at the FIRST newline, silently truncating the block to
  // one line — so every field after the first is lost.
  it("reads the whole block, not just its first line", () => {
    const e = parseEstimateBlock("## Tokenomics\neffort_days: 5\nsize_tshirt: L\n");
    expect(e.effortDays).toBe(5);
    expect(e.sizeTshirt).toBe("L");
  });

  it("stops at the next section, not at an inline HTML comment", () => {
    const e = parseEstimateBlock(`## Tokenomics
effort_days: 2
<!-- a note the planner left inline -->
size_tshirt: S

## Tasks
- [status:done] T1.1 - Something
`);
    expect(e.effortDays).toBe(2);
    expect(e.sizeTshirt).toBe("S"); // survived the comment
  });

  it("returns an empty estimate when there is no block — never a zero", () => {
    const e = parseEstimateBlock("# M1 - Thing\n\n## Description\nnothing here\n");
    expect(e.effortDays).toBeNull();
    expect(e.sizeTshirt).toBeNull();
  });

  it("ignores a non-numeric effort rather than coercing it", () => {
    expect(parseEstimateBlock("## Tokenomics\neffort_days: soon\n").effortDays).toBeNull();
  });
});

describe("readEstimate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tok-estimate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the authored estimate from the tokenomics YAML field", () => {
    const folder = join(dir, "m1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "mission.yaml"),
      [
        "name: M1 - Thing",
        "status: draft",
        "description: ''",
        "acceptance_criteria: []",
        "documents: []",
        "tokenomics:",
        "  effort_days: 3",
        "  size_tshirt: M",
        "  complexity_score: 18",
        "  self_size: L",
        "  maturity: pilot",
        "  estimated_retrospectively: true",
        "",
      ].join("\n"),
      "utf8",
    );

    const e = readEstimate(folder, "mission");
    expect(e).toMatchObject({
      effortDays: 3,
      sizeTshirt: "M",
      complexityScore: 18,
      selfSize: "L",
      maturity: "pilot",
      estimatedRetrospectively: true,
    });
  });

  it("returns an empty estimate when the YAML has no tokenomics field", () => {
    const folder = join(dir, "t1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "task.yaml"), "name: T1 - Do it\nstatus: draft\n", "utf8");
    const e = readEstimate(folder, "task");
    expect(e.effortDays).toBeNull();
    expect(e.sizeTshirt).toBeNull();
  });

  it("prefers the YAML file over a legacy Markdown block", () => {
    const folder = join(dir, "m2");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "mission.yaml"),
      "name: M2\nstatus: draft\ntokenomics:\n  effort_days: 7\n",
      "utf8",
    );
    writeFileSync(join(folder, "mission.md"), "## Tokenomics\neffort_days: 99\n", "utf8");
    expect(readEstimate(folder, "mission").effortDays).toBe(7);
  });

  it("falls back to a legacy Markdown ## Tokenomics block when no YAML exists", () => {
    const folder = join(dir, "m3");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "mission.md"),
      "# M3\n\n## Tokenomics\neffort_days: 4\nsize_tshirt: S\n",
      "utf8",
    );
    const e = readEstimate(folder, "mission");
    expect(e.effortDays).toBe(4);
    expect(e.sizeTshirt).toBe("S");
  });

  it("returns an empty estimate when neither file exists", () => {
    const folder = join(dir, "missing");
    mkdirSync(folder, { recursive: true });
    expect(readEstimate(folder, "task").effortDays).toBeNull();
  });
});
