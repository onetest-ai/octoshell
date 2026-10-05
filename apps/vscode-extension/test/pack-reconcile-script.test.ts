// pack-reconcile.mjs (octobots-doctor's `done` gate, M7-AC7 / T7.6-AC2), run as an agent runs it:
// `node <workspace>/.claude/skills/octobots-doctor/scripts/pack-reconcile.mjs list | done <skill>`.
// The workspace is built by hand (the two pack skills it needs copied into .claude/skills, a
// pending.json and its staging folders), so each case states exactly the record it starts from.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { PACK_SRC } from "./fixtures/pack-store.js";
import { OCTOBOTS_SKILLS } from "../src/host/octobots-skill.js";
import { RETIRED_SKILLS } from "../src/host/pack-skills.js";

const SCRIPT_REL = [".claude", "skills", "octobots-doctor", "scripts", "pack-reconcile.mjs"];
const SKILL = "mission-completion-gate";
const RETIRED = "workflow-designer";
const UPSTREAM = "---\nname: mission-completion-gate\nversion: 57\n---\n\n# Gate\n\nUpstream text.\n";
const UPSTREAM_SHA = createHash("sha256").update(UPSTREAM).digest("hex");
const LOCAL = "---\nname: mission-completion-gate\nversion: 57-local\n---\n\n# Gate\n\nLocal text.\n";
const CLOSED = "# Decisions\n\n## Kept local\n\n- RESOLVED: green rule: local's stricter rule\n\n## Taken from upstream\n\n## Conflicts\n";
const OPEN = "# Decisions\n\n## Kept local\n\n## Taken from upstream\n\n## Conflicts\n\n- ESCALATED: green rule: local 0 xfailed; upstream an xfail with a reason is green; question which?\n";

const mk = (p: string, content: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
const staging = (ws: string, skill: string) => join(ws, ".octobots", "pack-updates", "v57", skill);
const pendingPath = (ws: string) => join(ws, ".octobots", "pack-updates", "pending.json");
const liveMd = (ws: string, skill: string) => join(ws, ".claude", "skills", skill, "SKILL.md");

function entry(skill: string, retired: boolean) {
  return {
    skill,
    action: "reconcile",
    localVersion: "57-local",
    localSha256: "a".repeat(64),
    base: { version: 56, sha256: "b".repeat(64), source: "workspace-git" },
    upstreamSha256: retired ? null : UPSTREAM_SHA,
    retired,
    dir: `.octobots/pack-updates/v57/${skill}`,
  };
}

/** A workspace with the pack's doctor + planner skills installed and two pending entries: a pack skill and a retired one. */
function workspace(): string {
  const ws = mkdtempClean("pack-reconcile-ws-");
  for (const s of ["octobots-doctor", "mission-planner"]) {
    cpSync(join(PACK_SRC, "skill", s), join(ws, ".claude", "skills", s), { recursive: true });
  }
  mk(liveMd(ws, SKILL), LOCAL);
  mk(liveMd(ws, RETIRED), "---\nname: workflow-designer\nversion: 56\n---\n\nLocal designer.\n");
  for (const [s, retired] of [[SKILL, false], [RETIRED, true]] as const) {
    const d = staging(ws, s);
    mk(join(d, "local.md"), LOCAL);
    mk(join(d, "base.md"), "base\n");
    mk(join(d, "RECONCILE.md"), `# Reconcile ${s} (pack v57)\n`);
    if (!retired) mk(join(d, "upstream.md"), UPSTREAM);
  }
  mk(pendingPath(ws), JSON.stringify({ packVersion: 57, skills: [entry(SKILL, false), entry(RETIRED, true)], kept: [] }, null, 2) + "\n");
  return ws;
}

/** Runs the workspace's installed script from an unrelated cwd (never the workspace). */
function run(ws: string, ...args: string[]) {
  const cwd = mkdtempClean("pack-reconcile-cwd-");
  const r = spawnSync("node", [join(ws, ...SCRIPT_REL), ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const reconciled = (ws: string, label = "57+local", from = UPSTREAM_SHA) =>
  writeFileSync(liveMd(ws, SKILL), `---\nname: mission-completion-gate\nversion: ${label}\nreconciled-from: ${from}\n---\n\n# Gate\n\nMerged text.\n`);
const decisions = (ws: string, skill: string, text: string) => writeFileSync(join(staging(ws, skill), "DECISIONS.md"), text);
const pendingSkills = (ws: string): string[] => (JSON.parse(readFileSync(pendingPath(ws), "utf8")) as { skills: Array<{ skill: string }> }).skills.map((s) => s.skill);

describe("pack-reconcile.mjs list", () => {
  it("prints every pending entry with its folder, and the reconciled-from value for a pack skill", () => {
    const ws = workspace();
    const r = run(ws, "list");
    expect(r.code).toBe(0);
    expect(r.out).toContain(SKILL);
    expect(r.out).toContain(`.octobots/pack-updates/v57/${SKILL}`);
    expect(r.out).toContain(`reconciled-from: ${UPSTREAM_SHA}`);
    expect(r.out).toContain(RETIRED);
    expect(r.out).toMatch(/retired/);
  });

  it("says so when nothing is pending", () => {
    const ws = workspace();
    writeFileSync(pendingPath(ws), JSON.stringify({ packVersion: 57, skills: [], kept: [] }));
    const r = run(ws, "list");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no pending reconcile/);
  });
});

describe("pack-reconcile.mjs done: refuses an unfinished reconcile with exit 3", () => {
  const refused = (ws: string, args: string[], reason: RegExp) => {
    const before = readFileSync(pendingPath(ws));
    const r = run(ws, "done", ...args);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(reason);
    expect(readFileSync(pendingPath(ws)).equals(before)).toBe(true);
  };

  it("when the live marker is not `57+local` (the fork is still `57-local`)", () => {
    const ws = workspace();
    decisions(ws, SKILL, CLOSED);
    refused(ws, [SKILL], /57-local[\s\S]*57\+local/);
  });

  it("when the live marker is a plain `57` (a dropped -local would hide the fork)", () => {
    const ws = workspace();
    decisions(ws, SKILL, CLOSED);
    reconciled(ws, "57");
    refused(ws, [SKILL], /57\+local/);
  });

  it("when the live marker is `+local` of another pack version (`56+local` for a v57 entry)", () => {
    const ws = workspace();
    decisions(ws, SKILL, CLOSED);
    reconciled(ws, "56+local");
    refused(ws, [SKILL], /56\+local[\s\S]*57\+local/);
  });

  it("when reconciled-from is not upstream.md's sha256", () => {
    const ws = workspace();
    decisions(ws, SKILL, CLOSED);
    reconciled(ws, "57+local", "c".repeat(64));
    refused(ws, [SKILL], /reconciled-from/);
  });

  it("when DECISIONS.md is missing", () => {
    const ws = workspace();
    reconciled(ws);
    refused(ws, [SKILL], /DECISIONS\.md/);
  });

  it("when DECISIONS.md has an open ESCALATED entry, quoting it", () => {
    const ws = workspace();
    reconciled(ws);
    decisions(ws, SKILL, OPEN);
    refused(ws, [SKILL], /ESCALATED: green rule/);
  });

  it("when pending.json is malformed", () => {
    const ws = workspace();
    writeFileSync(pendingPath(ws), "{not json");
    refused(ws, [SKILL], /malformed/);
  });
});

describe("pack-reconcile.mjs done: clears a finished reconcile", () => {
  it("removes exactly that entry and leaves the staging folder", () => {
    const ws = workspace();
    reconciled(ws);
    decisions(ws, SKILL, CLOSED);
    const folder = readdirSync(staging(ws, SKILL)).sort();
    const r = run(ws, "done", SKILL);
    expect(r.code, r.err).toBe(0);
    expect(pendingSkills(ws)).toEqual([RETIRED]);
    expect(readdirSync(staging(ws, SKILL)).sort()).toEqual(folder);
  });

  it("accepts an escalation the user answered (`- RESOLVED (user, <date>)`)", () => {
    const ws = workspace();
    reconciled(ws);
    decisions(ws, SKILL, OPEN.replace("- ESCALATED: green rule: local 0 xfailed; upstream an xfail with a reason is green; question which?", "- RESOLVED (user, 2026-10-05): green rule: keep 0 xfailed"));
    expect(run(ws, "done", SKILL).code).toBe(0);
    expect(pendingSkills(ws)).toEqual([RETIRED]);
  });

  it("a retired skill: exits 3 while its directory is under .claude/skills, 0 once it is gone with a closed DECISIONS.md", () => {
    const ws = workspace();
    decisions(ws, RETIRED, "# Decisions\n\n## Kept local\n\n## Taken from upstream\n\n## Conflicts\n\n- RESOLVED (user, 2026-10-05): retired skill: move it to .claude/skills/designer-notes\n");
    const first = run(ws, "done", RETIRED);
    expect(first.code).toBe(3);
    expect(first.err).toMatch(/\.claude\/skills\/workflow-designer/);
    expect(pendingSkills(ws)).toEqual([SKILL, RETIRED]);

    rmSync(dirname(liveMd(ws, RETIRED)), { recursive: true });
    expect(run(ws, "done", RETIRED).code).toBe(0);
    expect(pendingSkills(ws)).toEqual([SKILL]);
  });

  it("a retired skill whose directory is gone still needs a closed DECISIONS.md", () => {
    const ws = workspace();
    rmSync(dirname(liveMd(ws, RETIRED)), { recursive: true });
    expect(run(ws, "done", RETIRED).code).toBe(3);
    decisions(ws, RETIRED, OPEN);
    expect(run(ws, "done", RETIRED).code).toBe(3);
  });

  it("done on a skill with no entry exits 0, prints `no pending reconcile for <skill>` and leaves pending.json byte-identical", () => {
    const ws = workspace();
    const before = readFileSync(pendingPath(ws));
    const r = run(ws, "done", "knowledge-explorer");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("no pending reconcile for knowledge-explorer");
    expect(readFileSync(pendingPath(ws)).equals(before)).toBe(true);
  });

  it("done with no pending.json at all is the no-entry case", () => {
    const ws = workspace();
    rmSync(pendingPath(ws));
    const r = run(ws, "done", SKILL);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`no pending reconcile for ${SKILL}`);
    expect(existsSync(pendingPath(ws))).toBe(false);
  });
});

describe("pack-reconcile.mjs workspace resolution and source", () => {
  it("run from an unrelated cwd it acts on the workspace it is installed in, not the cwd", () => {
    const ws = workspace();
    const decoy = mkdtempClean("pack-reconcile-decoy-");
    mk(pendingPath(decoy), JSON.stringify({ packVersion: 57, skills: [], kept: [] }));
    const r = spawnSync("node", [join(ws, ...SCRIPT_REL), "list"], { cwd: decoy, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SKILL);
  });

  it("--root <dir> names the workspace explicitly", () => {
    const ws = workspace();
    const other = workspace();
    writeFileSync(pendingPath(other), JSON.stringify({ packVersion: 57, skills: [], kept: [] }));
    const r = spawnSync("node", [join(ws, ...SCRIPT_REL), "list", "--root", other], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(SKILL);
  });

  it("usage errors exit 2", () => {
    const ws = workspace();
    expect(run(ws).code).toBe(2);
    expect(run(ws, "done").code).toBe(2);
    expect(run(ws, "frobnicate").code).toBe(2);
  });

  it("the script's logic names no skill (its two shared-module import lines aside)", () => {
    const full = readFileSync(join(PACK_SRC, "skill", "octobots-doctor", "scripts", "pack-reconcile.mjs"), "utf8");
    const imports = full.split("\n").filter((l) => /^import .* from "\.\.\/\.\.\//.test(l));
    expect(imports).toEqual([
      'import * as io from "../../mission-planner/scripts/pending-io.mjs";',
      'import { parseSkillMarker, skillSha256 } from "../../mission-planner/scripts/skill-marker.mjs";',
    ]);
    const src = full.split("\n").filter((l) => !/^import /.test(l)).join("\n");
    for (const s of [...OCTOBOTS_SKILLS, ...RETIRED_SKILLS.filter((r) => r !== "octobots")]) expect(src, s).not.toContain(s);
    expect(src).not.toMatch(/(?<![.\w-])octobots(?![\w-])/); // the retired v18 skill; `.octobots/` is the board
  });

  it("loads the shared modules from mission-planner only: another skill holding copies of them neither breaks it nor runs", () => {
    // Regression (T7.6 review): a scan of .claude/skills for the shared modules exited 2 once a user
    // kept a copy of mission-planner under another name, so no pending entry could ever be cleared, and
    // it imported whichever single copy it found.
    const ws = workspace();
    cpSync(join(ws, ".claude", "skills", "mission-planner"), join(ws, ".claude", "skills", "my-planner"), { recursive: true });
    mk(join(ws, ".claude", "skills", "aaa", "scripts", "pending-io.mjs"), 'console.log("FOREIGN MODULE RAN");\n');
    mk(join(ws, ".claude", "skills", "aaa", "scripts", "skill-marker.mjs"), 'console.log("FOREIGN MODULE RAN");\n');
    const r = run(ws, "list");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(SKILL);
    expect(r.out).not.toContain("FOREIGN MODULE RAN");
    reconciled(ws);
    decisions(ws, SKILL, CLOSED);
    expect(run(ws, "done", SKILL).code).toBe(0);
    expect(pendingSkills(ws)).toEqual([RETIRED]);
  });

  it("ships a sibling package.json marking the scripts as ES modules", () => {
    expect(JSON.parse(readFileSync(join(PACK_SRC, "skill", "octobots-doctor", "scripts", "package.json"), "utf8"))).toEqual({ type: "module" });
  });
});

describe("the pack lists 5 skills", () => {
  const FIVE = ["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer", "octobots-doctor"];
  it("OCTOBOTS_SKILLS", () => {
    expect([...OCTOBOTS_SKILLS]).toEqual(FIVE);
  });
  it("doctor.js's SKILLS constant", () => {
    const src = readFileSync(join(PACK_SRC, "skill", "mission-planner", "scripts", "doctor.js"), "utf8");
    const m = src.match(/^const SKILLS = (\[[^\]]*\]);$/m);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(FIVE);
  });
});
