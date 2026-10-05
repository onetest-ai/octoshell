import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { forks, PACK_SRC, store } from "./fixtures/pack-store.js";
import { installPack } from "../src/host/octobots-skill.js";
import { parsePending, pendingSummary, readPending, serializePending, writePending, type PendingRecord } from "../src/host/pack-updates.js";

interface Case { name: string; text: string; expected: { packVersion: number | null; reconcile: string[]; kept: string[] } }
const cases = (JSON.parse(readFileSync(join(__dirname, "fixtures", "pending-cases.json"), "utf8")) as { cases: Case[] }).cases;

/**
 * Every reader of pending.json must agree on `test/fixtures/pending-cases.json`. Today that is
 * pack-updates.ts; T7.5 adds the pack's `pending-io.mjs` (imported by doctor.js, validate.js and
 * pack-reconcile.mjs) to this list and it must produce the same summaries.
 */
const readers: Array<{ name: string; summary: (text: string) => Case["expected"] }> = [
  { name: "pack-updates.ts", summary: pendingSummary },
];

describe("pending.json fixture cases", () => {
  it("names the cases mission AC3 requires", () => {
    const names = cases.map((c) => c.name);
    for (const n of ["valid", "kept-only", "empty", "malformed", "rule-5-base-null", "retired-no-upstream"]) expect(names).toContain(n);
  });

  describe.each(readers)("$name", ({ summary }) => {
    it.each(cases)("parses $name to its expected {packVersion, reconcile, kept}", (c) => {
      expect(summary(c.text)).toEqual(c.expected);
    });
  });

  it("round-trips every valid case byte for byte (stable key order, one trailing newline)", () => {
    for (const c of cases.filter((x) => x.expected.packVersion !== null)) {
      const rec = parsePending(c.text)!;
      expect(serializePending(rec), c.name).toBe(c.text);
    }
  });

  it("writePending leaves the file untouched (bytes and mtime) when nothing changed", () => {
    const ws = mkdtempClean("pending-io-");
    const rec = parsePending(cases.find((c) => c.name === "valid")!.text) as PendingRecord;
    expect(writePending(ws, rec)).toBe(true);
    const file = join(ws, ".octobots", "pack-updates", "pending.json");
    const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
    expect(writePending(ws, rec)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before.text);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(readPending(ws)).toEqual(rec);
  });

  it("installPack over the malformed case replaces it from its own results", () => {
    const ws = mkdtempClean("pending-io-");
    const f = forks();
    for (const skill of ["mission-execution", "mission-completion-gate"] as const) {
      const dir = join(ws, ".claude", "skills", skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), f[skill]);
    }
    const file = join(ws, ".octobots", "pack-updates", "pending.json");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, cases.find((c) => c.name === "malformed")!.text);
    expect(readPending(ws)).toBeNull();

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending).toEqual(["mission-execution", "mission-completion-gate"]);
    const rec = readPending(ws)!;
    expect(rec.packVersion).toBe(57);
    expect(rec.skills.map((s) => s.skill)).toEqual(["mission-execution", "mission-completion-gate"]);
    expect(existsSync(join(ws, rec.skills[0]!.dir, "RECONCILE.md"))).toBe(true);
  });
});
