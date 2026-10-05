import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";
import { PRE_MISSION_PRIMER, PRE_MISSION_PRIMER_LINES } from "./fixtures/pre-mission-primer.js";
import { GRAPH_RELATIVE_PATH } from "../src/host/octograph-install.js";
import { artifactPath, graphCommand } from "../src/host/octograph.js";
import { findLegacyWorkflowFolders, isCampaignDir } from "../resources/octobots-pack/skill/mission-planner/scripts/legacy-workflows.mjs";

const PRIMER = join(__dirname, "..", "resources", "octobots-pack", "hooks", "primer.mjs");
const PRIMER_SRC = readFileSync(PRIMER, "utf8");
const EXTENSION_PACKAGE_JSON = join(__dirname, "..", "package.json");

/** Forward-slash a path so it can be compared against text meant for a human to read. */
function posix(path: string): string {
  return path.split(sep).join("/");
}

function run(backend: string, cwd: string, event = "SessionStart"): string {
  return execFileSync("node", [PRIMER, "--backend", backend], {
    cwd,
    input: JSON.stringify({ hook_event_name: event }),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** The `additionalContext` the hook emitted, in whichever shape the backend uses. */
function context(backend: string, cwd: string, event = "SessionStart"): string {
  const parsed = JSON.parse(run(backend, cwd, event));
  return backend === "copilot"
    ? parsed.additionalContext
    : parsed.hookSpecificOutput.additionalContext;
}

function repoWithOctobots(): string {
  const dir = mkdtempClean("octo-repo-");
  mkdirSync(join(dir, ".octobots"), { recursive: true });
  return dir;
}

/** A board repo, optionally with `.octobots/graph/map.md` written with `content`. */
function repoWithMap(content: string | undefined): string {
  const dir = repoWithOctobots();
  if (content !== undefined) {
    mkdirSync(join(dir, ".octobots", "graph"), { recursive: true });
    writeFileSync(join(dir, ".octobots", "graph", "map.md"), content);
  }
  return dir;
}

/**
 * The map block is ADDITIVE: every line the primer emitted before this mission must still be
 * there, in order, whichever map.md case is hit.
 *
 * Checked against `PRE_MISSION_PRIMER_LINES` — a FROZEN snapshot of the mission branch's primer,
 * never a read of `primer.mjs` itself. See that fixture for why, and for the planted violation
 * that proved the loose three-substring version of this helper enforced nothing.
 */
function expectPreMissionPrimerIntact(additionalContext: string): void {
  for (const line of PRE_MISSION_PRIMER_LINES) {
    expect(additionalContext).toContain(line);
  }
  // ...and in the original order, unedited, as the block the context still opens with.
  expect(additionalContext.startsWith(PRE_MISSION_PRIMER)).toBe(true);
}

/**
 * `MAP_MD_MAX_BYTES` as `primer.mjs` actually declares it.
 *
 * Read from source on purpose, and only in the `const NAME = <byte expression>` form: T6.4
 * criterion 5 requires the cap to be a NAMED CONSTANT expressed in bytes, so inlining the literal
 * at the comparison must break something. It breaks this — the parse throws and every boundary
 * test below fails by name. The tests then use the parsed value to pin that this constant is the
 * threshold the code actually enforces, which no amount of source-grepping could establish.
 */
function declaredMaxBytes(): number {
  const m = /^const MAP_MD_MAX_BYTES = (\d+)(?:\s*\*\s*(\d+))?;/m.exec(PRIMER_SRC);
  if (!m) throw new Error("primer.mjs no longer declares `const MAP_MD_MAX_BYTES = <bytes>;`");
  return Number(m[1]) * (m[2] === undefined ? 1 : Number(m[2]));
}

/** The appended block: everything after the pre-mission primer and its separating blank line. */
function appendedBlock(additionalContext: string): string {
  return additionalContext.slice(PRE_MISSION_PRIMER.length + "\n\n".length);
}

describe("primer.mjs", () => {
  it("emits Claude/Codex hookSpecificOutput JSON with the primer when .octobots exists", () => {
    const out = run("claude", repoWithOctobots());
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Octobots");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/file bugs on the board/i);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/Epic\/Story\/Task/i);
  });

  it("uses the calling event name in hookEventName", () => {
    const out = run("codex", repoWithOctobots(), "PreCompact");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PreCompact");
  });

  it("emits Copilot additionalContext shape", () => {
    const out = run("copilot", repoWithOctobots());
    const parsed = JSON.parse(out);
    expect(parsed.additionalContext).toContain("Octobots");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("emits NOTHING when there is no .octobots directory", () => {
    const dir = mkdtempClean("plain-repo-");
    expect(run("claude", dir).trim()).toBe("");
  });

  describe("map.md injection", () => {
    it("injects map.md's body when present and under the size cap", () => {
      const marker = "octograph-map-body-marker: module a -> module b";
      const dir = repoWithMap(`# Architecture map\n\n${marker}\n`);
      const ctx = context("claude", dir);
      expect(ctx).toContain(marker);
      expectPreMissionPrimerIntact(ctx);
    });

    it("injects the map for the Copilot backend too — one code path, both shapes", () => {
      const marker = "octograph-map-body-marker: copilot";
      const dir = repoWithMap(`# Architecture map\n\n${marker}\n`);
      expect(context("copilot", dir)).toContain(marker);
    });

    it("emits a one-line pointer, never the map body, when map.md is present but over the cap", () => {
      const big = "x".repeat(200_000); // comfortably over any sane byte cap
      const dir = repoWithMap(big);
      const ctx = context("claude", dir);
      expect(ctx).not.toContain(big.slice(0, 200)); // no fragment of the body, truncated or not
      expect(ctx).toMatch(/\.octobots\/graph\/map\.md/);
      expectPreMissionPrimerIntact(ctx);

      // The appended block is exactly one line — a pointer, not a document.
      const pointer = appendedBlock(ctx);
      expect(pointer.includes("\n")).toBe(false);
      expect(pointer).toMatch(/\.octobots\/graph\/map\.md/);
    });

    it("emits that same one-line pointer, naming where the map would be and how to build it, when there is no map.md at all", () => {
      const dir = repoWithMap(undefined);
      const ctx = context("claude", dir);
      expect(ctx).toMatch(/\.octobots\/graph\/map\.md/);
      expect(ctx).toMatch(/octograph\.mjs setup/);
      expectPreMissionPrimerIntact(ctx);

      const pointer = appendedBlock(ctx);
      expect(pointer.includes("\n")).toBe(false);
    });

    it("emits the pointer for a present-but-EMPTY map.md, never an 'Architecture map:' heading over nothing", () => {
      // A zero-byte map.md is what a killed or failed `octograph map` run leaves behind. Announcing
      // it as the architecture map is a claim with no observation behind it — the same defect shape
      // as injecting a truncated one.
      const ctx = context("claude", repoWithMap(""));
      const block = appendedBlock(ctx);
      expect(block.includes("\n")).toBe(false);
      expect(block).toMatch(/^No architecture map at/);
      expectPreMissionPrimerIntact(ctx);
    });

    it("falls back to the pointer when map.md is a DIRECTORY, rather than crashing the hook", () => {
      const dir = repoWithOctobots();
      mkdirSync(join(dir, ".octobots", "graph", "map.md"), { recursive: true });
      const block = appendedBlock(context("claude", dir));
      expect(block).toMatch(/^No architecture map at/);
    });
  });

  describe("the size cap is the named constant, and it is what gets enforced", () => {
    it("injects a map of EXACTLY MAP_MD_MAX_BYTES — the cap is inclusive", () => {
      const cap = declaredMaxBytes();
      const body = "y".repeat(cap);
      const ctx = context("claude", repoWithMap(body));
      expect(ctx).toContain(body); // the WHOLE body, not a prefix of it
      expectPreMissionPrimerIntact(ctx);
    });

    it("emits the pointer at MAP_MD_MAX_BYTES + 1 — one byte over is over", () => {
      const cap = declaredMaxBytes();
      const body = "y".repeat(cap + 1);
      const ctx = context("claude", repoWithMap(body));
      expect(ctx).not.toContain("y".repeat(200));
      expect(appendedBlock(ctx)).toMatch(/exceeds \d+ bytes/);
    });

    it("JSON-encodes an at-cap map without corrupting it — markdown, newlines and all", () => {
      // Scoped to what this actually observes: a body at the cap containing the characters JSON
      // has to escape survives `JSON.parse` intact. It does NOT prove the stdout write drained —
      // see "exits only after stdout drains" below for why that cannot be observed here.
      const cap = declaredMaxBytes();
      const prefix = `# map\n"quoted"\tand \\ escaped\n`; // every character JSON must escape
      const body = prefix + "z".repeat(cap - Buffer.byteLength(prefix));
      expect(Buffer.byteLength(body)).toBe(cap); // exactly at the cap, so it is still injected
      const ctx = context("claude", repoWithMap(body));
      expect(ctx).toContain(body);
    });

    /**
     * `process.stdout` is ASYNCHRONOUS when it is a pipe — which is what a hook runner hands the
     * primer — so a bare `process.exit(0)` after the write discards whatever has not flushed. A
     * truncated payload is not a shorter primer: it is unparseable JSON, so the session silently
     * gets NO context at all.
     *
     * This is asserted against the SOURCE, deliberately, and the alternative was measured rather
     * than assumed: reverting the fix to `write(...); process.exit(0)` and re-running every
     * behavioural test in this file leaves all of them GREEN (verified 2026-08-11). It has to —
     * the whole payload is bounded by MAP_MD_MAX_BYTES + the primer, ~34 KB, which fits inside a
     * pipe buffer on the platforms we run on, and `execFileSync` drains concurrently besides. A
     * black-box test of this property would need a payload this file's own cap forbids, so it
     * would pass everywhere and prove nothing — exactly the guard-shaped-hole this campaign keeps
     * shipping. What IS checkable is that the exit stays sequenced behind the write's completion
     * callback; delete that callback and this fails by name.
     */
    it("exits only after stdout drains — the write's callback gates process.exit", () => {
      expect(PRIMER_SRC).toMatch(
        /process\.stdout\.write\([^\n]*,\s*\(\)\s*=>\s*process\.exit\(0\)\)/,
      );
      // ...and there is no OTHER, un-gated exit racing it after the payload is built.
      const afterPayload = PRIMER_SRC.slice(PRIMER_SRC.indexOf("const payload ="));
      expect(afterPayload).not.toMatch(/^\s*process\.exit\(/m);
    });
  });

  /**
   * `primer.mjs` ships standalone — bare `node`, someone else's workspace, no node_modules, no
   * build step — so it can import neither `@octoshell/graph` (mission criterion 4) nor the
   * extension's own host modules. Every constant it names in its message is therefore a SECOND
   * SPELLING of a rule that already exists in TypeScript.
   *
   * This is ONE shared list of those duplications, and it is the whole guard: each entry imports
   * the real twin and asserts the primer's emitted output carries it verbatim. Prose
   * cross-references alone are what let this campaign's earlier duplications drift — a rename on
   * the TypeScript side left the copy pointing at something that no longer existed, and nothing
   * failed. Rename `GRAPH_RELATIVE_PATH`, reshape `graphCommand`, move `artifactPath`, or retitle
   * the `octoshell.installGraph` command, and the corresponding case below fails by name.
   */
  describe("duplicated rules stay pinned to their TypeScript twins", () => {
    const DUPLICATED_RULES: { id: string; twin: string; expected: (repo: string) => string }[] = [
      {
        id: "graph-cli-relative-path",
        twin: "octograph-install.ts → GRAPH_RELATIVE_PATH",
        expected: () => posix(GRAPH_RELATIVE_PATH),
      },
      {
        id: "graph-setup-command",
        twin: "octograph.ts → graphCommand('setup')",
        expected: () => posix(graphCommand("setup")),
      },
      {
        id: "map-md-default-path",
        twin: "octograph.ts → artifactPath (board branch) + cli.ts's 'map.md'",
        expected: (repo) => `${posix(relative(repo, artifactPath(repo)))}/map.md`,
      },
      {
        id: "install-graph-command-title",
        twin: "package.json → contributes.commands[octoshell.installGraph].title",
        expected: () => {
          const pkg = JSON.parse(readFileSync(EXTENSION_PACKAGE_JSON, "utf8"));
          const cmd = pkg.contributes.commands.find(
            (c: { command: string }) => c.command === "octoshell.installGraph",
          );
          if (!cmd) throw new Error("octoshell.installGraph is no longer a contributed command");
          return cmd.title as string;
        },
      },
    ];

    it.each(DUPLICATED_RULES)("$id is spelled the same as $twin", ({ expected }) => {
      const repo = repoWithOctobots(); // no map.md: the absent-map pointer names all four
      // The absent-map pointer is the one message that names all four.
      expect(context("claude", repo)).toContain(expected(repo));
    });

    it("names a command the graph CLI actually dispatches, not one it would reject", () => {
      // The pointer tells an agent to run `… octograph.mjs setup`. `setup` is handled OUTSIDE the
      // CLI's `COMMANDS` table (it runs before `runCli`), so a grep of `COMMANDS` would wrongly
      // call it unknown — and equally, deleting the dispatch would leave this pointer sending
      // agents at a command that errors out. Pinned against the shipped payload.
      const payload = readFileSync(
        join(__dirname, "..", "resources", "octobots-pack", "graph", "octograph.mjs"),
        "utf8",
      );
      expect(payload).toMatch(/argv\[0\] === "setup"/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// M7 T7.5: the one-line health sentence that points the agent at the octobots-doctor skill.
// ---------------------------------------------------------------------------------------------

const HEAD = "Octobots health: run the octobots-doctor skill before or alongside the user's task.";
const PENDING_CASES = (JSON.parse(readFileSync(join(__dirname, "fixtures", "pending-cases.json"), "utf8")) as {
  cases: Array<{ name: string; text: string; expected: { packVersion: number | null; reconcile: string[]; kept: string[] } }>;
}).cases;
const caseText = (name: string): string => PENDING_CASES.find((c) => c.name === name)!.text;

/** The primer's `additionalContext` with CLAUDE_PROJECT_DIR at `ws`; throws on a non-zero exit. */
function healthContext(ws: string, opts: { event?: string; configDir?: string } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: ws };
  delete env.CLAUDE_CONFIG_DIR;
  if (opts.configDir !== undefined) env.CLAUDE_CONFIG_DIR = opts.configDir;
  const out = execFileSync("node", [PRIMER, "--backend", "claude"], {
    cwd: ws,
    env,
    input: JSON.stringify({ hook_event_name: opts.event ?? "SessionStart" }),
    encoding: "utf8",
    timeout: 15_000, // a primer that blocks on a read fails here instead of hanging the suite
  });
  return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

/** The health line, or null when the context has none. */
function healthLine(ctx: string): string | null {
  return ctx.split("\n").find((l) => l.startsWith("Octobots health:")) ?? null;
}

function write(ws: string, rel: string, text: string): void {
  const file = join(ws, ...rel.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

const pendingJson = (ws: string, text: string): void => write(ws, ".octobots/pack-updates/pending.json", text);
// The campaign holding `rel` gets a campaign.yaml: a dir under campaigns/ without one is no campaign
// to the board model, and the primer (like doctor.js and validateBoard) ignores its workflows/.
const workflowsDir = (ws: string, rel: string): void => {
  const campaign = /^campaigns\/[^/]+/.exec(rel)?.[0];
  if (campaign) write(ws, `.octobots/${campaign}/campaign.yaml`, "name: C\n");
  write(ws, `.octobots/${rel}/run/workflow.js`, "x\n");
};
const acks = (ws: string, list: Array<{ finding: string; path: string }>): void =>
  write(ws, ".octobots/doctor-acks.json", JSON.stringify({ acknowledged: list.map((a) => ({ ...a, date: "2026-10-05" })) }));

describe("primer.mjs health line (octobots-doctor)", () => {
  it.each(["SessionStart", "PreCompact"])("%s: two pending reconciles plus a workflows/ folder produce exactly the AC line", (event) => {
    const ws = repoWithOctobots();
    pendingJson(ws, caseText("valid"));
    workflowsDir(ws, "campaigns/c1/workflows");
    const ctx = healthContext(ws, { event });
    expect(healthLine(ctx)).toBe(
      `${HEAD} Pending pack reconciles: mission-execution, mission-completion-gate (.octobots/pack-updates/v57/). Leftover workflows/ folders: 1.`,
    );
    // ONE line, appended after the routing primer and the graph block, never edited into them.
    expect(ctx.startsWith(PRE_MISSION_PRIMER)).toBe(true);
    expect(ctx.trimEnd().endsWith("Leftover workflows/ folders: 1.")).toBe(true);
    expect(ctx.split("\n").filter((l) => l.startsWith("Octobots health:"))).toHaveLength(1);
  });

  it("a kept-only record with no workflows/ folder adds no line", () => {
    const ws = repoWithOctobots();
    pendingJson(ws, caseText("kept-only"));
    expect(healthLine(healthContext(ws))).toBeNull();
  });

  it("workflows/ folders only: the line names the count, not pack-updates", () => {
    const ws = repoWithOctobots();
    workflowsDir(ws, "campaigns/c1/workflows");
    workflowsDir(ws, "campaigns/c1/missions/m1/workflows");
    // A second slug in the same workflows/ folder is still one folder; and these are not counted at all:
    workflowsDir(ws, "campaigns/c1/workflows/extra-slug-parent");
    workflowsDir(ws, "campaigns/c1/missions/m1/tasks/t1/workflows");
    workflowsDir(ws, "workflows");
    write(ws, ".octobots/campaigns/c1/missions/m1/notes/workflows", "a file named workflows\n");
    expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 2.`);
  });

  it("the same folders acknowledged in doctor-acks.json: no line; one of two acknowledged: count 1", () => {
    const ws = repoWithOctobots();
    workflowsDir(ws, "campaigns/c1/workflows");
    workflowsDir(ws, "campaigns/c1/missions/m1/workflows");
    acks(ws, [{ finding: "workflows", path: "campaigns/c1/workflows" }]);
    expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
    acks(ws, [
      { finding: "workflows", path: "campaigns/c1/workflows" },
      { finding: "workflows", path: "campaigns/c1/missions/m1/workflows" },
    ]);
    expect(healthLine(healthContext(ws))).toBeNull();
  });

  it("an acknowledgement for another finding does not hide the workflows", () => {
    const ws = repoWithOctobots();
    workflowsDir(ws, "campaigns/c1/workflows");
    acks(ws, [{ finding: "config-dir", path: ".claude" }]);
    expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
  });

  it("a pending entry acknowledged in doctor-acks.json is still named", () => {
    const ws = repoWithOctobots();
    pendingJson(ws, caseText("valid"));
    acks(ws, [
      { finding: "pack-reconcile", path: "mission-execution" },
      { finding: "pack-reconcile", path: ".octobots/pack-updates/v57/mission-execution" },
      { finding: "pending", path: "mission-execution" },
    ]);
    expect(healthLine(healthContext(ws))).toBe(
      `${HEAD} Pending pack reconciles: mission-execution, mission-completion-gate (.octobots/pack-updates/v57/).`,
    );
  });

  it("CLAUDE_CONFIG_DIR=<workspace>/.claude alone: the line names it", () => {
    const ws = repoWithOctobots();
    const configDir = join(ws, ".claude");
    expect(healthLine(healthContext(ws, { configDir }))).toBe(`${HEAD} CLAUDE_CONFIG_DIR is set to ${configDir}.`);
    // a trailing slash is the same directory
    expect(healthLine(healthContext(ws, { configDir: `${configDir}/` }))).toBe(`${HEAD} CLAUDE_CONFIG_DIR is set to ${configDir}.`);
  });

  it("CLAUDE_CONFIG_DIR elsewhere, or acknowledged, adds no line", () => {
    const ws = repoWithOctobots();
    expect(healthLine(healthContext(ws, { configDir: join(repoWithOctobots(), ".claude") }))).toBeNull();
    acks(ws, [{ finding: "config-dir", path: ".claude" }]);
    expect(healthLine(healthContext(ws, { configDir: join(ws, ".claude") }))).toBeNull();
  });

  it("sentences come in the order reconciles, workflows, config dir", () => {
    const ws = repoWithOctobots();
    pendingJson(ws, caseText("rule-5-base-null"));
    workflowsDir(ws, "campaigns/c1/workflows");
    const configDir = join(ws, ".claude");
    expect(healthLine(healthContext(ws, { configDir }))).toBe(
      `${HEAD} Pending pack reconciles: mission-execution (.octobots/pack-updates/v57/). Leftover workflows/ folders: 1. CLAUDE_CONFIG_DIR is set to ${configDir}.`,
    );
  });

  it.each(["malformed", "malformed-dir-traversal", "malformed-duplicate-skill", "empty-file"])(
    "a malformed pending.json (%s): normal output, exit 0, no reconcile sentence",
    (name) => {
      const ws = repoWithOctobots();
      pendingJson(ws, caseText(name));
      const ctx = healthContext(ws); // execFileSync throws on a non-zero exit
      expect(ctx.startsWith(PRE_MISSION_PRIMER)).toBe(true);
      expect(ctx).not.toContain("Pending pack reconciles");
      expect(healthLine(ctx)).toBeNull();
    },
  );

  it("a malformed pending.json does not hide the other findings", () => {
    const ws = repoWithOctobots();
    pendingJson(ws, caseText("malformed"));
    workflowsDir(ws, "campaigns/c1/workflows");
    expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
  });

  it.each(["{not json", "[]", '{"acknowledged": "yes"}', '{"acknowledged": [null, 3, {"finding": 1}]}'])(
    "a malformed doctor-acks.json (%s) acknowledges nothing and breaks nothing",
    (text) => {
      const ws = repoWithOctobots();
      workflowsDir(ws, "campaigns/c1/workflows");
      write(ws, ".octobots/doctor-acks.json", text);
      expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
    },
  );

  describe("user-controlled files cannot hang, bloat or redirect the primer (it runs at every session start)", () => {
    it.skipIf(process.platform === "win32")("a FIFO at pending.json or doctor-acks.json is skipped, not read", () => {
      const ws = repoWithOctobots();
      workflowsDir(ws, "campaigns/c1/workflows");
      mkdirSync(join(ws, ".octobots", "pack-updates"), { recursive: true });
      execFileSync("mkfifo", [join(ws, ".octobots", "pack-updates", "pending.json"), join(ws, ".octobots", "doctor-acks.json")]);
      expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
    });

    it("a pending.json or doctor-acks.json over 256 KiB is not read", () => {
      const ws = repoWithOctobots();
      workflowsDir(ws, "campaigns/c1/workflows");
      const rec = JSON.parse(caseText("valid")) as { pad?: string };
      rec.pad = "x".repeat(300 * 1024);
      pendingJson(ws, JSON.stringify(rec));
      write(ws, ".octobots/doctor-acks.json", JSON.stringify({
        acknowledged: [{ finding: "workflows", path: "campaigns/c1/workflows", date: "2026-10-05" }],
        pad: "x".repeat(300 * 1024),
      }));
      expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 1.`);
    });

    it.skipIf(process.platform === "win32")("a symlinked pending.json is not followed", () => {
      const ws = repoWithOctobots();
      const outside = join(mkdtempClean("primer-outside-"), "pending.json");
      writeFileSync(outside, caseText("valid"));
      mkdirSync(join(ws, ".octobots", "pack-updates"), { recursive: true });
      symlinkSync(outside, join(ws, ".octobots", "pack-updates", "pending.json"));
      expect(healthLine(healthContext(ws))).toBeNull();
    });
  });

  describe("doctor-acks.json keys (the contract T7.6's octobots-doctor writes)", () => {
    it("a config-dir acknowledgement needs no path", () => {
      const ws = repoWithOctobots();
      write(ws, ".octobots/doctor-acks.json", JSON.stringify({ acknowledged: [{ finding: "config-dir", date: "2026-10-05" }] }));
      expect(healthLine(healthContext(ws, { configDir: join(ws, ".claude") }))).toBeNull();
    });

    it("a workflows path with ./, a trailing / or backslashes is the same folder; a slug inside it is not", () => {
      const ws = repoWithOctobots();
      workflowsDir(ws, "campaigns/c1/workflows");
      workflowsDir(ws, "campaigns/c1/missions/m1/workflows");
      acks(ws, [
        { finding: "workflows", path: "./campaigns/c1/workflows/" },
        { finding: "workflows", path: "campaigns\\c1\\missions\\m1\\workflows" },
      ]);
      expect(healthLine(healthContext(ws))).toBeNull();
      acks(ws, [{ finding: "workflows", path: "campaigns/c1/workflows/run" }]);
      expect(healthLine(healthContext(ws))).toBe(`${HEAD} Leftover workflows/ folders: 2.`);
    });
  });

  it("nothing to report: no line at all", () => {
    const ws = repoWithOctobots();
    mkdirSync(join(ws, ".octobots", "campaigns", "c1", "missions", "m1"), { recursive: true });
    expect(healthLine(healthContext(ws))).toBeNull();
    expect(healthContext(ws)).not.toContain("octobots-doctor");
  });

  it("is silent with an unreadable campaigns entry (a file where a folder is expected)", () => {
    const ws = repoWithOctobots();
    write(ws, ".octobots/campaigns/stray.txt", "x\n");
    write(ws, ".octobots/campaigns/c1/missions", "not a folder\n");
    expect(healthLine(healthContext(ws))).toBeNull();
  });

  describe("workflows/ counting agrees with legacy-workflows.mjs (the doctor/validate rule)", () => {
    const LAYOUTS: Array<{ name: string; dirs: string[]; empties?: string[]; strays?: string[] }> = [
      { name: "none", dirs: [] },
      { name: "campaign level", dirs: ["campaigns/a/workflows"] },
      { name: "mission level", dirs: ["campaigns/a/missions/m1/workflows", "campaigns/a/missions/m2/workflows"] },
      { name: "both levels, two campaigns", dirs: ["campaigns/a/workflows", "campaigns/a/missions/m1/workflows", "campaigns/b/missions/m9/workflows"] },
      { name: "an empty workflows/ folder", dirs: [], empties: ["campaigns/a/missions/m1/workflows"] },
      // a dir under campaigns/ with no campaign.yaml/.md is no campaign: its workflows/ are not counted
      { name: "a campaign dir with no campaign.yaml beside a real one", dirs: ["campaigns/a/workflows"], strays: ["campaigns/stray/missions/m1/workflows/x"] },
    ];

    it.each(LAYOUTS)("$name", ({ dirs, empties, strays }) => {
      const ws = repoWithOctobots();
      for (const d of dirs) workflowsDir(ws, d);
      for (const d of empties ?? []) {
        write(ws, `.octobots/${/^campaigns\/[^/]+/.exec(d)![0]}/campaign.yaml`, "name: C\n");
        mkdirSync(join(ws, ".octobots", ...d.split("/")), { recursive: true });
      }
      for (const d of strays ?? []) mkdirSync(join(ws, ".octobots", ...d.split("/")), { recursive: true });
      const base = join(ws, ".octobots");
      const campaigns = join(base, "campaigns");
      // The rule's own answer: each reported path is a workflows/ folder or a slug inside one.
      const reported = new Set<string>();
      const all = [...dirs, ...(empties ?? []), ...(strays ?? [])];
      for (const c of [...new Set(all.map((d) => d.split("/")[1]!))].filter((c) => isCampaignDir(join(campaigns, c)))) {
        for (const p of findLegacyWorkflowFolders(join(campaigns, c), base)) {
          reported.add(p.split("/").slice(0, p.split("/").lastIndexOf("workflows") + 1).join("/"));
        }
      }
      const line = healthLine(healthContext(ws));
      expect(line === null ? 0 : Number(/Leftover workflows\/ folders: (\d+)\./.exec(line)![1])).toBe(reported.size);
    });
  });
});
