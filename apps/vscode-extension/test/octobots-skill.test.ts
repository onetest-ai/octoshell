import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  parseVersion,
  requiredSkillsForAgent,
  OCTOBOTS_PACK_VERSION,
  OCTOBOTS_SKILLS,
  installPack,
  packStatus,
} from "../src/host/octobots-skill.js";
import { registerClaudeHook, claudeHookStatus } from "../src/host/octobots-hooks.js";
import { GIT_BUDGET_MS, recoverBase, type ShippedStore } from "../src/host/pack-deviations.js";
import { forks } from "./fixtures/pack-store.js";
import { skillSha256 } from "../src/host/skill-marker.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { store } from "./fixtures/pack-store.js";

// Passes through to the real recoverBase; lets a test read the options each call received.
vi.mock("../src/host/pack-deviations.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/host/pack-deviations.js")>();
  return { ...real, recoverBase: vi.fn(real.recoverBase) };
});

const PACK_SRC = join(__dirname, "..", "resources", "octobots-pack");

/** The newest SKILL.md the pack ever shipped for `skill`: a pristine file of a retired skill. */
const shippedBody = (skill: string): string => {
  const versions = Object.keys(store.versions).map(Number).sort((a, b) => b - a);
  const v = versions.find((n) => store.versions[String(n)]?.[skill]);
  return store.bodies[store.versions[String(v)]![skill]!.at(-1)!]!;
};

describe("octobots-skill helpers", () => {
  it("parses the version: frontmatter field, or null when absent", () => {
    expect(parseVersion("---\nname: octobots\nversion: 3\n---\nbody")).toBe(3);
    expect(parseVersion("---\nname: octobots\n---\nbody")).toBeNull();
    expect(parseVersion("no frontmatter")).toBeNull();
  });

  it("every managed agent requires both pack skills", () => {
    for (const agent of ["scout", "any-agent"]) {
      expect(requiredSkillsForAgent(agent)).toContain("mission-planner");
      expect(requiredSkillsForAgent(agent)).toContain("mission-execution");
    }
  });

  it("ships no agents at all — planning lives in the skills, agent rosters belong to the repo", () => {
    // Guards the payload, not just a constant: an `agents/` dir would ride along in every VSIX and
    // reintroduce agent names the skills tell agents never to invent.
    expect(existsSync(join(PACK_SRC, "agents"))).toBe(false);
  });
});

describe("bundled pack payloads", () => {
  it.each(OCTOBOTS_SKILLS)("%s carries a matching name + pack version", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    expect(skill).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, "m"));
    expect(parseVersion(skill)).toBe(OCTOBOTS_PACK_VERSION);
  });

  it.each(OCTOBOTS_SKILLS)("%s describes when to use it, not what it does", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^description: Use when /m);
  });

  // Four sibling skills all trigger inside an .octobots/ repo, so a description that only says when
  // to use a skill leaves the model guessing between them. Each must also say what it is NOT for.
  it.each(OCTOBOTS_SKILLS)("%s says what it is not for, to disambiguate from its siblings", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    expect(description).toMatch(/\bNot for\b/);
  });

  it.each(OCTOBOTS_SKILLS)("%s does not name an agent the pack never installs", (name) => {
    const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
    // OCTOBOTS_AGENTS is empty: the pack ships skills and a hook, no agents. A skill that tells an
    // agent to call `octobots-planner` sends it after something that is not on disk.
    expect(skill).not.toMatch(/agent: ['"`]octobots-(planner|orchestrator)['"`]/);
  });

  // A skill nothing points at is a skill nothing invokes. knowledge-explorer answers a question the
  // other four each hit at a different moment — before decomposing, before the first edit, at the QA
  // phase, before parallelising tasks — so each of them names it. A pointer, not a gate: the reader
  // decides whether the question is worth a query, which is the skill's own first rule.
  it.each(["mission-planner", "mission-execution", "mission-completion-gate"])(
    "%s points at knowledge-explorer",
    (name) => {
      const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
      expect(skill).toMatch(/knowledge-explorer/);
    },
  );
});

describe("installPack + packStatus (real payload → temp repo)", () => {
  it("reports not-installed before install, up-to-date after", () => {
    const repo = mkdtempClean("octobots-pack-");
    expect(packStatus(repo).installed).toBe(false);

    const res = installPack(PACK_SRC, repo, { store });
    expect(res.written).toBeGreaterThanOrEqual(9); // 2 SKILL.md + 6 scripts + package.json

    for (const name of OCTOBOTS_SKILLS) {
      expect(existsSync(join(repo, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(repo, ".claude", "skills", "mission-planner", "scripts", "validate.js"))).toBe(true);

    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  it("removes the retired `octobots` skill dir a pre-rename pack left behind", () => {
    const repo = mkdtempClean("octobots-pack-");
    const stale = join(repo, ".claude", "skills", "octobots");
    mkdirSync(join(stale, "scripts"), { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), shippedBody("octobots")); // the pack's own v18 file: not a local change

    installPack(PACK_SRC, repo, { store });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(repo, ".claude", "skills", "mission-planner", "SKILL.md"))).toBe(true);
  });

  it("removes set-step.js from a workspace upgraded from an older pack", () => {
    const repo = mkdtempClean("octobots-pack-");
    const stale = join(repo, ".claude", "skills", "mission-planner", "scripts", "set-step.js");
    mkdirSync(join(repo, ".claude", "skills", "mission-planner", "scripts"), { recursive: true });
    writeFileSync(stale, "// old", "utf8");
    installPack(PACK_SRC, repo, { store });
    expect(existsSync(stale)).toBe(false);
  });

  it("removes the retired workflow-designer skill and workflow scripts, keeps a user's own script, and never touches .octobots workflows", () => {
    const repo = mkdtempClean("octobots-pack-");
    const skills = join(repo, ".claude", "skills");
    const scripts = join(skills, "mission-planner", "scripts");
    mkdirSync(join(skills, "workflow-designer"), { recursive: true });
    writeFileSync(join(skills, "workflow-designer", "SKILL.md"), shippedBody("workflow-designer"));
    mkdirSync(join(scripts, "vendor"), { recursive: true });
    const retired = ["add-workflow.js", "sync-meta.js", "add-run.js", "mission-input.js", "extract-meta.mjs", "workflow-meta.mjs", "vendor/acorn.mjs"];
    for (const f of retired) writeFileSync(join(scripts, f), "// old\n");
    writeFileSync(join(scripts, "create-team.js"), "// the user's own script\n");
    const wf = join(repo, ".octobots", "campaigns", "c", "workflows", "ship", "workflow.js");
    mkdirSync(join(wf, ".."), { recursive: true });
    writeFileSync(wf, "// user data: historical, never touched\n");

    installPack(PACK_SRC, repo, { store });

    expect(existsSync(join(skills, "workflow-designer"))).toBe(false);
    for (const f of retired) expect(existsSync(join(scripts, f)), f).toBe(false);
    expect(readFileSync(join(scripts, "create-team.js"), "utf8")).toBe("// the user's own script\n");
    expect(readFileSync(wf, "utf8")).toBe("// user data: historical, never touched\n");
  });

  it("overwrites a skill forked as `version: 57-local` when asked to: not up to date before, up to date after", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const skill = join(repo, ".claude", "skills", "mission-execution", "SKILL.md");
    const original = readFileSync(skill, "utf8");
    writeFileSync(skill, original.replace(/^version:\s*57\s*$/m, "version: 57-local") + "\nLOCAL EDIT\n");
    expect(packStatus(repo).upToDate).toBe(false);

    installPack(PACK_SRC, repo, { store, localChanges: "overwrite" });

    expect(readFileSync(skill, "utf8")).toBe(original);
    expect(packStatus(repo).upToDate).toBe(true);
  });

  it("ships exactly five skills and none of the retired workflow payload", () => {
    expect([...OCTOBOTS_SKILLS]).toEqual(["mission-planner", "mission-execution", "mission-completion-gate", "knowledge-explorer", "octobots-doctor"]);
    expect(readdirSync(join(PACK_SRC, "skill")).sort()).toEqual([...OCTOBOTS_SKILLS].sort());
    const scripts = join(PACK_SRC, "skill", "mission-planner", "scripts");
    for (const f of ["add-workflow.js", "sync-meta.js", "add-run.js", "mission-input.js", "extract-meta.mjs", "workflow-meta.mjs", "vendor/acorn.mjs"]) {
      expect(existsSync(join(scripts, f)), f).toBe(false);
    }
    expect(existsSync(join(__dirname, "..", "..", "..", "packages", "board", "test", "extract-meta-parity.test.ts"))).toBe(false);
  });

  it.each(OCTOBOTS_SKILLS)("reports not-installed when %s has no version field", (name) => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    // Corrupt one skill payload by stripping its frontmatter version.
    writeFileSync(join(repo, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody`);
    const st = packStatus(repo);
    expect(st.installed).toBe(false);
    expect(st.upToDate).toBe(false);
  });

  it.each(OCTOBOTS_SKILLS)("reports not-installed when %s is missing entirely", (name) => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    rmSync(join(repo, ".claude", "skills", name), { recursive: true, force: true });
    expect(packStatus(repo).installed).toBe(false);
  });

  it("reports not-up-to-date when an installed payload is older", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    expect(packStatus(repo, 999).upToDate).toBe(false);
  });

  it("installs the primer + Claude hook, and reports up-to-date only when both are current", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store, hooks: true }); // hooks are opt-in — ask for them explicitly
    expect(existsSync(join(repo, ".octobots", "hooks", "primer.mjs"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart.some((e: any) => e._octobots === OCTOBOTS_PACK_VERSION)).toBe(true);

    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  /**
   * CONTRACT CHANGE: hooks are opt-in (see `installPack`), so their absence is a choice, not a
   * broken install. Reporting not-installed here re-prompted a workspace that had declined them on
   * every open. Staleness still counts once they ARE present — the test below.
   */
  it("stays installed and up-to-date when hooks are absent, because they are opt-in", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store, hooks: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(true);
  });

  it("does not register hooks unless asked, and refreshes them once present", () => {
    const repo = mkdtempClean("octobots-pack-");
    expect(installPack(PACK_SRC, repo, { store }).hooksRegistered).toBe(false);
    expect(claudeHookStatus(repo, OCTOBOTS_PACK_VERSION).present).toBe(false);

    expect(installPack(PACK_SRC, repo, { store, hooks: true }).hooksRegistered).toBe(true);
    expect(claudeHookStatus(repo, OCTOBOTS_PACK_VERSION).present).toBe(true);

    // already present → a plain re-install refreshes them without being asked again
    expect(installPack(PACK_SRC, repo, { store }).hooksRegistered).toBe(true);

    // an explicit no clears ours
    expect(installPack(PACK_SRC, repo, { store, hooks: false }).hooksRegistered).toBe(false);
    expect(claudeHookStatus(repo, OCTOBOTS_PACK_VERSION).present).toBe(false);
  });

  it("reports installed but not-up-to-date when the Claude hook is a stale version", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store, hooks: true });
    registerClaudeHook(repo, OCTOBOTS_PACK_VERSION - 1); // downgrade our hook entry in place
    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(false);
  });

  it("does not throw when .claude/settings.json is malformed (returns not-up-to-date)", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    writeFileSync(join(repo, ".claude", "settings.json"), "{ bad json ,, }");
    expect(() => packStatus(repo)).not.toThrow();
    expect(packStatus(repo).upToDate).toBe(false);
  });

});

describe("tokenomics CLI install", () => {
  // The gate skill tells an agent to run `node .octobots/tokenomics/run.mjs`. If the pack does not
  // put it there, that instruction fails on every install — which is how it behaved before v35.
  it("installs the whole pipeline the gate is told to run", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const dir = join(repo, ".octobots", "tokenomics");
    for (const f of ["run.mjs", "collect.mjs", "rollup.mjs", "render.mjs", "prices.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it("every command the pack's skills name is a file the pack actually installs", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    for (const name of OCTOBOTS_SKILLS) {
      const skill = readFileSync(join(PACK_SRC, "skill", name, "SKILL.md"), "utf8");
      for (const [, script] of skill.matchAll(/\.octobots\/tokenomics\/([\w.-]+\.mjs)/g)) {
        expect(existsSync(join(repo, ".octobots", "tokenomics", script))).toBe(true);
      }
    }
  });

  // The CLI was hand-vendored from a repo whose Makefile wrapped it. The pack ships no Makefile, so
  // a `make tokenomics-prices` in the payload documents rate refresh as a command that cannot run
  // in any workspace that installs it.
  it("documents no `make` target, since the pack ships no Makefile", () => {
    const dir = join(PACK_SRC, "tokenomics");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, `${f} references a make target`).not.toMatch(/\bmake tokenomics/);
    }
  });

  it("names its own scripts by a path that exists in the payload", () => {
    const dir = join(PACK_SRC, "tokenomics");
    for (const f of readdirSync(dir)) {
      for (const [, script] of readFileSync(join(dir, f), "utf8").matchAll(/\.octobots\/tokenomics\/([\w.-]+\.mjs)/g)) {
        expect(existsSync(join(dir, script)), `${f} names a missing ${script}`).toBe(true);
      }
    }
  });

  it("reports not-installed when the tokenomics runner is missing", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    rmSync(join(repo, ".octobots", "tokenomics", "run.mjs"), { force: true });
    expect(packStatus(repo).installed).toBe(false);
  });

  it("reports not-up-to-date when the installed runner is from an older pack", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const entry = join(repo, ".octobots", "tokenomics", "run.mjs");
    writeFileSync(entry, readFileSync(entry, "utf8").replace(/octobots-pack-version: \d+/, "octobots-pack-version: 1"));
    const st = packStatus(repo);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(false);
  });

  // Transcripts are pruned outside the repo, so a clobbered artifact is unrecoverable — an upgrade
  // may refresh the scripts but must never touch what was already measured.
  it("preserves collected artifacts and a refreshed price table across a re-install", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const dir = join(repo, ".octobots", "tokenomics");
    mkdirSync(join(dir, "raw"), { recursive: true });
    writeFileSync(join(dir, "raw", "segments.jsonl"), '{"session_id":"s1"}\n');
    writeFileSync(join(dir, "worklog.jsonl"), '{"session_id":"s1","task":"T1.1"}\n');
    writeFileSync(join(dir, "runs.json"), '{"runs":[{"kept":true}]}');
    writeFileSync(join(dir, "prices.json"), '{"models":{"refreshed":{}}}');

    installPack(PACK_SRC, repo, { store });

    expect(readFileSync(join(dir, "raw", "segments.jsonl"), "utf8")).toContain("s1");
    expect(readFileSync(join(dir, "worklog.jsonl"), "utf8")).toContain("T1.1");
    expect(readFileSync(join(dir, "runs.json"), "utf8")).toContain("kept");
    expect(readFileSync(join(dir, "prices.json"), "utf8")).toContain("refreshed");
  });
});

describe("packStatus: deviations, reconciled and newer skills", () => {
  const skillPath = (repo: string, name: string) => join(repo, ".claude", "skills", name, "SKILL.md");
  const relabel = (repo: string, name: string, label: string, extra = "") => {
    const text = readFileSync(skillPath(repo, name), "utf8");
    writeFileSync(skillPath(repo, name), text.replace(/^version:.*$/m, `version: ${label}${extra}`));
  };
  const installed = () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    return repo;
  };

  it("all pristine: upToDate and upToDateExceptLocal, nothing listed", () => {
    const st = packStatus(installed(), OCTOBOTS_PACK_VERSION, store);
    expect(st).toMatchObject({
      installed: true, upToDate: true, upToDateExceptLocal: true,
      deviations: [], reconciled: [], pendingReconcile: [], newer: [],
    });
  });

  it("one deviation (solo's `57-local`): present, listed, upToDate false and upToDateExceptLocal true", () => {
    const repo = installed();
    relabel(repo, "mission-execution", "57-local");
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.installed).toBe(true);
    expect(st.upToDate).toBe(false);
    expect(st.upToDateExceptLocal).toBe(true);
    expect(st.deviations).toEqual([
      { skill: "mission-execution", version: "57-local", reason: "label", retired: false, sha256: skillSha256(readFileSync(skillPath(repo, "mission-execution"), "utf8")) },
    ]);
  });

  it("a kept content fork of a numeric-version file stays a deviation for as long as it differs", () => {
    const repo = installed();
    writeFileSync(skillPath(repo, "mission-planner"), readFileSync(skillPath(repo, "mission-planner"), "utf8") + "\nkept\n");
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.deviations.map((d) => [d.skill, d.reason])).toEqual([["mission-planner", "content"]]);
    expect([st.upToDate, st.upToDateExceptLocal]).toEqual([false, true]);
  });

  it("a reconciled skill is up to date and listed as reconciled", () => {
    const repo = installed();
    const current = skillSha256(readFileSync(skillPath(repo, "mission-completion-gate"), "utf8"));
    relabel(repo, "mission-completion-gate", `${OCTOBOTS_PACK_VERSION}+local`, `\nreconciled-from: ${current}`);
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.reconciled).toEqual(["mission-completion-gate"]);
    expect(st.deviations).toEqual([]);
    expect([st.installed, st.upToDate, st.upToDateExceptLocal]).toEqual([true, true, true]);
  });

  it("a newer skill is listed, not a deviation: upToDate false and upToDateExceptLocal true", () => {
    const repo = installed();
    relabel(repo, "mission-execution", `${OCTOBOTS_PACK_VERSION + 1}`);
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.newer).toEqual(["mission-execution"]);
    expect(st.deviations).toEqual([]);
    expect([st.installed, st.upToDate, st.upToDateExceptLocal]).toEqual([true, false, true]);
  });

  it("a pristine skill of an older pack version is stale, which no local choice explains", () => {
    const repo = installed();
    const v56 = store.bodies[store.versions["56"]!["mission-execution"]![0]!]!;
    writeFileSync(skillPath(repo, "mission-execution"), v56);
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.deviations).toEqual([]);
    expect([st.installed, st.upToDate, st.upToDateExceptLocal]).toEqual([true, false, false]);
  });

  it("a deviation does not hide a stale primer: upToDateExceptLocal needs every other payload current", () => {
    const repo = installed();
    relabel(repo, "mission-execution", "57-local");
    const primer = join(repo, ".octobots", "hooks", "primer.mjs");
    writeFileSync(primer, readFileSync(primer, "utf8").replace(/octobots-pack-version:\s*\d+/, "octobots-pack-version: 1"));
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect([st.installed, st.upToDate, st.upToDateExceptLocal]).toEqual([true, false, false]);
  });

  it("a skill the pack introduced in this version may be missing without making the pack not installed", () => {
    const repo = installed();
    rmSync(join(repo, ".claude", "skills", "knowledge-explorer"), { recursive: true });
    const introducedNow: ShippedStore = { ...store, versions: Object.fromEntries(
      Object.entries(store.versions).map(([v, per]) => {
        if (Number(v) >= OCTOBOTS_PACK_VERSION) return [v, per];
        const { "knowledge-explorer": _gone, ...rest } = per;
        return [v, rest];
      }),
    ) };
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, introducedNow);
    expect([st.installed, st.upToDate, st.upToDateExceptLocal]).toEqual([true, false, false]);
    // The same gap in a skill the pack shipped before is a broken install.
    expect(packStatus(repo, OCTOBOTS_PACK_VERSION, store).installed).toBe(false);
  });

  it("reads pending reconciles through pack-updates: none on a clean install, the staged skills after a reconcile", () => {
    const repo = installed();
    expect(packStatus(repo, OCTOBOTS_PACK_VERSION, store).pendingReconcile).toEqual([]);
    relabel(repo, "mission-execution", "57-local");
    relabel(repo, "mission-completion-gate", "57-local");
    installPack(PACK_SRC, repo, { store });
    const st = packStatus(repo, OCTOBOTS_PACK_VERSION, store);
    expect(st.pendingReconcile).toEqual(["mission-execution", "mission-completion-gate"]);
    expect(st.deviations.map((d) => d.skill)).toEqual(["mission-execution", "mission-completion-gate"]);
    expect([st.installed, st.upToDateExceptLocal]).toEqual([true, true]);
  });

  it("without a store it still reports installed and up to date for a pristine pack, and a label as a deviation", () => {
    const repo = installed();
    expect(packStatus(repo).upToDate).toBe(true);
    relabel(repo, "mission-execution", "57-local");
    expect(packStatus(repo).deviations.map((d) => d.skill)).toEqual(["mission-execution"]);
  });
});

describe("installPack: retired skills keep what the pack never shipped", () => {
  const plant = (repo: string, rel: string, text: string) => {
    mkdirSync(join(repo, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(repo, ...rel.split("/")), text);
  };

  it("removes only the files the pack shipped for workflow-designer, keeps the user's and reports them", () => {
    const repo = mkdtempClean("octobots-pack-");
    plant(repo, ".claude/skills/workflow-designer/SKILL.md", "---\nname: workflow-designer\nversion: 56\n---\nold");
    plant(repo, ".claude/skills/workflow-designer/my-notes.md", "my notes\n");
    plant(repo, ".claude/skills/workflow-designer/refs/mine.md", "mine\n");

    const res = installPack(PACK_SRC, repo, { store, localChanges: "overwrite" });

    const dir = join(repo, ".claude", "skills", "workflow-designer");
    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(dir, "my-notes.md"), "utf8")).toBe("my notes\n");
    expect(readFileSync(join(dir, "refs", "mine.md"), "utf8")).toBe("mine\n");
    expect(res.keptFiles.sort()).toEqual([".claude/skills/workflow-designer/my-notes.md", ".claude/skills/workflow-designer/refs/mine.md"]);
  });

  it("removes the retired octobots skill's shipped scripts and keeps a script the user added there", () => {
    const repo = mkdtempClean("octobots-pack-");
    plant(repo, ".claude/skills/octobots/SKILL.md", "---\nname: octobots\nversion: 18\n---\nold");
    plant(repo, ".claude/skills/octobots/scripts/validate.js", "// shipped\n");
    plant(repo, ".claude/skills/octobots/scripts/mine.js", "// mine\n");

    const res = installPack(PACK_SRC, repo, { store, localChanges: "overwrite" });

    const dir = join(repo, ".claude", "skills", "octobots");
    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(existsSync(join(dir, "scripts", "validate.js"))).toBe(false);
    expect(readFileSync(join(dir, "scripts", "mine.js"), "utf8")).toBe("// mine\n");
    expect(res.keptFiles).toEqual([".claude/skills/octobots/scripts/mine.js"]);
  });

  it("removes a pristine retired skill entirely when it holds nothing else, and reports nothing kept", () => {
    const repo = mkdtempClean("octobots-pack-");
    plant(repo, ".claude/skills/workflow-designer/SKILL.md", shippedBody("workflow-designer"));
    const res = installPack(PACK_SRC, repo, { store });
    expect(existsSync(join(repo, ".claude", "skills", "workflow-designer"))).toBe(false);
    expect(res.keptFiles).toEqual([]);
    expect(res.pending).toEqual([]);
  });

  it("a changed retired skill is left whole by reconcile and keep (no files removed, none reported)", () => {
    for (const choice of ["reconcile", "keep"] as const) {
      const repo = mkdtempClean("octobots-pack-");
      plant(repo, ".claude/skills/workflow-designer/SKILL.md", "---\nname: workflow-designer\nversion: 56\n---\nlocal");
      plant(repo, ".claude/skills/workflow-designer/my-notes.md", "my notes\n");
      const res = installPack(PACK_SRC, repo, { store, localChanges: choice });
      expect(existsSync(join(repo, ".claude", "skills", "workflow-designer", "SKILL.md")), choice).toBe(true);
      expect(existsSync(join(repo, ".claude", "skills", "workflow-designer", "my-notes.md")), choice).toBe(true);
      expect(res.keptFiles, choice).toEqual([]);
    }
  });
});

describe("installPack: the shipped-skill store and the git budget", () => {
  const snapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        out.push(p.slice(dir.length) + (e.isDirectory() ? "/" : `:${readFileSync(p).toString("base64")}`));
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  };

  it.each(["reconcile", "overwrite", "keep"] as const)("a missing store writes NOTHING and says so (%s), never falling back to overwriting", (choice) => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const f = forks();
    writeFileSync(join(repo, ".claude", "skills", "mission-execution", "SKILL.md"), f["mission-execution"]);
    mkdirSync(join(repo, ".octobots", "pack-updates"), { recursive: true });
    const before = snapshot(repo);

    const res = installPack(PACK_SRC, repo, { store: null, localChanges: choice, hooks: true, tools: false });

    expect(res.error).toBe("shipped-skill store missing");
    expect(res).toMatchObject({ written: 0, pending: [], kept: [], keptFiles: [], hooksRegistered: false });
    expect(snapshot(repo)).toEqual(before);
    expect(readFileSync(join(repo, ".claude", "skills", "mission-execution", "SKILL.md")).equals(f["mission-execution"])).toBe(true);
  });

  it("a missing store on an empty workspace creates nothing", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store: null });
    expect(readdirSync(repo)).toEqual([]);
  });

  it("computes ONE git deadline per install and hands the same one to every recoverBase", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    const f = forks();
    writeFileSync(join(repo, ".claude", "skills", "mission-execution", "SKILL.md"), f["mission-execution"]);
    writeFileSync(join(repo, ".claude", "skills", "mission-completion-gate", "SKILL.md"), f["mission-completion-gate"]);
    mkdirSync(join(repo, ".claude", "skills", "workflow-designer"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "workflow-designer", "SKILL.md"), "---\nname: workflow-designer\nversion: 56\n---\nlocal");
    const spy = vi.mocked(recoverBase);
    spy.mockClear();

    const t0 = Date.now();
    installPack(PACK_SRC, repo, { store });
    const t1 = Date.now();

    expect(spy).toHaveBeenCalledTimes(3);
    const deadlines = spy.mock.calls.map((c) => c[5]?.gitDeadline);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(t0 + GIT_BUDGET_MS);
    expect(deadlines[0]).toBeLessThanOrEqual(t1 + GIT_BUDGET_MS);
  });

  it("a re-install that finds every entry unchanged recovers no base at all", () => {
    const repo = mkdtempClean("octobots-pack-");
    installPack(PACK_SRC, repo, { store });
    writeFileSync(join(repo, ".claude", "skills", "mission-execution", "SKILL.md"), forks()["mission-execution"]);
    installPack(PACK_SRC, repo, { store });
    const spy = vi.mocked(recoverBase);
    spy.mockClear();
    installPack(PACK_SRC, repo, { store });
    expect(spy).not.toHaveBeenCalled();
  });
});
