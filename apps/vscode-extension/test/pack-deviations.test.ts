import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedLines,
  GIT_BUDGET_MS,
  detectDeviations,
  loadShippedStore,
  recoverBase,
  type ShippedStore,
} from "../src/host/pack-deviations.js";
import { OCTOBOTS_PACK_VERSION, OCTOBOTS_SKILLS } from "../src/host/octobots-skill.js";
import { skillSha256 } from "../src/host/skill-marker.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const EXT_ROOT = join(__dirname, "..");
const PACK_SKILLS = join(EXT_ROOT, "resources", "octobots-pack", "skill");
const store = loadShippedStore(join(EXT_ROOT, "resources", "shipped-skills.json.br"))!;
const PACK = OCTOBOTS_PACK_VERSION;

const shipped = (skill: string) => readFileSync(join(PACK_SKILLS, skill, "SKILL.md"), "utf8");
const body = (hash: string) => store.bodies[hash]!;
const versionLine = (text: string, label: string) => text.replace(/^version:.*$/m, `version: ${label}`);

/** A temp workspace holding the given SKILL.md files under `.claude/skills/<skill>/`. */
function workspace(files: Record<string, string | Buffer>): string {
  const root = mkdtempClean("pack-deviations-");
  for (const [skill, content] of Object.entries(files)) writeSkill(root, skill, content);
  return root;
}
function writeSkill(root: string, skill: string, content: string | Buffer): void {
  const file = join(root, ".claude", "skills", skill, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
const pristine = (): Record<string, string> => Object.fromEntries(OCTOBOTS_SKILLS.map((s) => [s, shipped(s)]));

/**
 * Solo's two real `57-local` forks: the bytes of OCTOBOTS_BOARD_COPIES' sibling .claude when that is
 * set to a board copy of solo, else the shipped v56 files relabelled `57-local`. Copied, never written to.
 */
function forks(): Record<"mission-execution" | "mission-completion-gate", Buffer> {
  const out = {} as Record<"mission-execution" | "mission-completion-gate", Buffer>;
  const copies = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  for (const skill of ["mission-execution", "mission-completion-gate"] as const) {
    let real: Buffer | null = null;
    for (const dir of copies) {
      const f = join(dirname(dir), ".claude", "skills", skill, "SKILL.md");
      if (existsSync(f) && /^version: 57-local\s*$/m.test(readFileSync(f, "utf8"))) real = readFileSync(f);
    }
    out[skill] = real ?? Buffer.from(versionLine(body(store.versions["56"]![skill]![0]!), "57-local"));
  }
  return out;
}

describe("detectDeviations", () => {
  it("reports nothing for a workspace holding the pack's own files", () => {
    const ws = workspace(pristine());
    expect(detectDeviations(ws, PACK, store)).toEqual({ deviations: [], reconciled: [], newer: [] });
  });

  it("reports solo's 57-local forks as `label` deviations, in pack order, with the file's sha256", () => {
    const f = forks();
    const ws = workspace({ ...pristine(), "mission-execution": f["mission-execution"], "mission-completion-gate": f["mission-completion-gate"] });
    const r = detectDeviations(ws, PACK, store);
    expect(r.deviations).toEqual([
      { skill: "mission-execution", version: "57-local", reason: "label", retired: false, sha256: skillSha256(f["mission-execution"].toString("utf8")) },
      { skill: "mission-completion-gate", version: "57-local", reason: "label", retired: false, sha256: skillSha256(f["mission-completion-gate"].toString("utf8")) },
    ]);
    expect(r.reconciled).toEqual([]);
    expect(r.newer).toEqual([]);
  });

  it("reports a one-line edit of a numeric-version file as `content`", () => {
    const ws = workspace({ ...pristine(), "mission-planner": shipped("mission-planner") + "\nOne local line.\n" });
    const r = detectDeviations(ws, PACK, store);
    expect(r.deviations.map((d) => [d.skill, d.version, d.reason])).toEqual([["mission-planner", String(PACK), "content"]]);
  });

  it("treats an earlier build of the same version, which the store lists, as the pack's own", () => {
    const earlier = body(store.versions[String(PACK)]!["mission-completion-gate"]![0]!);
    const ws = workspace({ ...pristine(), "mission-completion-gate": earlier });
    expect(detectDeviations(ws, PACK, store).deviations).toEqual([]);
  });

  it("reports a version up to the pack version that the store lists nothing for as `unknown-version`", () => {
    // v52 never shipped (its bump lived only on an abandoned branch), so the store has no entry for it.
    expect(store.versions["52"]).toBeUndefined();
    const ws = workspace({ ...pristine(), "mission-execution": versionLine(shipped("mission-execution"), "52") });
    expect(detectDeviations(ws, PACK, store).deviations.map((d) => [d.skill, d.version, d.reason])).toEqual([
      ["mission-execution", "52", "unknown-version"],
    ]);
  });

  it("lists a version above the pack version as `newer` and never as a deviation, whatever its suffix", () => {
    const ws = workspace({
      ...pristine(),
      "mission-planner": versionLine(shipped("mission-planner"), String(PACK + 1)),
      "mission-execution": versionLine(shipped("mission-execution"), `${PACK + 1}-local`),
      "mission-completion-gate": versionLine(shipped("mission-completion-gate"), `${PACK + 1}+local`),
    });
    const r = detectDeviations(ws, PACK, store);
    expect(r.newer).toEqual(["mission-planner", "mission-execution", "mission-completion-gate"]);
    expect(r.deviations).toEqual([]);
    expect(r.reconciled).toEqual([]);
  });

  describe("<N>+local", () => {
    const skill = "mission-completion-gate";
    const builds = store.versions[String(PACK)]![skill]!;
    const reconciledAt = (label: string, from: string | null) =>
      workspace({
        ...pristine(),
        [skill]: `---\nname: ${skill}\nversion: ${label}\n${from ? `reconciled-from: ${from}\n` : ""}---\n\nmerged body\n`,
      });

    it("is RECONCILED when N is the pack version and reconciled-from is the sha256 of the pack's current file", () => {
      expect(builds.at(-1)).toBe(skillSha256(shipped(skill))); // the store's newest build is the shipped file
      const r = detectDeviations(reconciledAt(`${PACK}+local`, skillSha256(shipped(skill))), PACK, store);
      expect(r).toEqual({ deviations: [], reconciled: [skill], newer: [] });
    });

    it("is `reconciled-older` when reconciled-from names an earlier build of the same version", () => {
      expect(builds.length).toBeGreaterThan(1);
      expect(builds[0]).not.toBe(skillSha256(shipped(skill)));
      const r = detectDeviations(reconciledAt(`${PACK}+local`, builds[0]!), PACK, store);
      expect(r.deviations.map((d) => [d.skill, d.version, d.reason])).toEqual([[skill, `${PACK}+local`, "reconciled-older"]]);
      expect(r.reconciled).toEqual([]);
    });

    it("is `reconciled-older` without a reconciled-from line, and when N is below the pack version", () => {
      expect(detectDeviations(reconciledAt(`${PACK}+local`, null), PACK, store).deviations[0]?.reason).toBe("reconciled-older");
      expect(detectDeviations(reconciledAt(`${PACK - 1}+local`, skillSha256(shipped(skill))), PACK, store).deviations[0]?.reason).toBe(
        "reconciled-older",
      );
    });

    it("is `newer` at a version above the pack version, whatever reconciled-from says", () => {
      const r = detectDeviations(reconciledAt(`${PACK + 1}+local`, skillSha256(shipped(skill))), PACK, store);
      expect(r).toEqual({ deviations: [], reconciled: [], newer: [skill] });
    });

    it("takes the current hash from the caller when it has the pack at hand", () => {
      const named = builds[0]!;
      const r = detectDeviations(reconciledAt(`${PACK}+local`, named), PACK, store, { currentHashes: { [skill]: named } });
      expect(r.reconciled).toEqual([skill]);
    });
  });

  it("reports a changed retired skill after the pack's skills, flagged retired, and ignores a pristine one", () => {
    const v56 = body(store.versions["56"]!["workflow-designer"]![0]!);
    const changed = workspace({ ...pristine(), "workflow-designer": v56 + "\nLocal note.\n", "mission-planner": shipped("mission-planner") + "\nx\n" });
    expect(detectDeviations(changed, PACK, store).deviations.map((d) => [d.skill, d.reason, d.retired])).toEqual([
      ["mission-planner", "content", false],
      ["workflow-designer", "content", true],
    ]);
    const clean = workspace({ ...pristine(), "workflow-designer": v56 });
    expect(detectDeviations(clean, PACK, store).deviations).toEqual([]);
  });

  it("reports a SKILL.md without a version line as a `label` deviation named `missing`", () => {
    const ws = workspace({ ...pristine(), "mission-planner": "# no frontmatter\n" });
    expect(detectDeviations(ws, PACK, store).deviations.map((d) => [d.skill, d.version, d.reason])).toEqual([
      ["mission-planner", "missing", "label"],
    ]);
  });

  it("skips skills that are not installed", () => {
    expect(detectDeviations(workspace({}), PACK, store)).toEqual({ deviations: [], reconciled: [], newer: [] });
  });

  it("without a store, takes an integer version at its word and still calls a label a deviation", () => {
    const ws = workspace({ ...pristine(), "mission-planner": shipped("mission-planner") + "\nx\n", "mission-execution": versionLine(shipped("mission-execution"), "57-local") });
    expect(detectDeviations(ws, PACK, null).deviations.map((d) => [d.skill, d.reason])).toEqual([["mission-execution", "label"]]);
  });
});

describe("loadShippedStore", () => {
  it("returns null for a missing file and for a file that is not a store", () => {
    const dir = mkdtempClean("store-");
    expect(loadShippedStore(join(dir, "nope.br"))).toBeNull();
    writeFileSync(join(dir, "junk.br"), "not brotli");
    expect(loadShippedStore(join(dir, "junk.br"))).toBeNull();
  });
});

describe("changedLines", () => {
  it("counts lines only on one side", () => {
    expect(changedLines("a\nb\nc", "a\nb\nc")).toBe(0);
    expect(changedLines("a\nb\nc", "a\nX\nc")).toBe(2);
    expect(changedLines("a\nb\nc", "a\nb\nc\nd")).toBe(1);
    expect(changedLines("a\nb\nc\nd\ne", "a\nc\nd\nz\ne")).toBe(2);
  });
});

describe("recoverBase", () => {
  const skill = "mission-execution";
  const v56 = () => store.versions["56"]![skill]![0]!;
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  /** A temp git repo whose history of the skill's SKILL.md is the given texts, oldest first. */
  function repoWithHistory(texts: string[], ignoreClaude = false): string {
    const root = mkdtempClean("pack-git-");
    gitIn(root, "init", "-q");
    if (ignoreClaude) writeFileSync(join(root, ".gitignore"), ".claude\n");
    texts.forEach((t, i) => {
      writeSkill(root, skill, t);
      gitIn(root, "add", "-f", ".");
      gitIn(root, "commit", "-q", "--allow-empty", "-m", `c${i}`);
    });
    return root;
  }
  const fork = () => versionLine(body(v56()), "57-local") + "\nLocal rule: always use pnpm.\n";

  it("rule 1: the stored body that reconciled-from names", () => {
    const named = store.versions["54"]![skill]![0]!;
    const local = `---\nname: ${skill}\nversion: 57+local\nreconciled-from: ${named}\n---\nmerged\n`;
    const r = recoverBase(workspace({}), skill, local, PACK, store)!;
    expect(r).toEqual({ version: 54, sha256: named, source: "reconciled-from", body: body(named) });
  });

  it("rule 1 is skipped when the named hash is not in the store", () => {
    const local = `---\nname: ${skill}\nversion: 57+local\nreconciled-from: ${"0".repeat(64)}\n---\nmerged\n`;
    const r = recoverBase(workspace({}), skill, local, PACK, store)!;
    expect(r.source).toBe("declared");
  });

  it("rule 1 beats the workspace's git history", () => {
    const named = store.versions["54"]![skill]![0]!;
    const local = `---\nname: ${skill}\nversion: 57+local\nreconciled-from: ${named}\n---\nmerged\n`;
    const repo = repoWithHistory([body(v56()), local]);
    expect(recoverBase(repo, skill, local, PACK, store)!.source).toBe("reconciled-from");
  });

  it("rule 2: the newest commit whose SKILL.md is a shipped body wins over rules 3 and 4", () => {
    const v50 = store.versions["50"]![skill]![0]!;
    const repo = repoWithHistory([body(v50), body(v56()), fork()]);
    const r = recoverBase(repo, skill, fork(), PACK, store)!;
    expect(r).toEqual({ version: 56, sha256: v56(), source: "workspace-git", body: body(v56()) });
    // Rule 3 would have said the first v57 build.
    expect(store.versions["57"]![skill]![0]).not.toBe(v56());
  });

  it("rule 2 steps over a commit that deleted the SKILL.md and still finds the shipped body before it", () => {
    const root = repoWithHistory([body(v56())]);
    gitIn(root, "rm", "-q", "-r", ".claude");
    gitIn(root, "commit", "-q", "-m", "delete");
    writeSkill(root, skill, fork());
    gitIn(root, "add", "-f", ".");
    gitIn(root, "commit", "-q", "-m", "fork");
    expect(recoverBase(root, skill, fork(), PACK, store)!).toMatchObject({ version: 56, sha256: v56(), source: "workspace-git" });
  });

  it("rule 1 is skipped for a stored body no version lists (fail-closed to the later rules)", () => {
    const text = `---\nname: ${skill}\nversion: 56\n---\norphan body\n`;
    const h = skillSha256(text);
    const orphanStore = { versions: {}, order: [h], bodies: { [h]: text } };
    const local = `---\nname: ${skill}\nversion: 57+local\nreconciled-from: ${h}\n---\nmerged\n`;
    expect(recoverBase(workspace({}), skill, local, PACK, orphanStore)).toBeNull();
  });

  it("rule 2 skips commits that are not shipped bodies, and falls to rule 3 when none is", () => {
    const repo = repoWithHistory([fork(), fork() + "more\n"]);
    expect(recoverBase(repo, skill, fork(), PACK, store)!.source).toBe("declared");
  });

  it("rule 2 is skipped when .claude is ignored", () => {
    const repo = repoWithHistory([body(v56()), fork()], true);
    expect(recoverBase(repo, skill, fork(), PACK, store)!.source).toBe("declared");
  });

  it("rule 2 is skipped when the directory is not a repository", () => {
    expect(recoverBase(workspace({ [skill]: fork() }), skill, fork(), PACK, store)!.source).toBe("declared");
  });

  it("rule 2 is skipped when git is absent", () => {
    const repo = repoWithHistory([body(v56()), fork()]);
    const saved = process.env.PATH;
    process.env.PATH = mkdtempClean("no-git-");
    try {
      expect(recoverBase(repo, skill, fork(), PACK, store)!.source).toBe("declared");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("rule 2 gives up on a git that hangs, within about two seconds", () => {
    const repo = repoWithHistory([body(v56()), fork()]);
    const bin = mkdtempClean("slow-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    const t0 = Date.now();
    try {
      expect(recoverBase(repo, skill, fork(), PACK, store)!.source).toBe("declared");
    } finally {
      process.env.PATH = saved;
    }
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("rule 2 shares one git budget across the skills of one install, so a hanging git blocks the host about 2 s in all", () => {
    // Regression (T7.2 review): each call used to get its own 2 s, so solo's two forks blocked the
    // extension host for 4 s on a hanging git (execFileSync is synchronous).
    const ws = mkdtempClean("shared-budget-");
    const bin = mkdtempClean("slow-git-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    const t0 = Date.now();
    const gitDeadline = t0 + GIT_BUDGET_MS;
    try {
      for (const s of ["mission-execution", "mission-completion-gate"]) {
        const local = versionLine(body(store.versions["56"]![s]![0]!), "57-local");
        expect(recoverBase(ws, s, local, PACK, store, { gitDeadline })!.source).toBe("declared");
      }
    } finally {
      process.env.PATH = saved;
    }
    expect(Date.now() - t0).toBeLessThan(GIT_BUDGET_MS + 1000);
  });

  it("rule 3: with no history, the EARLIEST stored body for the declared version", () => {
    const r = recoverBase(workspace({}), skill, fork(), PACK, store)!;
    const earliest = store.versions["57"]![skill]![0]!;
    expect(r).toEqual({ version: 57, sha256: earliest, source: "declared", body: body(earliest) });
  });

  it("rule 3: a numeric-version file that was edited takes the earliest body for its own version", () => {
    const local = body(v56()) + "\nedit\n";
    expect(recoverBase(workspace({}), skill, local, PACK, store)).toMatchObject({ version: 56, sha256: v56(), source: "declared" });
  });

  it("rule 4: a label whose version the store lists nothing for takes the closest body at or below it, never a newer one", () => {
    // v52 never shipped, so rule 3 has no body. The file IS the v56 body, but v56 is newer than the label.
    const local = versionLine(body(v56()), "52-local");
    const r = recoverBase(workspace({}), skill, local, PACK, store)!;
    expect(r.source).toBe("closest");
    expect(r.version).toBeLessThanOrEqual(52);
    // The overall closest body is the v56 one, so the bound is what stopped rule 4 picking it.
    expect(changedLines(body(v56()), local)).toBeLessThan(changedLines(r.body, local));
    expect(r.body).toBe(store.bodies[r.sha256]);
  });

  it("rule 4: a `50-local` label whose v50 body is gone from the store still stays at or below v50", () => {
    const trimmed: ShippedStore = { ...store, versions: { ...store.versions } };
    delete trimmed.versions["50"];
    const local = versionLine(body(v56()), "50-local");
    const r = recoverBase(workspace({}), skill, local, PACK, trimmed)!;
    expect(r.source).toBe("closest");
    expect(r.version).toBeLessThanOrEqual(49);
  });

  it("rule 4: a label with no leading integer considers every stored body", () => {
    const local = versionLine(body(v56()), "forked") + "\nextra\n";
    const r = recoverBase(workspace({}), skill, local, PACK, store)!;
    expect(r.source).toBe("closest");
    // Not bounded by any label: a body newer than every label above is in reach, and none is nearer.
    expect(r.version).toBeGreaterThan(52);
    expect(changedLines(r.body, local)).toBeLessThanOrEqual(changedLines(body(v56()), local));
  });

  it("rule 4 ties toward the older body", () => {
    const tiny: ShippedStore = {
      versions: { "1": { s: ["a"] }, "2": { s: ["b"] } },
      order: ["a", "b"],
      bodies: { a: "---\nversion: 1\n---\nx\n", b: "---\nversion: 2\n---\nx\n" },
    };
    const r = recoverBase(workspace({}), "s", "---\nversion: odd\n---\nx\n", 2, tiny)!;
    expect(r.sha256).toBe("a");
  });

  it("rule 5: null for an empty store, and when no stored body is at or below the declared version", () => {
    const empty: ShippedStore = { versions: {}, order: [], bodies: {} };
    expect(recoverBase(workspace({}), skill, fork(), PACK, empty)).toBeNull();
    expect(recoverBase(workspace({}), skill, versionLine(fork(), "10-local"), PACK, store)).toBeNull();
    expect(recoverBase(workspace({}), "no-such-skill", fork(), PACK, store)).toBeNull();
  });
});

describe("recoverBase on solo's forks", () => {
  it("names the v56 files of the solo history as the base when the workspace has that history", () => {
    // Build solo's shape: the shipped v56 files committed, then the forks.
    const f = forks();
    const root = mkdtempClean("solo-shape-");
    const gitIn = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: root, stdio: "pipe" });
    gitIn("init", "-q");
    for (const s of ["mission-execution", "mission-completion-gate"] as const) writeSkill(root, s, body(store.versions["56"]![s]![0]!));
    gitIn("add", "-f", ".");
    gitIn("commit", "-q", "-m", "v56");
    for (const s of ["mission-execution", "mission-completion-gate"] as const) writeSkill(root, s, f[s]);
    gitIn("add", "-f", ".");
    gitIn("commit", "-q", "-m", "forks");
    for (const s of ["mission-execution", "mission-completion-gate"] as const) {
      const base = recoverBase(root, s, f[s], PACK, store)!;
      expect(base.source).toBe("workspace-git");
      expect(base.version).toBe(56);
      expect(base.sha256).toBe(store.versions["56"]![s]![0]);
    }
  });
});

