import { beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { forks, PACK_SRC as REAL_PACK, store, versionLine } from "./fixtures/pack-store.js";
import { installPack, OCTOBOTS_PACK_VERSION } from "../src/host/octobots-skill.js";
import { skillSha256 } from "../src/host/skill-marker.js";
import { readPending } from "../src/host/pack-updates.js";

const PACK = OCTOBOTS_PACK_VERSION;

/**
 * The pack to install from: the real one plus scripts under mission-execution, which the pack gains
 * later in M7 (qa-env.mjs, scan-parked.js). Today that skill is a lone SKILL.md, so without them
 * "the rest of the directory still installs" would be proven on mission-planner alone.
 */
let PACK_SRC = REAL_PACK;
let SKILLS = join(PACK_SRC, "skill");
beforeEach(() => {
  PACK_SRC = join(mkdtempClean("pack-reconcile-src-"), "pack");
  cpSync(REAL_PACK, PACK_SRC, { recursive: true });
  SKILLS = join(PACK_SRC, "skill");
  mk(join(SKILLS, "mission-execution", "scripts", "qa-env.mjs"), "// qa env\n");
  mk(join(SKILLS, "mission-execution", "scripts", "scan-parked.js"), "// scan parked\n");
});
const mk = (p: string, content: string | Buffer) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };

/** Every regular file under `dir`, relative path -> bytes. */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
const bytes = (ws: string, ...rel: string[]) => readFileSync(join(ws, ...rel));
const skillMd = (ws: string, skill: string) => join(ws, ".claude", "skills", skill, "SKILL.md");
const staging = (ws: string, v: number, skill: string) => join(ws, ".octobots", "pack-updates", `v${v}`, skill);
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** Every pack file of a skill's directory other than its SKILL.md must be in the workspace, byte-identical. */
function expectPackFilesInstalled(ws: string, skill: string): void {
  const pack = tree(join(SKILLS, skill));
  for (const [rel, content] of pack) {
    if (rel === "SKILL.md") continue;
    expect(existsSync(join(ws, ".claude", "skills", skill, rel)), `${skill}/${rel}`).toBe(true);
    expect(bytes(ws, ".claude", "skills", skill, rel).equals(content), `${skill}/${rel}`).toBe(true);
  }
}

const RETIRED_SCRIPTS = ["add-workflow.js", "sync-meta.js", "add-run.js", "mission-input.js", "extract-meta.mjs", "workflow-meta.mjs", "vendor/acorn.mjs", "set-step.js"];
const DESIGNER_BODY = store.bodies[store.versions["56"]!["workflow-designer"]!.at(-1)!]! + "\nA local note.\n";

/** A workspace at the pack with solo's two 57-local forks, a 57-local mission-planner and a changed retired workflow-designer. */
function soloLike(): { ws: string; f: ReturnType<typeof forks>; planner: Buffer; designer: Buffer } {
  const ws = mkdtempClean("pack-reconcile-");
  installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
  const f = forks();
  writeFileSync(skillMd(ws, "mission-execution"), f["mission-execution"]);
  writeFileSync(skillMd(ws, "mission-completion-gate"), f["mission-completion-gate"]);
  const planner = Buffer.from(versionLine(readFileSync(join(SKILLS, "mission-planner", "SKILL.md"), "utf8"), "57-local") + "\nLocal planner rule.\n");
  writeFileSync(skillMd(ws, "mission-planner"), planner);
  const scripts = join(ws, ".claude", "skills", "mission-planner", "scripts");
  for (const r of RETIRED_SCRIPTS) mk(join(scripts, r), "// retired\n");
  mk(join(scripts, "create-team.js"), "// the user's own script\n");
  writeFileSync(join(scripts, "validate.js"), "// stale validate\n");
  const designer = Buffer.from(DESIGNER_BODY);
  mk(skillMd(ws, "workflow-designer"), designer);
  mk(join(ws, ".claude", "skills", "workflow-designer", "my-notes.md"), "notes\n");
  return { ws, f, planner, designer };
}

describe("installPack: reconcile (the default)", () => {
  it("keeps every deviated SKILL.md, installs the rest of those directories, and stages them", () => {
    const { ws, f, planner, designer } = soloLike();
    const designerDir = tree(join(ws, ".claude", "skills", "workflow-designer"));

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "workflow-designer"]);
    expect(res.kept).toEqual([]);
    expect(bytes(ws, ".claude", "skills", "mission-execution", "SKILL.md").equals(f["mission-execution"])).toBe(true);
    expect(bytes(ws, ".claude", "skills", "mission-completion-gate", "SKILL.md").equals(f["mission-completion-gate"])).toBe(true);
    expect(bytes(ws, ".claude", "skills", "mission-planner", "SKILL.md").equals(planner)).toBe(true);
    for (const s of ["mission-execution", "mission-planner", "mission-completion-gate"]) expectPackFilesInstalled(ws, s);

    const scripts = join(ws, ".claude", "skills", "mission-planner", "scripts");
    for (const r of RETIRED_SCRIPTS) expect(existsSync(join(scripts, r)), r).toBe(false);
    expect(readFileSync(join(scripts, "create-team.js"), "utf8")).toBe("// the user's own script\n");

    // A retired deviated skill's directory is left whole.
    expect(tree(join(ws, ".claude", "skills", "workflow-designer"))).toEqual(designerDir);
    expect(bytes(ws, ".claude", "skills", "workflow-designer", "SKILL.md").equals(designer)).toBe(true);

    // The rest of the pack installs.
    expect(existsSync(skillMd(ws, "knowledge-explorer"))).toBe(true);
    expect(existsSync(join(ws, ".octobots", "hooks", "primer.mjs"))).toBe(true);
  });

  it("writes base/local/upstream/RECONCILE.md per skill (no upstream.md for the retired one) and pending.json", () => {
    const { ws, f, designer } = soloLike();
    installPack(PACK_SRC, ws, { store });

    for (const skill of ["mission-execution", "mission-completion-gate", "mission-planner"]) {
      expect(files(staging(ws, PACK, skill)), skill).toEqual(["RECONCILE.md", "base.md", "local.md", "upstream.md"]);
      expect(bytes(staging(ws, PACK, skill), "upstream.md").equals(bytes(SKILLS, skill, "SKILL.md")), skill).toBe(true);
    }
    expect(bytes(staging(ws, PACK, "mission-execution"), "local.md").equals(f["mission-execution"])).toBe(true);
    expect(files(staging(ws, PACK, "workflow-designer"))).toEqual(["RECONCILE.md", "base.md", "local.md"]);
    expect(bytes(staging(ws, PACK, "workflow-designer"), "local.md").equals(designer)).toBe(true);

    const rec = readPending(ws)!;
    expect(rec.packVersion).toBe(PACK);
    expect(rec.kept).toEqual([]);
    expect(rec.skills.map((s) => s.skill)).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "workflow-designer"]);
    const me = rec.skills.find((s) => s.skill === "mission-execution")!;
    expect(me).toEqual({
      skill: "mission-execution",
      action: "reconcile",
      localVersion: "57-local",
      localSha256: skillSha256(f["mission-execution"].toString("utf8")),
      base: expect.objectContaining({ version: expect.any(Number), sha256: expect.any(String), source: expect.any(String) }),
      upstreamSha256: skillSha256(readFileSync(join(SKILLS, "mission-execution", "SKILL.md"), "utf8")),
      retired: false,
      dir: `.octobots/pack-updates/v${PACK}/mission-execution`,
    });
    // The base on disk is the base the record names.
    expect(skillSha256(readFileSync(join(staging(ws, PACK, "mission-execution"), "base.md"), "utf8"))).toBe(me.base!.sha256);
    const wd = rec.skills.find((s) => s.skill === "workflow-designer")!;
    expect(wd).toMatchObject({ retired: true, upstreamSha256: null, localVersion: "56" });

    const brief = readFileSync(join(staging(ws, PACK, "mission-execution"), "RECONCILE.md"), "utf8");
    expect(brief).toContain("mission-execution");
    expect(brief).toContain("57-local");
    expect(brief).toContain(`v${PACK}`);
    expect(brief).toMatch(/octobots-doctor/);
    expect(brief).toMatch(/do not edit the live SKILL\.md/i);
    expect(readFileSync(join(staging(ws, PACK, "workflow-designer"), "RECONCILE.md"), "utf8")).toMatch(/upstream deleted it|retired/i);
  });

  it("is the default when no localChanges is given, and when 'reconcile' is given", () => {
    const a = soloLike();
    const b = soloLike();
    const ra = installPack(PACK_SRC, a.ws, { store });
    const rb = installPack(PACK_SRC, b.ws, { store, localChanges: "reconcile" });
    expect(ra.pending).toEqual(rb.pending);
    expect(ra.pending.length).toBe(4);
  });

  it("a `57+local` SKILL.md reconciled against the pack's current file is byte-identical after a re-install", () => {
    const ws = mkdtempClean("pack-reconcile-");
    installPack(PACK_SRC, ws, { store });
    const current = skillSha256(readFileSync(join(SKILLS, "mission-completion-gate", "SKILL.md"), "utf8"));
    const merged = Buffer.from(`---\nname: mission-completion-gate\nversion: ${PACK}+local\nreconciled-from: ${current}\n---\n\nmerged body\n`);
    writeFileSync(skillMd(ws, "mission-completion-gate"), merged);

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending).toEqual([]);
    expect(bytes(ws, ".claude", "skills", "mission-completion-gate", "SKILL.md").equals(merged)).toBe(true);
    expectPackFilesInstalled(ws, "mission-completion-gate");
    expect(existsSync(join(ws, ".octobots", "pack-updates"))).toBe(false);
  });

  it("a second identical install changes no byte under .octobots/pack-updates/ (bytes and mtimes)", () => {
    const { ws } = soloLike();
    installPack(PACK_SRC, ws, { store });
    const root = join(ws, ".octobots", "pack-updates");
    const old = new Date("2001-02-03T04:05:06Z");
    const stamp = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) stamp(p);
        utimesSync(p, old, old);
      }
    };
    stamp(root);
    const snap = (dir: string): Array<[string, string, number]> => {
      const out: Array<[string, string, number]> = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          out.push([relative(root, p), e.isDirectory() ? "dir" : readFileSync(p).toString("base64"), statSync(p).mtimeMs]);
          if (e.isDirectory()) walk(p);
        }
      };
      walk(dir);
      return out.sort((a, b) => a[0].localeCompare(b[0]));
    };
    const before = snap(root);
    expect(before.length).toBeGreaterThan(10);

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending.length).toBe(4);
    expect(snap(root)).toEqual(before);
    expect(readPending(ws)!.skills.length).toBe(4);
  });

  it("an edited local SKILL.md updates its one entry", () => {
    const { ws, f } = soloLike();
    installPack(PACK_SRC, ws, { store });
    const edited = Buffer.concat([f["mission-execution"], Buffer.from("\nOne more local rule.\n")]);
    writeFileSync(skillMd(ws, "mission-execution"), edited);

    installPack(PACK_SRC, ws, { store });

    const rec = readPending(ws)!;
    const mine = rec.skills.filter((s) => s.skill === "mission-execution");
    expect(mine.length).toBe(1);
    expect(mine[0]!.localSha256).toBe(skillSha256(edited.toString("utf8")));
    expect(bytes(staging(ws, PACK, "mission-execution"), "local.md").equals(edited)).toBe(true);
    expect(files(join(ws, ".octobots", "pack-updates"))).toEqual([".gitignore", "pending.json", `v${PACK}`]);
    expect(rec.skills.length).toBe(4);
  });

  it("an entry whose skill is no longer deviated is dropped", () => {
    const { ws } = soloLike();
    installPack(PACK_SRC, ws, { store });
    writeFileSync(skillMd(ws, "mission-execution"), readFileSync(join(SKILLS, "mission-execution", "SKILL.md")));

    const res = installPack(PACK_SRC, ws, { store });

    expect(res.pending).not.toContain("mission-execution");
    expect(readPending(ws)!.skills.map((s) => s.skill)).not.toContain("mission-execution");
  });

  describe("a newer pack version or a later build re-stages the entry", () => {
    const OPEN = "- ESCALATED: xfail rule: local counts 0 xfailed; upstream allows a stated reason; question may a stated xfail pass?";
    const DECISIONS = `# Decisions\n\n## Conflicts\n${OPEN}\n- RESOLVED: model tiering: kept local\n`;

    function staged() {
      const s = soloLike();
      installPack(PACK_SRC, s.ws, { store });
      const dir = staging(s.ws, PACK, "mission-completion-gate");
      writeFileSync(join(dir, "DECISIONS.md"), DECISIONS);
      writeFileSync(join(dir, "merged.md"), "half merged\n");
      return { ...s, dir };
    }

    it("packVersion 58: new folder, old inputs deleted, old DECISIONS.md kept, open questions carried over", () => {
      const { ws, dir } = staged();

      installPack(PACK_SRC, ws, { store, packVersion: PACK + 1 });

      expect(files(dir)).toEqual(["DECISIONS.md"]);
      expect(readFileSync(join(dir, "DECISIONS.md"), "utf8")).toBe(DECISIONS);
      const next = staging(ws, PACK + 1, "mission-completion-gate");
      expect(files(next)).toEqual(["RECONCILE.md", "base.md", "local.md", "upstream.md"]);
      const brief = readFileSync(join(next, "RECONCILE.md"), "utf8");
      expect(brief).toContain(`Carried over from v${PACK}:`);
      expect(brief).toContain(OPEN);
      expect(brief).not.toContain("RESOLVED: model tiering");
      // A skill with no log leaves no empty folder behind.
      expect(existsSync(staging(ws, PACK, "mission-execution"))).toBe(false);
      const rec = readPending(ws)!;
      expect(rec.packVersion).toBe(PACK + 1);
      expect(rec.skills.map((s) => s.dir)).toContain(`.octobots/pack-updates/v${PACK + 1}/mission-completion-gate`);
      expect(rec.skills.length).toBe(4);
    });

    it("a later build of 57 (a changed pack SKILL.md): same folder re-staged, merged.md gone, log kept, questions carried over", () => {
      const { ws, dir } = staged();
      const later = mkdtempClean("pack-later-");
      cpSync(PACK_SRC, later, { recursive: true });
      const upstream = join(later, "skill", "mission-completion-gate", "SKILL.md");
      writeFileSync(upstream, readFileSync(upstream, "utf8") + "\nA later build.\n");

      installPack(later, ws, { store });

      expect(files(dir)).toEqual(["DECISIONS.md", "RECONCILE.md", "base.md", "local.md", "upstream.md"]);
      expect(readFileSync(join(dir, "upstream.md"), "utf8")).toBe(readFileSync(upstream, "utf8"));
      expect(readFileSync(join(dir, "DECISIONS.md"), "utf8")).toBe(DECISIONS);
      const brief = readFileSync(join(dir, "RECONCILE.md"), "utf8");
      expect(brief).toContain(`Carried over from v${PACK}:`);
      expect(brief).toContain(OPEN);
      const entry = readPending(ws)!.skills.find((s) => s.skill === "mission-completion-gate")!;
      expect(entry.upstreamSha256).toBe(skillSha256(readFileSync(upstream, "utf8")));
    });

    it("a second install after that changes nothing, so the carried-over block is not doubled", () => {
      const { ws, dir } = staged();
      const later = mkdtempClean("pack-later-");
      cpSync(PACK_SRC, later, { recursive: true });
      const upstream = join(later, "skill", "mission-completion-gate", "SKILL.md");
      writeFileSync(upstream, readFileSync(upstream, "utf8") + "\nA later build.\n");
      installPack(later, ws, { store });
      const brief = readFileSync(join(dir, "RECONCILE.md"), "utf8");

      installPack(later, ws, { store });

      expect(readFileSync(join(dir, "RECONCILE.md"), "utf8")).toBe(brief);
      expect(brief.split(`Carried over from v${PACK}:`).length - 1).toBe(1);
    });

    it("keeps a carried-over question alive across a second bump when the agent never ran", () => {
      const { ws } = staged();
      installPack(PACK_SRC, ws, { store, packVersion: PACK + 1 });
      installPack(PACK_SRC, ws, { store, packVersion: PACK + 2 });
      const brief = readFileSync(join(staging(ws, PACK + 2, "mission-completion-gate"), "RECONCILE.md"), "utf8");
      expect(brief).toContain(`Carried over from v${PACK}:`);
      expect(brief).toContain(OPEN);
    });
  });

  it("git check-ignore ignores base.md, overwritten-local.md and pending.json and not DECISIONS.md", () => {
    const { ws } = soloLike();
    execFileSync("git", ["init", "-q"], { cwd: ws });
    installPack(PACK_SRC, ws, { store });
    const dir = staging(ws, PACK, "mission-execution");
    for (const f of ["DECISIONS.md", "UPSTREAM-CANDIDATES.md", "overwritten-local.md", "merged.md"]) writeFileSync(join(dir, f), "x\n");
    const ignored = (rel: string): boolean => {
      try { execFileSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: ws }); return true; } catch { return false; }
    };
    const rel = `.octobots/pack-updates/v${PACK}/mission-execution`;
    expect(ignored(`${rel}/base.md`)).toBe(true);
    expect(ignored(`${rel}/local.md`)).toBe(true);
    expect(ignored(`${rel}/overwritten-local.md`)).toBe(true);
    expect(ignored(`${rel}/merged.md`)).toBe(true);
    expect(ignored(".octobots/pack-updates/pending.json")).toBe(true);
    expect(ignored(`${rel}/DECISIONS.md`)).toBe(false);
    expect(ignored(`${rel}/UPSTREAM-CANDIDATES.md`)).toBe(false);
    expect(ignored(".octobots/pack-updates/.gitignore")).toBe(false);
  });
});

describe("installPack: overwrite and keep", () => {
  const OPEN_LOG = "# Decisions\n- ESCALATED: xfail rule: local a; upstream b; question c?\n";

  it("overwrite saves overwritten-local.md, replaces or deletes, drops the entries and deletes the input files", () => {
    const { ws, f, designer } = soloLike();
    installPack(PACK_SRC, ws, { store }); // stage first
    const meDir = staging(ws, PACK, "mission-execution");
    writeFileSync(join(meDir, "merged.md"), "half merged\n");

    const res = installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });

    expect(res.pending).toEqual([]);
    expect(res.kept).toEqual([]);
    expect(bytes(meDir, "overwritten-local.md").equals(f["mission-execution"])).toBe(true);
    expect(bytes(staging(ws, PACK, "mission-completion-gate"), "overwritten-local.md").equals(f["mission-completion-gate"])).toBe(true);
    expect(bytes(staging(ws, PACK, "workflow-designer"), "overwritten-local.md").equals(designer)).toBe(true);
    for (const s of ["mission-execution", "mission-completion-gate", "mission-planner"]) {
      expect(bytes(ws, ".claude", "skills", s, "SKILL.md").equals(bytes(SKILLS, s, "SKILL.md")), s).toBe(true);
    }
    expect(existsSync(skillMd(ws, "workflow-designer"))).toBe(false);
    expect(files(meDir)).toEqual(["overwritten-local.md"]);
    const rec = readPending(ws)!;
    expect(rec.skills).toEqual([]);
    expect(rec.kept).toEqual([]);
  });

  it("overwrite without a prior staging still saves the local file first", () => {
    const { ws, f } = soloLike();
    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
    expect(bytes(staging(ws, PACK, "mission-execution"), "overwritten-local.md").equals(f["mission-execution"])).toBe(true);
    expect(existsSync(join(ws, ".octobots", "pack-updates", "v57", "mission-execution", "local.md"))).toBe(false);
  });

  it("keep records kept, stages nothing, leaves the files and deletes the input files", () => {
    const { ws, f, planner, designer } = soloLike();
    installPack(PACK_SRC, ws, { store });
    writeFileSync(join(staging(ws, PACK, "mission-execution"), "merged.md"), "half merged\n");

    const res = installPack(PACK_SRC, ws, { store, localChanges: "keep" });

    expect(res.pending).toEqual([]);
    expect(res.kept).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "workflow-designer"]);
    const rec = readPending(ws)!;
    expect(rec.skills).toEqual([]);
    expect(rec.kept).toEqual([
      { skill: "mission-planner", packVersion: PACK, sha256: skillSha256(planner.toString("utf8")) },
      { skill: "mission-execution", packVersion: PACK, sha256: skillSha256(f["mission-execution"].toString("utf8")) },
      { skill: "mission-completion-gate", packVersion: PACK, sha256: skillSha256(f["mission-completion-gate"].toString("utf8")) },
      { skill: "workflow-designer", packVersion: PACK, sha256: skillSha256(designer.toString("utf8")) },
    ]);
    expect(bytes(ws, ".claude", "skills", "mission-execution", "SKILL.md").equals(f["mission-execution"])).toBe(true);
    expect(bytes(ws, ".claude", "skills", "workflow-designer", "SKILL.md").equals(designer)).toBe(true);
    expectPackFilesInstalled(ws, "mission-execution");
    expect(existsSync(join(ws, ".octobots", "pack-updates", `v${PACK}`))).toBe(false); // nothing left to hold
  });

  describe("Keep my changes is remembered (T7.4 AC3)", () => {
    const keptAll = () => {
      const w = soloLike();
      installPack(PACK_SRC, w.ws, { store, localChanges: "keep" });
      return w;
    };
    const state = (ws: string) => tree(join(ws, ".octobots", "pack-updates"));

    it("a default install (no localChanges) leaves every kept skill kept: not staged, not pending, byte-identical", () => {
      const { ws, f } = keptAll();
      const before = state(ws);
      const res = installPack(PACK_SRC, ws, { store });
      expect(res.pending).toEqual([]);
      expect(res.kept).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "workflow-designer"]);
      const rec = readPending(ws)!;
      expect(rec.skills).toEqual([]);
      expect(rec.kept.map((k) => k.skill)).toEqual(res.kept);
      expect(rec.kept.find((k) => k.skill === "mission-execution")).toEqual({
        skill: "mission-execution", packVersion: PACK, sha256: skillSha256(f["mission-execution"].toString("utf8")),
      });
      expect(bytes(ws, ".claude", "skills", "mission-execution", "SKILL.md").equals(f["mission-execution"])).toBe(true);
      expect(files(join(ws, ".octobots", "pack-updates")).filter((n) => n.startsWith("v"))).toEqual([]);
      expect(state(ws)).toEqual(before);
      expectPackFilesInstalled(ws, "mission-execution");
    });

    it("stays kept across repeated default installs", () => {
      const { ws } = keptAll();
      installPack(PACK_SRC, ws, { store });
      const before = state(ws);
      installPack(PACK_SRC, ws, { store });
      expect(state(ws)).toEqual(before);
      expect(readPending(ws)!.kept.length).toBe(4);
    });

    it("an explicit 'reconcile' re-opens a kept skill and stages it", () => {
      const { ws } = keptAll();
      const res = installPack(PACK_SRC, ws, { store, localChanges: "reconcile" });
      expect(res.pending).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "workflow-designer"]);
      expect(res.kept).toEqual([]);
      expect(readPending(ws)!.kept).toEqual([]);
    });

    it("an explicit 'overwrite' replaces a kept skill", () => {
      const { ws } = keptAll();
      installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
      expect(bytes(ws, ".claude", "skills", "mission-execution", "SKILL.md").equals(readFileSync(join(SKILLS, "mission-execution", "SKILL.md")))).toBe(true);
      expect(readPending(ws)!.kept).toEqual([]);
    });

    it("a kept skill whose fork bytes changed is re-opened by a default install", () => {
      const { ws, f } = keptAll();
      writeFileSync(skillMd(ws, "mission-execution"), Buffer.concat([f["mission-execution"], Buffer.from("\nAnother local rule.\n")]));
      const res = installPack(PACK_SRC, ws, { store });
      expect(res.pending).toEqual(["mission-execution"]);
      expect(res.kept).toEqual(["mission-planner", "mission-completion-gate", "workflow-designer"]);
      expect(readPending(ws)!.kept.map((k) => k.skill)).not.toContain("mission-execution");
    });

    it("a kept skill the user reverted to the pack's file is no longer recorded", () => {
      const { ws } = keptAll();
      writeFileSync(skillMd(ws, "mission-execution"), readFileSync(join(SKILLS, "mission-execution", "SKILL.md")));
      const res = installPack(PACK_SRC, ws, { store });
      expect(res.kept).not.toContain("mission-execution");
      expect(readPending(ws)!.kept.map((k) => k.skill)).not.toContain("mission-execution");
    });

    it("keeps its original packVersion on a later pack version (the activation prompt then asks again)", () => {
      const { ws } = keptAll();
      const res = installPack(PACK_SRC, ws, { store, packVersion: PACK + 1 });
      expect(res.pending).toEqual([]);
      expect(readPending(ws)!.kept.every((k) => k.packVersion === PACK)).toBe(true);
    });

    it("a skill that was pending and a skill that was kept coexist: only the pending one is re-staged", () => {
      const { ws, f } = soloLike();
      installPack(PACK_SRC, ws, { store }); // all four staged
      // keep two, leave two pending: simulate by keeping everything, then re-forking one skill
      installPack(PACK_SRC, ws, { store, localChanges: "keep" });
      writeFileSync(skillMd(ws, "mission-completion-gate"), Buffer.concat([f["mission-completion-gate"], Buffer.from("\nNew.\n")]));
      const res = installPack(PACK_SRC, ws, { store });
      expect(res.pending).toEqual(["mission-completion-gate"]);
      expect(res.kept).toEqual(["mission-planner", "mission-execution", "workflow-designer"]);
    });
  });

  it("keep on a fresh workspace stages nothing at all", () => {
    const { ws } = soloLike();
    installPack(PACK_SRC, ws, { store, localChanges: "keep" });
    expect(files(join(ws, ".octobots", "pack-updates")).filter((n) => n.startsWith("v"))).toEqual([]);
  });

  it.each(["overwrite", "keep"] as const)("%s leaves a DECISIONS.md with an open ESCALATED entry byte-identical", (choice) => {
    const { ws } = soloLike();
    installPack(PACK_SRC, ws, { store });
    const log = join(staging(ws, PACK, "mission-completion-gate"), "DECISIONS.md");
    const cand = join(staging(ws, PACK, "mission-completion-gate"), "UPSTREAM-CANDIDATES.md");
    writeFileSync(log, OPEN_LOG);
    writeFileSync(cand, "- rule: why\n");
    const old = new Date("2001-02-03T04:05:06Z");
    utimesSync(log, old, old);

    installPack(PACK_SRC, ws, { store, localChanges: choice });

    expect(readFileSync(log, "utf8")).toBe(OPEN_LOG);
    expect(statSync(log).mtimeMs).toBe(old.getTime());
    expect(readFileSync(cand, "utf8")).toBe("- rule: why\n");
  });

  it("a second overwrite of a changed skill never replaces an earlier overwritten-local.md", () => {
    const { ws, f } = soloLike();
    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });
    const second = Buffer.from(versionLine(f["mission-execution"].toString("utf8"), "57-local") + "\nSecond fork.\n");
    writeFileSync(skillMd(ws, "mission-execution"), second);

    installPack(PACK_SRC, ws, { store, localChanges: "overwrite" });

    const dir = staging(ws, PACK, "mission-execution");
    const saved = files(dir).map((n) => readFileSync(join(dir, n)));
    expect(saved.some((b) => b.equals(f["mission-execution"]))).toBe(true);
    expect(saved.some((b) => b.equals(second))).toBe(true);
  });
});

describe("installPack: skills the install leaves alone", () => {
  it("a newer skill is untouched by every choice", () => {
    for (const choice of ["reconcile", "overwrite", "keep"] as const) {
      const ws = mkdtempClean("pack-reconcile-");
      installPack(PACK_SRC, ws, { store });
      const newer = Buffer.from(versionLine(readFileSync(skillMd(ws, "mission-execution"), "utf8"), `${PACK + 1}`) + "\nfrom the future\n");
      writeFileSync(skillMd(ws, "mission-execution"), newer);
      const scripts = tree(join(ws, ".claude", "skills", "mission-execution"));

      const res = installPack(PACK_SRC, ws, { store, localChanges: choice });

      expect(tree(join(ws, ".claude", "skills", "mission-execution")), choice).toEqual(scripts);
      expect(res.pending, choice).toEqual([]);
      expect(res.kept, choice).toEqual([]);
    }
  });

  it("a reconciled skill's SKILL.md is not replaced by reconcile or keep", () => {
    for (const choice of ["reconcile", "keep"] as const) {
      const ws = mkdtempClean("pack-reconcile-");
      installPack(PACK_SRC, ws, { store });
      const current = skillSha256(readFileSync(join(SKILLS, "mission-execution", "SKILL.md"), "utf8"));
      const merged = Buffer.from(`---\nname: mission-execution\nversion: ${PACK}+local\nreconciled-from: ${current}\n---\n\nmerged\n`);
      writeFileSync(skillMd(ws, "mission-execution"), merged);
      installPack(PACK_SRC, ws, { store, localChanges: choice });
      expect(bytes(ws, ".claude", "skills", "mission-execution", "SKILL.md").equals(merged), choice).toBe(true);
    }
  });
});
