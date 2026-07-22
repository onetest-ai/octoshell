// Mission-completion gate — Layer 2 trigger.
//
// Registered as a PostToolUse(Bash) hook. When a MISSION (not a task) is
// flipped to `done` via mission-planner's set-status.js, this injects a
// BLOCKING directive telling the orchestrator it must run the
// `mission-completion-gate` skill before the mission is truly complete.
//
// Why a Claude Code hook and not the git pre-commit hook: a git hook is a
// synchronous shell process and cannot spawn the SDLC agents (Sage/Rio/Py/
// Jay). Only an in-session hook can steer the orchestrator into running the
// agent-driven gate. The git pre-commit hook (Layer 1) handles the
// mechanical suites; this handles the agent pipeline + critical review.
//
// Self-gates on .octobots/ so it is inert in non-Octobots repos.
import { existsSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(projectDir, ".octobots"))) process.exit(0);

// ESM-safe stdin slurp.
async function slurpStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Tokenize a shell command respecting single/double quotes. Good enough for
// the set-status.js invocations the board scripts emit (no nested quoting).
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

// Given a full command string, find a set-status.js invocation and return
// {title, state} for it, or null. Handles `&&`-chained commands by scanning
// each segment.
function parseSetStatus(command) {
  for (const seg of command.split(/&&|;|\|\|/)) {
    const toks = tokenize(seg.trim());
    const idx = toks.findIndex((t) => t.endsWith("set-status.js"));
    if (idx === -1) continue;
    // usage: set-status.js <board> <title> <state>
    const args = toks.slice(idx + 1).filter((t) => !t.startsWith("-"));
    if (args.length < 3) continue;
    const state = args[args.length - 1];
    const title = args[args.length - 2];
    return { title, state };
  }
  return null;
}

const raw = await slurpStdin();
let evt;
try {
  evt = JSON.parse(raw);
} catch {
  process.exit(0);
}

if ((evt.tool_name ?? evt.toolName) !== "Bash") process.exit(0);
const command = (evt.tool_input ?? evt.toolInput ?? {}).command ?? "";
if (!command.includes("set-status.js")) process.exit(0);

const parsed = parseSetStatus(command);
if (!parsed) process.exit(0);
if (parsed.state !== "done") process.exit(0);

// Mission ids are `M<n>`; task ids are `T<m>.<n>`. Only missions gate.
const isMission = /^M\d+\b/.test(parsed.title);
const isTask = /^T\d+\.\d+\b/.test(parsed.title);
if (!isMission || isTask) process.exit(0);

const directive = [
  `⛔ MISSION-COMPLETION GATE (blocking) — "${parsed.title}" was just marked \`done\`.`,
  "",
  "A mission is NOT complete until the agent-driven completion gate passes green.",
  "Before you do anything else, invoke the **mission-completion-gate** skill and run it",
  "for this mission. The gate is mandatory and enforces:",
  "",
  "  1. Tests pipeline — Py/Jay run the project's mechanical gate (linters,",
  "     type-checks, full suites); must be green, AND NEW code (changed lines vs",
  "     the base branch) must meet the project's coverage threshold.",
  "  2. QA (Sage), BLACK-BOX — Sage gets ONLY the acceptance criteria + spec, never the",
  "     diff or the code. Sage communicates with Alex (criteria) and Rio (verdict) only.",
  "  3. Critical review (Rio) — Rio reviews the whole-branch diff, then challenges Py/Jay",
  "     directly, defending every acceptance criterion against the implementation.",
  "  4. Merge/complete ONLY on green.",
  "  5. Tokenomics capture (non-blocking) — run",
  "     `node .octobots/tokenomics/run.mjs` and commit the refreshed",
  "     `.octobots/tokenomics/` artifacts. Session transcripts are NOT in git and",
  "     get pruned, so this is the last moment the mission's cost is measurable.",
  "     It never blocks the gate; a failure here is a note, not a stop.",
  "",
  "If the gate surfaces blocking findings, the mission is not done — fix, re-verify, and",
  "only then leave it `done`. Do not rationalize skipping the gate.",
].join("\n");

// PostToolUse additionalContext is the steer channel; the strong wording makes
// it a hard directive the orchestrator must act on before proceeding.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: directive,
    },
  }),
);
process.exit(0);
