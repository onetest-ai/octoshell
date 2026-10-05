import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSkillMarker as parseMjs } from "../resources/octobots-pack/skill/mission-planner/scripts/skill-marker.mjs";
import { parseSkillMarker as parseTs, type SkillMarker } from "../src/host/skill-marker.js";

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
});
