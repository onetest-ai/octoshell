import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { forks, PACK_SRC, store } from "./fixtures/pack-store.js";
import { installPack } from "../src/host/octobots-skill.js";
import { parsePending, pendingSummary, readPending, serializePending, writePending, type PendingRecord } from "../src/host/pack-updates.js";
import { clearInputs } from "../src/host/pack-staging.js";
import * as packIo from "../resources/octobots-pack/skill/mission-planner/scripts/pending-io.mjs";

interface Case { name: string; text: string; expected: { packVersion: number | null; reconcile: string[]; kept: string[] } }
const cases = (JSON.parse(readFileSync(join(__dirname, "fixtures", "pending-cases.json"), "utf8")) as { cases: Case[] }).cases;

/**
 * Every reader of pending.json must agree on `test/fixtures/pending-cases.json`: pack-updates.ts and
 * the pack's `pending-io.mjs` (imported by doctor.js, validate.js and pack-reconcile.mjs). The
 * primer's twin (`hooks/primer.mjs`, which cannot import either) is driven through the script itself
 * in its own describe below: it surfaces only the pending skills and the record's pack version.
 */
const readers: Array<{ name: string; summary: (text: string) => Case["expected"] }> = [
  { name: "pack-updates.ts", summary: pendingSummary },
  { name: "pending-io.mjs", summary: packIo.pendingSummary as (text: string) => Case["expected"] },
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

  describe("primer.mjs twin (hooks/primer.mjs reads the same fixture cases through the script)", () => {
    const PRIMER = join(__dirname, "..", "resources", "octobots-pack", "hooks", "primer.mjs");

    /** The primer's reading of `text`: the skills and pack version of its "Pending pack reconciles" sentence. */
    function primerReads(text: string): { packVersion: number | null; reconcile: string[] } {
      const ws = mkdtempClean("primer-twin-");
      mkdirSync(join(ws, ".octobots", "pack-updates"), { recursive: true });
      writeFileSync(join(ws, ".octobots", "pack-updates", "pending.json"), text);
      const out = execFileSync("node", [PRIMER, "--backend", "claude"], {
        cwd: ws,
        env: { ...process.env, CLAUDE_PROJECT_DIR: ws, CLAUDE_CONFIG_DIR: "" },
        input: JSON.stringify({ hook_event_name: "SessionStart" }),
        encoding: "utf8",
      });
      const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      const m = /Pending pack reconciles: (.+) \(\.octobots\/pack-updates\/v(\d+)\/\)\./.exec(ctx);
      return m ? { packVersion: Number(m[2]), reconcile: m[1]!.split(", ") } : { packVersion: null, reconcile: [] };
    }

    it.each(cases)("reads $name to the fixture's pending skills", (c) => {
      const read = primerReads(c.text);
      expect(read.reconcile).toEqual(c.expected.reconcile);
      // The pack version only shows when there is a sentence to carry it.
      expect(read.packVersion).toBe(c.expected.reconcile.length ? c.expected.packVersion : null);
    });

    // A case with no pending entry looks the same to the primer whether it is well formed or not (no
    // sentence either way), so each case is also read with one valid entry added: then the primer
    // shows a sentence exactly when pack-updates.ts accepts the record, which catches a primer that
    // stopped rejecting what makes such a case malformed (a bad kept entry, say).
    const PROBE = {
      skill: "knowledge-explorer",
      action: "reconcile",
      localVersion: "57-local",
      localSha256: "d".repeat(64),
      base: null,
      upstreamSha256: "e".repeat(64),
      retired: false,
      dir: ".octobots/pack-updates/v57/knowledge-explorer",
    };
    const probed = cases.flatMap((c) => {
      let raw: unknown;
      try { raw = JSON.parse(c.text); } catch { return []; }
      if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { skills?: unknown }).skills)) return [];
      const r = raw as { skills: unknown[] };
      return [{ name: c.name, text: JSON.stringify({ ...r, skills: [...r.skills, PROBE] }) }];
    });

    it("probes every case the primer would otherwise see as silent", () => {
      expect(probed.map((p) => p.name)).toEqual(expect.arrayContaining(["kept-only", "malformed-kept-skill-name-is-a-path"]));
    });

    it.each(probed)("reads $name plus one valid entry as pack-updates.ts does", (p) => {
      const host = pendingSummary(p.text);
      const read = primerReads(p.text);
      expect(read.reconcile).toEqual(host.reconcile);
      expect(read.packVersion).toBe(host.reconcile.length ? host.packVersion : null);
    });
  });

  it("round-trips every valid case byte for byte (stable key order, one trailing newline)", () => {
    for (const c of cases.filter((x) => x.expected.packVersion !== null)) {
      const rec = parsePending(c.text)!;
      expect(serializePending(rec), c.name).toBe(c.text);
    }
  });

  it("pending-io.mjs serializes every valid case byte-identical to pack-updates.ts", () => {
    for (const c of cases.filter((x) => x.expected.packVersion !== null)) {
      expect(packIo.serializePending(packIo.parsePending(c.text)), c.name).toBe(serializePending(parsePending(c.text)!));
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

  // Review of T7.3 (PoC): an entry's `dir` from a hand-edited pending.json was joined to the
  // workspace root and its "inputs" deleted there, so `../victim` deleted files outside the workspace.
  it.each([
    ["../victim", "outside the workspace"],
    [".octobots/campaigns/c1", "the board"],
  ])("a pending.json entry whose dir is %s (%s) is malformed and steers no delete", (dir) => {
    const root = mkdtempClean("pending-io-");
    const ws = join(root, "ws");
    const target = join(ws, ...dir.split("/"));
    mkdirSync(target, { recursive: true });
    for (const f of ["local.md", "RECONCILE.md", "base.md"]) writeFileSync(join(target, f), "precious\n");
    const f = forks();
    const skillDir = join(ws, ".claude", "skills", "mission-execution");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), f["mission-execution"]);
    const file = join(ws, ".octobots", "pack-updates", "pending.json");
    mkdirSync(join(file, ".."), { recursive: true });
    const crafted = JSON.parse(cases.find((c) => c.name === "rule-5-base-null")!.text) as { skills: Array<{ dir: string }> };
    crafted.skills[0]!.dir = dir;
    writeFileSync(file, JSON.stringify(crafted, null, 2) + "\n");
    expect(readPending(ws)).toBeNull();

    for (const localChanges of ["keep", "overwrite", "reconcile"] as const) {
      installPack(PACK_SRC, ws, { store, localChanges, packVersion: 58 });
      for (const name of ["local.md", "RECONCILE.md", "base.md"]) expect(readFileSync(join(target, name), "utf8"), `${localChanges} ${name}`).toBe("precious\n");
    }
    // And the staging helpers refuse such a folder even when handed one directly.
    clearInputs(ws, dir);
    expect(readFileSync(join(target, "local.md"), "utf8")).toBe("precious\n");
  });

  it("writePending replaces the file through a rename and leaves no temp file behind", () => {
    const ws = mkdtempClean("pending-io-");
    const rec = parsePending(cases.find((c) => c.name === "valid")!.text) as PendingRecord;
    writePending(ws, rec);
    writePending(ws, { ...rec, kept: [] });
    const dir = join(ws, ".octobots", "pack-updates");
    expect(readdirSync(dir)).toEqual(["pending.json"]);
    expect(readPending(ws)?.kept).toEqual([]);
  });
});
