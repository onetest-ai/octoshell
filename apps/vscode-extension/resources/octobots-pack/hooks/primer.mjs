// octobots-pack-version: 21
// Shared Octobots session primer. Registered as a SessionStart/compaction hook in each backend
// (Claude/Copilot/Codex). Emits the routing primer as additionalContext in the calling backend's
// JSON shape, but ONLY in an Octobots repo. Self-gates on .octobots/ so it is inert elsewhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PRIMER = [
  "This repository is driven by **Octobots**. Work is organized as campaigns -> missions -> tasks,",
  "plus bugs - each a markdown board under `.octobots/`. Editing those boards (via the scripts in",
  "`.claude/skills/mission-planner/scripts/`) is how you drive the app; there is no API.",
  "- Create work and **file bugs on the board**, not only in GitHub/TMS or another external tracker.",
  "- External **Epic/Story/Task/Defect** map to **campaign/mission/task/bug** - import them onto the",
  "  board, and offer to mirror board items back out.",
  "- **Title missions/tasks as `<id> - name`**: a short hierarchical id then a descriptive name -",
  "  `M3 - Skills workspace`, `T3.1 - Add JWT validation`. A bare id (`T1`) is not a name. Ids are",
  "  `M<n>` for missions and `T<missionN>.<taskN>` for tasks. **Every task needs at least one",
  "  acceptance criterion** (set-criterion.js). Run `validate.js` on each board you create or edit",
  "  and FIX every problem before you finish.",
  "- **Keep statuses current** with set-status.js as you work: mark a task/bug `active` the moment you",
  "  start it and `done` as soon as its acceptance criteria pass - don't leave finished work in `draft`.",
  "- For the full workflow, board anatomy, planning rules, and scripts, use the **mission-planner**",
  "  skill. To build a planned task through to a merged, verified PR, use **mission-execution**.",
].join("\n");

function arg(name) {
  const i = process.argv.indexOf(name);
  const val = i >= 0 ? process.argv[i + 1] : undefined;
  return val !== undefined && !val.startsWith("-") ? val : undefined;
}

function eventName() {
  try {
    const raw = readFileSync(0, "utf8"); // hooks always pipe the event JSON on stdin
    const j = JSON.parse(raw);
    return j.hook_event_name ?? j.hookEventName ?? j.event ?? "SessionStart";
  } catch {
    return "SessionStart";
  }
}

const backend = arg("--backend") ?? "claude";
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!existsSync(join(projectDir, ".octobots"))) {
  process.exit(0); // inert outside an Octobots repo
}

const event = eventName();
const payload =
  backend === "copilot"
    ? { additionalContext: PRIMER }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: PRIMER } };

process.stdout.write(JSON.stringify(payload));
process.exit(0);
