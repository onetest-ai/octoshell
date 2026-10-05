// Mission-completion gate — Layer 2 trigger.
//
// Registered as a PostToolUse(Bash) hook. When a MISSION (not a task) is
// flipped to `done` via mission-planner's set-status.js, this injects a
// BLOCKING directive telling the orchestrator it must run the
// `mission-completion-gate` skill before the mission is truly complete.
//
// Why a Claude Code hook and not a git hook: a git hook is a synchronous
// shell process and cannot dispatch the SDLC agents (Sage/Rio/Py/Jay). Only
// an in-session hook can steer the orchestrator into running the agent-driven
// gate. The project's own mechanical gate (linters, type-checks, suites) is
// the project's business; this handles the agent pipeline + critical review.
//
// It fires on the COMMAND, so it checks the effect first (status-flip.mjs): the directive is injected
// only when set-status.js reported a real transition to `done` AND the mission's YAML now says `done`.
//
// Self-gates on .octobots/ so it is inert in non-Octobots repos.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { confirmedTransitions, parseSetStatusAll } from "./status-flip.mjs";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(projectDir, ".octobots"))) process.exit(0);

// ESM-safe stdin slurp.
async function slurpStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await slurpStdin();
let evt;
try {
  evt = JSON.parse(raw);
} catch {
  process.exit(0);
}
if (!evt || typeof evt !== "object") process.exit(0);

if ((evt.tool_name ?? evt.toolName) !== "Bash") process.exit(0);
const command = (evt.tool_input ?? evt.toolInput ?? {})?.command;
if (typeof command !== "string" || !command.includes("set-status.js")) process.exit(0);

// Every `… done` call on a MISSION in the command. Mission ids are `M<n>`; task ids are `T<m>.<n>`.
// Only missions gate. A chain such as `set-status.js <m> "T1.3 - …" done && set-status.js <c> "M1 -
// …" done` must still gate M1, so all calls are considered, not just the first.
const candidates = parseSetStatusAll(command).filter(
  (c) => c.state === "done" && /^M\d+\b/.test(c.title) && !/^T\d+\.\d+\b/.test(c.title),
);
if (candidates.length === 0) process.exit(0);

// Did the board really change? set-status.js prints a transition line only when the status moved;
// the YAML must agree (`; echo` can make a failed set-status exit 0, and an `echo` can forge the line).
// Re-running `done` on a done mission prints `unchanged`, so it does not re-fire the gate.
const titles = (await confirmedTransitions(candidates, evt, projectDir)).map((c) => c.title);
if (titles.length === 0) process.exit(0);
const named = titles.map((t) => `"${t}"`).join(", ");

const directive = [
  `⛔ MISSION-COMPLETION GATE (blocking) — ${named} ${titles.length === 1 ? "was" : "were"} just marked \`done\`.`,
  "",
  "A mission is NOT complete until the agent-driven completion gate passes green.",
  "Before you do anything else, invoke the **mission-completion-gate** skill and run it",
  "for this mission. YOU (the orchestrator) run the phases: dispatch one sub-agent per phase",
  "with the `Agent` tool, in the foreground, one at a time, with an explicit `model:`. Do not",
  "use the Workflow tool. Sub-agents cannot spawn sub-agents, so every question one of them",
  "has for another goes through you. The gate is mandatory and enforces:",
  "",
  "  1. Tests + coverage — dispatch Py/Jay to run the project's mechanical gate (linters,",
  "     type-checks, full suites on the fast lane); green means 0 failed, 0 xfailed or todo,",
  "     no skip without an environmental reason. NEW code (changed lines vs the base branch)",
  "     must meet the project's coverage threshold, measured once on the coverage lane.",
  "  2. QA (Sage), BLACK-BOX — Sage gets ONLY the acceptance criteria + spec, never the",
  "     diff or the code. Sage's questions for Alex (criteria) come back to you; you relay",
  "     them to Alex and hand the answers to Sage. Sage's verdict goes to Rio.",
  "  3. Critical review (Rio) — Rio reviews the whole-branch diff and fixes each blocking",
  "     finding with its regression test. Rio's challenges to Py/Jay come back as",
  "     `questions_for_devs`; you relay them to the devs and bring the answers back to Rio,",
  "     who must defend every acceptance criterion against the implementation. Block on",
  "     `stillOpen` only. One review round and one fix round; anything left is filed as board",
  "     bugs. Where Rio fixed something, Sage re-verifies those criteria, still black-box.",
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
