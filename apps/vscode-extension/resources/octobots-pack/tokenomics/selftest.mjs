#!/usr/bin/env node
// Self-test for the tokenomics pipeline.
//
// Builds a synthetic project (board + transcripts) in a temp dir and runs the
// real collect -> rollup -> render scripts against it, asserting the parts that
// are easy to get silently wrong:
//   * requestId dedupe (without it, every token count roughly doubles)
//   * branch -> mission mapping, including the explicit `branches:` override
//   * authored sizing fields surviving into runs.json
//   * orchestrator vs subagent cost split
//   * unattributed work being reported, not dropped
//
// The whole suite runs TWICE — once against a `<kind>.yaml` board and once
// against a legacy `<kind>.md` one. That is not thoroughness for its own sake:
// this file used to build only a Markdown fixture, so it stayed green while the
// rollup read `mission.md` against a fully migrated YAML board, found zero
// missions, and reported the entire board's cost as unattributed. A board-format
// bug must fail here, not in a $1.6k report nobody re-reads.
//
// A separate roots suite covers where transcripts are read from (slug filter, root
// precedence, dedupe) with HOME and CLAUDE_CONFIG_DIR isolated per child process.
//
// Usage: node .octobots/tokenomics/selftest.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
// Installed layout: <repo>/.octobots/tokenomics -> <repo>/.claude/skills/...
// Pack source layout: <pack>/tokenomics -> <pack>/skill/...
const VENDOR_YAML_CANDIDATES = [
  join(REPO, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs"),
  join(HERE, "..", "skill", "mission-planner", "scripts", "vendor", "js-yaml.mjs"),
];
const VENDOR_YAML = VENDOR_YAML_CANDIDATES.find((p) => existsSync(p)) ?? VENDOR_YAML_CANDIDATES[0];

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

// --- synthetic transcripts -------------------------------------------------
function turn({ branch, model = "claude-sonnet-5", requestId, out = 1000, cacheRead = 100000, ts = "2026-07-01T10:00:00.000Z", tool }) {
  return JSON.stringify({
    type: "assistant", gitBranch: branch, requestId, timestamp: ts,
    message: {
      model,
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 500 },
      content: tool ? [{ type: "tool_use", name: tool }] : [],
    },
  });
}

const SESSION = "s0000000-0000-0000-0000-000000000001";

// Claude Code's project slug: every non-alphanumeric char of the absolute path
// becomes "-" (so "/" and "_" and "." all collapse — `applied_ai` is stored as
// `applied-ai`). Deliberately re-stated here, not imported, so the test checks
// collect.mjs against the rule instead of against itself.
const slugOf = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

// Child-process env that can never see the developer's real transcripts: HOME is
// a temp dir and the transcript-root variables are dropped unless a case sets them.
function isolatedEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const k of ["CLAUDE_CONFIG_DIR", "OCTOBOTS_TOKENOMICS_PROJECTS_DIR"]) if (!(k in extra)) delete env[k];
  return env;
}

function writeTranscripts(root) {
  // Legacy repo-local root, under the project's own slug.
  const projects = join(root, ".claude", "projects", slugOf(root));
  mkdirSync(projects, { recursive: true });

  writeFileSync(join(projects, `${SESSION}.jsonl`), [
    // Two records sharing one requestId — streaming duplicate. Must count ONCE.
    turn({ branch: "feat/demo-m1-t1", requestId: "req-1", tool: "Edit" }),
    turn({ branch: "feat/demo-m1-t1", requestId: "req-1", tool: "Edit" }),
    turn({ branch: "feat/demo-m1-t1", requestId: "req-2" }),
    // A branch only reachable via the mission's explicit `branches:` override.
    turn({ branch: "spike/unusual-name", requestId: "req-3" }),
    // Work with no mission — must land in the unattributed bucket.
    turn({ branch: "main", requestId: "req-4" }),
  ].join("\n") + "\n");

  // Two subagents, so the orchestrator/subagent split is exercised — one plain
  // Task subagent, and one Workflow-tool agent nested under `workflows/wf_*/`.
  // The nested case is the regression guard: a flat read of `subagents/` misses
  // every workflow agent, and since mission-execution leans heavily on workflows
  // that silently reports orchestrator_cost_pct as 100%.
  const subDir = join(projects, SESSION, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, "agent-aaa.jsonl"), turn({ branch: "feat/demo-m1-t1", requestId: "req-s1", out: 500 }) + "\n");
  writeFileSync(join(subDir, "agent-aaa.meta.json"), JSON.stringify({ agentType: "python-dev", description: "sub work", spawnDepth: 1 }));

  const wfDir = join(subDir, "workflows", "wf_demo123");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, "agent-bbb.jsonl"), turn({ branch: "feat/demo-m1-t1", requestId: "req-s2", out: 700 }) + "\n");
  writeFileSync(join(wfDir, "agent-bbb.meta.json"), JSON.stringify({ agentType: "js-dev", description: "workflow work", spawnDepth: 1 }));
}

// --- synthetic board -------------------------------------------------------
// One mission, same content in both formats, so every assertion below holds
// identically whichever the rollup had to read.
function writeBoard(root, format) {
  const campaignDir = join(root, ".octobots", "campaigns", "demo");
  const missionDir = join(campaignDir, "missions", "m1-demo-mission");
  const taskDir = join(missionDir, "tasks", "t1-1-demo-task");
  mkdirSync(taskDir, { recursive: true });
  // A directory is a campaign only with its own campaign file (BoardModel's rule, which rollup.mjs
  // follows); without one the mission below would belong to no campaign.
  if (format === "yaml") {
    writeFileSync(join(campaignDir, "campaign.yaml"), "name: Demo campaign\nstatus: active\ndescription: The self-test campaign.\nacceptance_criteria: []\n");
  } else {
    writeFileSync(join(campaignDir, "campaign.md"), "# Demo campaign\n\n## Description\n\nThe self-test campaign.\n");
  }

  if (format === "yaml") {
    writeFileSync(join(missionDir, "mission.yaml"), `name: M1 - Demo mission
status: active
description: |-
  A synthetic mission used by the tokenomics self-test.

  Tracker: aquanautica/vault#999
acceptance_criteria:
  - text: first criterion
    done: true
  - text: second criterion
    done: false
tokenomics:
  effort_days: 3
  size_tshirt: M
  complexity_score: 18
  maturity: pilot
  branches:
    - feat/demo-m1-t1
    - spike/unusual-name
`);
    // Children are folder-derived on a YAML board — the mission never lists them.
    writeFileSync(join(taskDir, "task.yaml"), `name: T1.1 - Demo task
status: done
role: python-dev
acceptance_criteria:
  - text: the task criterion
    done: true
tokenomics:
  effort_days: 1
  size_tshirt: S
`);
    return;
  }

  writeFileSync(join(missionDir, "mission.md"), `# M1 - Demo mission

## Description
A synthetic mission used by the tokenomics self-test.

Tracker: aquanautica/vault#999

## Acceptance Criteria
- [x] first criterion
- [ ] second criterion

## Tasks
- [role:python-dev] [status:done] T1.1 - Demo task

## Tokenomics
effort_days: 3
size_tshirt: M
complexity_score: 18
maturity: pilot
branches: feat/demo-m1-t1, spike/unusual-name
`);
  writeFileSync(join(taskDir, "task.md"), `# T1.1 - Demo task

## Tokenomics
effort_days: 1
size_tshirt: S
`);
}

function runSuite(format) {
  console.log(`\ntokenomics selftest — ${format} board:`);
  const root = mkdtempSync(join(tmpdir(), `tokenomics-selftest-${format}-`));
  const tag = (name) => `[${format}] ${name}`;

  writeTranscripts(root);
  writeBoard(root, format);

  // prices.json is read relative to the project dir, so copy the cached one.
  const tokDir = join(root, ".octobots", "tokenomics");
  mkdirSync(tokDir, { recursive: true });
  writeFileSync(join(tokDir, "prices.json"), readFileSync(join(HERE, "prices.json")));

  // The rollup resolves its YAML parser from the installed pack, so the fixture
  // needs one too — which also exercises that discovery path.
  if (format === "yaml" && existsSync(VENDOR_YAML)) {
    const vendorDir = join(root, ".claude", "skills", "mission-planner", "scripts", "vendor");
    mkdirSync(vendorDir, { recursive: true });
    copyFileSync(VENDOR_YAML, join(vendorDir, "js-yaml.mjs"));
  }

  // --- run the real pipeline -----------------------------------------------
  const emptyHome = mkdtempSync(join(tmpdir(), "tokenomics-selftest-home-"));
  for (const script of ["collect.mjs", "rollup.mjs", "render.mjs"]) {
    execFileSync(process.execPath, [join(HERE, script), "--project-dir", root, "--no-gh", "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(emptyHome) });
  }

  const out = JSON.parse(readFileSync(join(tokDir, "runs.json"), "utf8"));
  const row = out.runs[0];

  check(tag("one mission row produced"), out.runs.length === 1, `got ${out.runs.length}`);
  check(tag("mission identified from the board"), row?._octobots.mission_id === "M1");
  check(tag("mission name read from the board"), row?._octobots.mission_name === "Demo mission", `got ${row?._octobots.mission_name}`);
  check(tag("tracker used as work_item_ref"), row?.work_item_ref === "aquanautica/vault#999");

  // 3 attributed orchestrator turns (req-1 counted once, req-2, req-3) + 2 subagents.
  check(tag("requestId dedupe applied"), row?.turns === 5, `turns=${row?.turns} (6 means the duplicate was double-counted)`);
  check(tag("explicit branches: override honoured"), row?._octobots.branches.includes("spike/unusual-name"));

  check(tag("authored effort_days parsed"), row?.effort_days === 3, `got ${row?.effort_days}`);
  check(tag("authored size_tshirt parsed"), row?.size_tshirt === "M");
  check(tag("authored complexity_score parsed"), row?.complexity_score === 18);
  check(tag("authored maturity parsed"), row?.maturity === "pilot");

  // The task must reach the report with its role, status and its OWN estimate —
  // on a YAML board all three come from task.yaml, not from a parent projection.
  const task = row?._octobots.tasks.find((t) => t.id === "T1.1");
  check(tag("declared task present in the breakdown"), Boolean(task), JSON.stringify(row?._octobots.tasks.map((t) => t.id)));
  check(tag("task name read from the board"), task?.name === "Demo task", `got ${task?.name}`);
  check(tag("task role read from the board"), task?.role === "python-dev", `got ${task?.role}`);
  check(tag("task status read from the board"), task?.status === "done", `got ${task?.status}`);
  check(tag("task effort_days parsed"), task?.effort_days === 1, `got ${task?.effort_days}`);
  check(tag("task size_tshirt parsed"), task?.size_tshirt === "S", `got ${task?.size_tshirt}`);

  check(tag("plain + workflow subagents both counted"), row?.subagent_dispatches === 2, `got ${row?.subagent_dispatches} (1 means workflows/ was not walked)`);
  check(tag("workflow agent type surfaced"), row?._octobots.agent_types.includes("js-dev"), JSON.stringify(row?._octobots.agent_types));
  check(tag("orchestrator split computed"), row?.orchestrator_cost_pct > 50 && row?.orchestrator_cost_pct < 100, `got ${row?.orchestrator_cost_pct}`);
  check(tag("cost is positive"), row?.cost_api_equivalent_usd > 0);
  // net_loc is a derived difference, never a stored one — added/removed must
  // reconcile to it, or the two halves came from different sources.
  check(tag("lines add/remove reconcile with net_loc"),
    row?.net_loc === null || row.net_loc === row.lines_added - row.lines_removed,
    `net=${row?.net_loc} added=${row?.lines_added} removed=${row?.lines_removed}`);
  check(tag("cache_read_share_pct in range"), row?.cache_read_share_pct >= 0 && row?.cache_read_share_pct <= 100);
  check(tag("criteria counted from the board"), row?._octobots.criteria === "1/2", `got ${row?._octobots.criteria}`);

  check(tag("unattributed work reported"), out.unattributed.branches.includes("main"), JSON.stringify(out.unattributed.branches));
  check(tag("unattributed cost is non-zero"), out.unattributed.cost_api_equivalent_usd > 0);
  // The failure this suite exists to catch: a board the rollup cannot read does
  // not error, it quietly reports every dollar as nobody's.
  check(tag("attributed cost is non-zero"), row?.cost_api_equivalent_usd > out.unattributed.cost_api_equivalent_usd * 0.1);

  const html = readFileSync(join(tokDir, "report.html"), "utf8");
  check(tag("report renders the mission"), html.includes("Demo mission"));
  check(tag("report is self-contained"), !/<script\s+src|https?:\/\/[^"']*\.(js|css|woff2?)/i.test(html));

  rmSync(root, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
}

// --- transcript root resolution ---------------------------------------------
function writeSession(projectsRoot, slug, sessionId, turns) {
  const dir = join(projectsRoot, slug);
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i++) lines.push(turn({ branch: "feat/roots-m1", requestId: `${sessionId}-r${i}` }));
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

// `projectDir` is what --project-dir receives (a worktree path in the worktree case); artifacts are
// written beneath it. Each call starts from an empty raw/ dir unless `keepRaw` (the rerun case).
function collectRaw(projectDir, env, extraArgs = [], keepRaw = false) {
  const rawDir = join(projectDir, ".octobots", "tokenomics", "raw");
  if (!keepRaw) rmSync(rawDir, { recursive: true, force: true });
  execFileSync(process.execPath, [join(HERE, "collect.mjs"), "--project-dir", projectDir, "--quiet", ...extraArgs], { stdio: ["ignore", "ignore", "inherit"], env });
  return readFileSync(join(rawDir, "segments.jsonl"), "utf8");
}
const parseSegments = (raw) => raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
function collectSegments(projectDir, env, extraArgs = []) {
  return parseSegments(collectRaw(projectDir, env, extraArgs));
}

function runRootsSuite() {
  console.log("\ntokenomics selftest — transcript roots:");
  const base = mkdtempSync(join(tmpdir(), "tokenomics-selftest-roots-"));
  const mk = (n) => { const d = join(base, n); mkdirSync(d, { recursive: true }); return d; };
  const ids = (segs) => segs.map((s) => s.session_id).sort();

  // Project path contains `_` and `.` on purpose: both must collapse to "-".
  const root = mk("my_proj.v2");
  const slug = slugOf(root);
  const home = mk("home");
  const cfg = mk("cfg");
  const explicit = mk("explicit");

  // AC1. Home default: ~/.claude/projects/<own slug>; other projects' slugs ignored.
  writeSession(join(home, ".claude", "projects"), slug, "home-session", 2);
  writeSession(join(home, ".claude", "projects"), slugOf(join(base, "other_project")), "other-session", 3);
  let segs = collectSegments(root, isolatedEnv(home));
  check("[roots][AC1] ~/.claude/projects is read by default", ids(segs).join() === "home-session", ids(segs).join());
  check("[roots][AC1] other projects' slugs are ignored", !ids(segs).includes("other-session"));
  check("[roots][AC1] slug rule: _ and . become -", segs[0]?.project_slug === slug && !/[._]/.test(slug), segs[0]?.project_slug);

  // AC2. CLAUDE_CONFIG_DIR replaces ~/.claude.
  writeSession(join(cfg, "projects"), slug, "cfg-session", 1);
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg }));
  check("[roots][AC2] CLAUDE_CONFIG_DIR/projects wins over ~/.claude", ids(segs).join() === "cfg-session", ids(segs).join());

  // AC2. Explicit override: env var and --projects-dir both replace the config/home root.
  writeSession(explicit, slug, "explicit-session", 1);
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg, OCTOBOTS_TOKENOMICS_PROJECTS_DIR: explicit }));
  check("[roots][AC2] env override replaces both", ids(segs).join() === "explicit-session", ids(segs).join());
  segs = collectSegments(root, isolatedEnv(home, { CLAUDE_CONFIG_DIR: cfg }), ["--projects-dir", explicit]);
  check("[roots][AC2] --projects-dir replaces both", ids(segs).join() === "explicit-session", ids(segs).join());

  // AC3. Legacy repo-local root merged IN ADDITION; same session in both roots counts once.
  const legacy = join(root, ".claude", "projects");
  writeSession(legacy, slug, "legacy-session", 4);
  writeSession(legacy, slug, "home-session", 5);   // also in the home root, with MORE turns
  writeSession(legacy, "-stale-other-project", "legacy-other", 1);
  const raw1 = collectRaw(root, isolatedEnv(home));
  segs = parseSegments(raw1);
  check("[roots][AC3] legacy root merged with home root", ids(segs).join() === "home-session,legacy-session", ids(segs).join());
  const dup = segs.filter((s) => s.session_id === "home-session");
  check("[roots][AC3] session in both roots is not double-counted, the copy with more turns wins",
    dup.length === 1 && dup[0].turns === 5, JSON.stringify(dup.map((s) => s.turns)));
  check("[roots][AC3] legacy: other slugs ignored too", !ids(segs).includes("legacy-other"));
  const raw2 = collectRaw(root, isolatedEnv(home), [], true);
  check("[roots][AC3] rerun is byte-identical", raw1 === raw2);

  // A worktree resolves to the main checkout's slug and legacy root, never its own.
  const wt = join(root, ".claude", "worktrees", "qa-wt");
  mkdirSync(wt, { recursive: true });
  segs = collectSegments(wt, isolatedEnv(home));
  check("[roots] worktree path resolves to the main checkout's slug", ids(segs).join() === "home-session,legacy-session", ids(segs).join());

  // The project path is resolved first: a trailing slash or a relative --project-dir must not change the slug.
  segs = collectSegments(`${root}/`, isolatedEnv(home));
  check("[roots] a trailing slash on --project-dir does not change the slug", ids(segs).join() === "home-session,legacy-session", ids(segs).join());
  // Relative case: the cwd is a realpath (macOS tmpdir is a symlink), so key the transcript by that.
  const relProj = mk("rel_proj");
  const relSlug = slugOf(realpathSync(relProj));
  writeSession(join(home, ".claude", "projects"), relSlug, "rel-session", 1);
  execFileSync(process.execPath, [join(HERE, "collect.mjs"), "--project-dir", basename(relProj), "--quiet"], { stdio: ["ignore", "ignore", "inherit"], env: isolatedEnv(home), cwd: base });
  segs = parseSegments(readFileSync(join(relProj, ".octobots", "tokenomics", "raw", "segments.jsonl"), "utf8"));
  check("[roots] a relative --project-dir resolves against the cwd", ids(segs).join() === "rel-session", ids(segs).join());

  // AC3, the other direction: the EARLIER root (home) holds the richer copy. The case above has the
  // richer copy in the later (legacy) root, so "last root read wins" would pass it; this one would not.
  writeSession(join(home, ".claude", "projects"), slug, "rich-home-session", 6);
  writeSession(legacy, slug, "rich-home-session", 3);
  segs = collectSegments(root, isolatedEnv(home));
  const rich = segs.filter((s) => s.session_id === "rich-home-session");
  check("[roots][AC3] more turns wins even when the richer copy is in the earlier root, not just the last one read",
    rich.length === 1 && rich[0].turns === 6, JSON.stringify(rich.map((s) => s.turns)));

  // Isolation: the PARENT process env holds a decoy HOME and CLAUDE_CONFIG_DIR, each with a session
  // under this project's own slug. A child built with isolatedEnv must see neither. If it did, a
  // developer's real transcripts would leak into this selftest and make it machine-dependent.
  const decoyHome = mk("decoy-home");
  const decoyCfg = mk("decoy-cfg");
  writeSession(join(decoyHome, ".claude", "projects"), slug, "decoy-home-session", 1);
  writeSession(join(decoyCfg, "projects"), slug, "decoy-cfg-session", 1);
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = decoyHome;
  process.env.CLAUDE_CONFIG_DIR = decoyCfg;
  try {
    segs = collectSegments(root, isolatedEnv(home));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  check("[roots][isolation] the caller's CLAUDE_CONFIG_DIR does not leak in", !ids(segs).includes("decoy-cfg-session"), ids(segs).join());
  check("[roots][isolation] the caller's HOME does not leak in", !ids(segs).includes("decoy-home-session"), ids(segs).join());
  check("[roots][isolation] the isolated child still reads its own HOME", ids(segs).includes("home-session"), ids(segs).join());

  rmSync(base, { recursive: true, force: true });
}

if (!existsSync(VENDOR_YAML)) {
  console.log(`  WARN vendored js-yaml not found at ${VENDOR_YAML} — the yaml suite cannot run`);
  failures++;
}

for (const format of ["yaml", "md"]) runSuite(format);
runRootsSuite();

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
