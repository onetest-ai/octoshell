// pack-reconcile.mjs (octobots-doctor's `done` gate, M7-AC7 / T7.6-AC2), run as an agent runs it:
// `node <workspace>/.claude/skills/octobots-doctor/scripts/pack-reconcile.mjs list | done <skill>`.
// The workspace is built by hand (the two pack skills it needs copied into .claude/skills, a
// pending.json and its staging folders), so each case states exactly the record it starts from.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { PACK_SRC } from "./fixtures/pack-store.js";
import { OCTOBOTS_SKILLS } from "../src/host/octobots-skill.js";
import { RETIRED_SKILLS } from "../src/host/pack-skills.js";
import { RETIRED_PACK_PATHS, isJudgedPackPath, packFileEntryName, packFileRel } from "../src/host/pack-files.js";

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

// A pack-file entry (v62): its live file is the one its RECONCILE.md names.
const FILE_UPSTREAM = "#!/usr/bin/env node\n// upstream\n";
const FILE_SHA = createHash("sha256").update(FILE_UPSTREAM).digest("hex");
const VALIDATE = "skill/mission-planner/scripts/validate.js";
const VALIDATE_REL = ".claude/skills/mission-planner/scripts/validate.js";
const fileLine = (rel: string, name: string) => `- File: ${rel} (pending entry ${name})`;

/** `workspace()` whose only pending entries are `files`, each staged with the brief line the installer writes. */
function fileWorkspace(files: Array<{ packPath: string; retired?: boolean; brief?: string | null; live?: string | null }>): string {
  const ws = workspace();
  for (const f of files) {
    const name = packFileEntryName(f.packPath);
    const d = staging(ws, name);
    mk(join(d, "local.md"), "local\n");
    mk(join(d, "DECISIONS.md"), CLOSED);
    if (!f.retired) mk(join(d, "upstream.md"), FILE_UPSTREAM);
    if (f.brief !== null) mk(join(d, "RECONCILE.md"), f.brief ?? `# Reconcile\n\n${fileLine(packFileRel(f.packPath), name)}\n- Base: none\n`);
    if (f.live !== null && f.live !== undefined) mk(join(ws, packFileRel(f.packPath)), f.live);
  }
  mk(pendingPath(ws), JSON.stringify({ packVersion: 57, skills: files.map((f) => entry(packFileEntryName(f.packPath), f.retired ?? false)), kept: [] }));
  return ws;
}
const fileMarked = (sha = FILE_SHA) => `#!/usr/bin/env node\n// octobots-reconciled-from: ${sha}\n// merged\n`;

describe("pack-reconcile.mjs: a pack-file entry", () => {
  const HOOK = "hooks/status-flip.mjs";
  const HOOK_NAME = packFileEntryName(HOOK);
  const RETIRED_FILE = "skill/mission-planner/scripts/set-step.js";
  const RETIRED_NAME = packFileEntryName(RETIRED_FILE);

  it("list prints the workspace path and the marker of a skill-script and a hook entry", () => {
    const ws = fileWorkspace([{ packPath: VALIDATE }, { packPath: HOOK }]);
    const r = run(ws, "list");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`  file: ${VALIDATE_REL}\n`);
    expect(r.out).toContain("  file: .octobots/hooks/status-flip.mjs\n");
    expect(r.out.match(new RegExp(`octobots-reconciled-from: ${FILE_SHA}`, "g"))).toHaveLength(2);
    expect(r.out).not.toContain("+local");
  });

  it("maps every judged and every retired pack path as the installer does (parity with pack-files.ts)", () => {
    const shipped = (readdirSync(PACK_SRC, { recursive: true, withFileTypes: true }))
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(PACK_SRC.length + 1).split("\\").join("/"));
    const judged = shipped.filter(isJudgedPackPath);
    expect(judged.length).toBeGreaterThan(30);
    const retired = RETIRED_PACK_PATHS.map((packPath) => ({ packPath, retired: true }));
    const r = run(fileWorkspace([...judged.map((packPath) => ({ packPath })), ...retired]), "list");
    expect(r.code, r.err).toBe(0);
    const listed = [...r.out.matchAll(/^ {2}file: (.*)$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...judged, ...RETIRED_PACK_PATHS].map(packFileRel));

    const unjudged = shipped.filter((p) => !isJudgedPackPath(p));
    expect(unjudged).toContain("graph/octograph.mjs");
    expect(unjudged).toContain("tokenomics/prices.json");
    const u = run(fileWorkspace(unjudged.filter((p) => !p.startsWith("graph/")).map((packPath) => ({ packPath }))), "list");
    expect(u.code, u.err).toBe(0);
    const refusedFiles = [...u.out.matchAll(/^ {2}file: (.*)$/gm)].map((m) => m[1]!);
    expect(refusedFiles).toHaveLength(unjudged.filter((p) => !p.startsWith("graph/")).length);
    expect(refusedFiles.length).toBeGreaterThan(5);
    for (const f of refusedFiles) expect(f).toMatch(/^missing/);
  });

  it.each([VALIDATE, HOOK, "tokenomics/collect.mjs", "statusline/statusline.sh"])("done %s: refused until the live file carries the marker of upstream.md", (packPath) => {
    const name = packFileEntryName(packPath);
    const ws = fileWorkspace([{ packPath, live: "// unmerged\n" }]);
    const refused = (reason: RegExp) => {
      const r = run(ws, "done", name);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(reason);
      expect(pendingSkills(ws)).toEqual([name]);
    };
    const live = join(ws, packFileRel(packPath));
    refused(/octobots-reconciled-from: \(none\)/);
    writeFileSync(live, fileMarked("c".repeat(64)));
    refused(/octobots-reconciled-from: c{64}/);
    writeFileSync(live, fileMarked() + "// ESCALATED: exit code: awaiting the user's answer, see DECISIONS.md\n");
    refused(/ESCALATED/);
    rmSync(live);
    refused(/does not exist/);
    writeFileSync(live, fileMarked());
    decisions(ws, name, OPEN);
    refused(/open escalation/);
    decisions(ws, name, CLOSED);
    const r = run(ws, "done", name);
    expect(r.code, r.err).toBe(0);
    expect(pendingSkills(ws)).toEqual([]);
  });

  it("done refuses a second marker line (a second reconcile that kept the old one), and passes once only the new one is left", () => {
    const ws = fileWorkspace([{ packPath: HOOK }]);
    const live = join(ws, packFileRel(HOOK));
    for (const other of ["c".repeat(64), FILE_SHA]) {
      mk(live, fileMarked() + `# octobots-reconciled-from: ${other}\r\n`);
      const r = run(ws, "done", HOOK_NAME);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/holds 2 octobots-reconciled-from lines; it must hold exactly one/);
      expect(pendingSkills(ws)).toEqual([HOOK_NAME]);
    }
    writeFileSync(live, fileMarked());
    expect(run(ws, "done", HOOK_NAME).code).toBe(0);
  });

  it.each([
    ["in a string", `const s = "octobots-reconciled-from: ${FILE_SHA}";\n`],
    ["after code", `run(); // octobots-reconciled-from: ${FILE_SHA}\n`],
    ["with text after the hash", `// octobots-reconciled-from: ${FILE_SHA} (merged)\n`],
    ["without comment syntax", `octobots-reconciled-from: ${FILE_SHA}\n`],
    ["as an unclosed HTML comment", `<!-- octobots-reconciled-from: ${FILE_SHA}\n`],
    ["below another mention the installer would read first", `const s = "octobots-reconciled-from: ${"c".repeat(64)}";\n// octobots-reconciled-from: ${FILE_SHA}\n`],
  ])("done refuses a marker %s", (_, text) => {
    const ws = fileWorkspace([{ packPath: HOOK, live: text }]);
    const r = run(ws, "done", HOOK_NAME);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/octobots-reconciled-from/);
    expect(pendingSkills(ws)).toEqual([HOOK_NAME]);
  });

  it.each(["//", "#", "<!--"])("done takes the marker in every form v60 and v61 named: %s, LF or CRLF", (c) => {
    for (const eol of ["\n", "\r\n"]) {
      const marker = `${c} octobots-reconciled-from: ${FILE_SHA}${c === "<!--" ? " -->" : ""}`;
      const ws = fileWorkspace([{ packPath: "tokenomics/collect.mjs", live: ["first", marker, "last", ""].join(eol) }]);
      const r = run(ws, "done", "tokenomics-collect-mjs");
      expect(r.code, r.err).toBe(0);
    }
  });

  it("done refuses a live file that is a symlink, even to a marked file", () => {
    const ws = fileWorkspace([{ packPath: HOOK }]);
    const target = join(mkdtempClean("pack-reconcile-target-"), "x.mjs");
    writeFileSync(target, fileMarked());
    mkdirSync(join(ws, ".octobots", "hooks"), { recursive: true });
    symlinkSync(target, join(ws, packFileRel(HOOK)));
    const r = run(ws, "done", HOOK_NAME);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/not a readable regular file/);
    expect(pendingSkills(ws)).toEqual([HOOK_NAME]);
  });

  it("a retired file: list prints no marker; done needs a closed DECISIONS.md and the live file gone", () => {
    const ws = fileWorkspace([{ packPath: RETIRED_FILE, retired: true, live: "// mine\n" }]);
    const live = join(ws, packFileRel(RETIRED_FILE));
    const l = run(ws, "list");
    expect(l.out).toContain("  file: .claude/skills/mission-planner/scripts/set-step.js\n");
    expect(l.out).not.toMatch(/marker:|reconciled-from/);

    let r = run(ws, "done", RETIRED_NAME); // closed, but the file is there
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/set-step\.js still exists/);
    rmSync(live);
    symlinkSync(join(ws, "nowhere"), live); // a dangling symlink is still there
    expect(run(ws, "done", RETIRED_NAME).code).toBe(3);
    rmSync(live);
    decisions(ws, RETIRED_NAME, OPEN); // gone, but unanswered
    expect(run(ws, "done", RETIRED_NAME).code).toBe(3);
    rmSync(join(staging(ws, RETIRED_NAME), "DECISIONS.md"));
    expect(run(ws, "done", RETIRED_NAME).code).toBe(3);
    expect(pendingSkills(ws)).toEqual([RETIRED_NAME]);
    decisions(ws, RETIRED_NAME, CLOSED);
    r = run(ws, "done", RETIRED_NAME);
    expect(r.code, r.err).toBe(0);
    expect(pendingSkills(ws)).toEqual([]);
  });

  describe.each([
    ["active", VALIDATE, false],
    ["retired", RETIRED_FILE, true],
  ] as const)("an invalid brief of an %s entry is `file: missing`, and done exits 3", (_, packPath, retired) => {
    const name = packFileEntryName(packPath);
    const rel = packFileRel(packPath);
    const briefs: Array<[string, string | null]> = [
      ["a path out of the workspace", fileLine("../../etc/passwd", name)],
      ["an absolute path", fileLine(`/${rel}`, name)],
      ["a backslash path", fileLine(rel.split("/").join("\\"), name)],
      ["a NUL in the path", fileLine(`${rel}\0`, name)],
      ["a `..` segment", fileLine(rel.replace("scripts/", "scripts/../scripts/"), name)],
      ["a `.` segment", fileLine(rel.replace("scripts/", "scripts/./"), name)],
      ["an empty segment", fileLine(rel.replace("scripts/", "scripts//"), name)],
      ["another entry's path", fileLine(".octobots/hooks/primer.mjs", name)],
      ["a SKILL.md", fileLine(".claude/skills/mission-planner/SKILL.md", name)],
      ["a path outside the four roots", fileLine(`.claude/${packPath}`, name)],
      ["no File line", "# Reconcile\n"],
      ["no RECONCILE.md", null],
    ];
    it.each(briefs)("%s", (_case, brief) => {
      const ws = fileWorkspace([{ packPath, retired, brief, live: retired ? null : fileMarked() }]);
      const l = run(ws, "list");
      expect(l.code, l.err).toBe(0);
      expect(l.out).toMatch(/^ {2}file: missing/m);
      expect(l.out).not.toMatch(/marker:/);
      const r = run(ws, "done", name);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/RECONCILE\.md/);
      expect(pendingSkills(ws)).toEqual([name]);
    });

    it("a symlinked RECONCILE.md", () => {
      const ws = fileWorkspace([{ packPath, retired, brief: null, live: retired ? null : fileMarked() }]);
      const target = join(mkdtempClean("pack-reconcile-brief-"), "b.md");
      writeFileSync(target, fileLine(rel, name));
      symlinkSync(target, join(staging(ws, name), "RECONCILE.md"));
      expect(run(ws, "list").out).toMatch(/^ {2}file: missing/m);
      expect(run(ws, "done", name).code).toBe(3);
      expect(pendingSkills(ws)).toEqual([name]);
    });
  });

  it("an entry named after a SKILL.md never maps to it", () => {
    const name = "skill-mission-planner-skill-md";
    const ws = fileWorkspace([{ packPath: "skill/mission-planner/SKILL.md", brief: fileLine(".claude/skills/mission-planner/SKILL.md", name) }]);
    expect(run(ws, "list").out).toMatch(/^ {2}file: missing/m);
    expect(run(ws, "done", name).code).toBe(3);
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
      'import { fileReconciledFrom, parseSkillMarker, skillSha256, withoutReconciledFrom } from "../../mission-planner/scripts/skill-marker.mjs";',
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
