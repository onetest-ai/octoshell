import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMarker as parseMjs, withoutReconciledFrom as stripMjs } from "../resources/octobots-pack/skill/mission-planner/scripts/skill-marker.mjs";
import { parseSkillMarker as parseTs, withoutReconciledFrom as stripTs, type SkillMarker } from "../src/host/skill-marker.js";

const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const HASH = "a".repeat(64);

type Expected = Omit<SkillMarker, "sha256">;
interface Case {
  name: string;
  text: string;
  expected: Expected;
}

const fm = (...lines: string[]) => `---\nname: x\n${lines.join("\n")}${lines.length ? "\n" : ""}---\n\n# Body\n`;

/** The one case table both runtimes are driven from. Expected values are literals, not recomputed. */
const CASES: Case[] = [
  { name: "plain integer", text: fm("version: 57"), expected: { label: "57", n: 57, kind: "integer", reconciledFrom: null } },
  { name: "57-local fork label", text: fm("version: 57-local"), expected: { label: "57-local", n: 57, kind: "label", reconciledFrom: null } },
  { name: "57+local without reconciled-from", text: fm("version: 57+local"), expected: { label: "57+local", n: 57, kind: "plus-local", reconciledFrom: null } },
  {
    name: "57+local with reconciled-from",
    text: fm("version: 57+local", `reconciled-from: ${HASH}`),
    expected: { label: "57+local", n: 57, kind: "plus-local", reconciledFrom: HASH },
  },
  { name: "trailing spaces and tabs", text: fm("version: 57   \t", `reconciled-from:   ${HASH}  `), expected: { label: "57", n: 57, kind: "integer", reconciledFrom: HASH } },
  { name: "CRLF file", text: fm("version: 57", `reconciled-from: ${HASH}`).replace(/\n/g, "\r\n"), expected: { label: "57", n: 57, kind: "integer", reconciledFrom: HASH } },
  { name: "frontmatter without a version line", text: fm(), expected: { label: null, n: null, kind: "none", reconciledFrom: null } },
  { name: "no frontmatter at all", text: "# Just a body\n", expected: { label: null, n: null, kind: "none", reconciledFrom: null } },
  {
    name: "version: line only in the body",
    text: `---\nname: x\n---\n\nversion: 57\n`,
    expected: { label: null, n: null, kind: "none", reconciledFrom: null },
  },
  { name: "reconciled-from only in the body", text: `---\nname: x\nversion: 57\n---\nreconciled-from: ${HASH}\n`, expected: { label: "57", n: 57, kind: "integer", reconciledFrom: null } },
  { name: "first version line wins", text: fm("version: 56", "version: 57"), expected: { label: "56", n: 56, kind: "integer", reconciledFrom: null } },
  { name: "empty version value", text: fm("version:"), expected: { label: null, n: null, kind: "none", reconciledFrom: null } },
  { name: "label without a leading integer", text: fm("version: draft"), expected: { label: "draft", n: null, kind: "label", reconciledFrom: null } },
  { name: "57-fork style label", text: fm("version: 58-fork"), expected: { label: "58-fork", n: 58, kind: "label", reconciledFrom: null } },
  { name: "BOM before the frontmatter", text: `\uFEFF${fm("version: 57")}`, expected: { label: "57", n: 57, kind: "integer", reconciledFrom: null } },
  { name: "frontmatter that never closes", text: `---\nversion: 57\nbody\n`, expected: { label: null, n: null, kind: "none", reconciledFrom: null } },
  { name: "frontmatter closing at end of file", text: `---\nversion: 57\n---`, expected: { label: "57", n: 57, kind: "integer", reconciledFrom: null } },
];

describe("skill-marker: one rule, two runtimes", () => {
  for (const c of CASES) {
    it(`${c.name}: skill-marker.ts and skill-marker.mjs agree on {label, n, kind, reconciledFrom, sha256}`, () => {
      const want = { ...c.expected, sha256: sha(c.text) };
      expect(parseTs(c.text)).toEqual(want);
      expect(parseMjs(c.text)).toEqual(want);
    });
  }

  it("a CRLF file and its LF twin hash alike in both runtimes", () => {
    const lf = fm("version: 57");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(parseTs(crlf).sha256).toBe(parseTs(lf).sha256);
    expect(parseMjs(crlf).sha256).toBe(parseMjs(lf).sha256);
    expect(parseTs(lf).sha256).toBe(parseMjs(lf).sha256);
  });

  it("a one-byte edit changes the hash", () => {
    expect(parseTs(fm("version: 57")).sha256).not.toBe(parseTs(fm("version: 57") + " ").sha256);
  });

  describe("withoutReconciledFrom", () => {
    const H = "a".repeat(64);
    const keep = [
      `// octobots-reconciled-from: ${"a".repeat(65)}\n`,
      `doWork(); // octobots-reconciled-from: ${H}\n`,
      `// octobots-reconciled-from: ${H} and more\n`,
      `const s = "octobots-reconciled-from: ${H}";\n`,
      `// octobots-reconciled-from: ${"a".repeat(63)}\n`,
      "no marker\n",
    ];
    const strip: [string, string][] = [
      [`#!/usr/bin/env node\n// octobots-reconciled-from: ${H}\ncode\n`, "#!/usr/bin/env node\ncode\n"],
      [`# octobots-reconciled-from: ${H}\r\nx\r\n`, "x\r\n"],
      [`<!-- octobots-reconciled-from: ${H} -->\nbody\n`, "body\n"],
      [`// octobots-reconciled-from: ${H}\n// octobots-reconciled-from: ${H}\n`, `// octobots-reconciled-from: ${H}\n`],
    ];
    for (const [input, want] of strip) {
      it(`strips the marker line: ${JSON.stringify(input.slice(0, 40))}`, () => {
        expect(stripTs(input)).toBe(want);
        expect(stripMjs(input)).toBe(want);
      });
    }
    for (const t of keep) {
      it(`leaves local content alone: ${JSON.stringify(t.slice(0, 50))}`, () => {
        expect(stripTs(t)).toBe(t);
        expect(stripMjs(t)).toBe(t);
      });
    }

    // pack-reconcile.mjs holds its own copy: it must load beside a kept v61 skill-marker.mjs, which
    // lacks withoutReconciledFrom. It cannot be imported (it runs on load), so its text is read.
    describe("pack-reconcile.mjs's own copy of the pattern", () => {
      const root = join(__dirname, "..");
      const read = (rel: string) => readFileSync(join(root, rel), "utf8");
      const copy = read("resources/octobots-pack/skill/octobots-doctor/scripts/pack-reconcile.mjs").match(/^const MARKER_LINE = \/(.+)\/m;$/m)?.[1];
      it("is the twins' pattern, character for character", () => {
        const twin = (rel: string) => read(rel).match(/return text\.replace\(\/(.+)\/m, ""\);/)?.[1];
        expect(copy).toBeTypeOf("string");
        expect(copy).toBe(twin("src/host/skill-marker.ts"));
        expect(copy).toBe(twin("resources/octobots-pack/skill/mission-planner/scripts/skill-marker.mjs"));
      });
      it("decides every case of the table as the twins do", () => {
        const re = new RegExp(copy ?? "(?!)", "m");
        for (const [input, want] of strip) expect(input.replace(re, "")).toBe(want);
        for (const t of keep) expect(re.test(t), t).toBe(false);
      });
    });
  });
});
