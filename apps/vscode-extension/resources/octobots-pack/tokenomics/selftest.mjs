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
// Usage: node .octobots/tokenomics/selftest.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VENDOR_YAML = join(REPO, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs");

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

function writeTranscripts(root) {
  const projects = join(root, ".claude", "projects", "proj");
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
  const missionDir = join(root, ".octobots", "campaigns", "demo", "missions", "m1-demo-mission");
  const taskDir = join(missionDir, "tasks", "t1-1-demo-task");
  mkdirSync(taskDir, { recursive: true });

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
  for (const script of ["collect.mjs", "rollup.mjs", "render.mjs"]) {
    execFileSync(process.execPath, [join(HERE, script), "--project-dir", root, "--no-gh", "--quiet"], { stdio: ["ignore", "ignore", "inherit"] });
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
}

if (!existsSync(VENDOR_YAML)) {
  console.log(`  WARN vendored js-yaml not found at ${VENDOR_YAML} — the yaml suite cannot run`);
  failures++;
}

for (const format of ["yaml", "md"]) runSuite(format);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
