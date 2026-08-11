// octobots-pack-version: 42
// Shared Octobots session primer. Registered as a SessionStart/compaction hook in each backend
// (Claude/Copilot/Codex). Emits the routing primer as additionalContext in the calling backend's
// JSON shape, but ONLY in an Octobots repo. Self-gates on .octobots/ so it is inert elsewhere.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PRIMER = [
  "This repository is driven by **Octobots**. Work is organized as campaigns -> missions -> tasks,",
  "plus bugs - each a `<kind>.yaml` file (campaign.yaml/mission.yaml/task.yaml/bug.yaml) under",
  "`.octobots/`. Children are folder-derived: a parent NEVER lists its tasks/bugs, and status/role/",
  "severity live as fields in the child's own yaml. Editing those files (via the scripts in",
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
  "- **Work in THIS repo checkout - never a git worktree or a second clone.** A worktree carries only",
  "  tracked files: no `.octobots/` board, no `.claude/` skills, no node_modules. Isolation comes from",
  "  **branches**: a mission is a feature branch, each task is a small PR into it, and the mission PR",
  "  goes feature-branch -> main once green. One tree, one branch at a time - never two writers at once.",
  "- For the full workflow, board anatomy, planning rules, and scripts, use the **mission-planner**",
  "  skill. To build a planned task through to a merged, verified PR, use **mission-execution**.",
].join("\n");

/**
 * Max size of `map.md`, in bytes, injected as raw session context.
 *
 * `map.md`'s own generation target (`packages/graph/src/config.ts`'s `budgetTokens`, default
 * 2000, estimated at ~4 bytes/token by the same `chars/4` estimator `render.ts` uses without
 * tiktoken — so ~8000 bytes) is a RENDERING target, not a limit: `--budget` is user-configurable
 * and a repo can raise it arbitrarily, or hand-edit the file afterwards. This cap is a SEPARATE,
 * primer-side defence independent of whatever `--budget` produced, so a workspace that raised its
 * budget never balloons the context injected on every SessionStart/PreCompact. Set to 4x the
 * default budget's byte estimate, rounded to a clean 32 KB: generous headroom for a moderately
 * raised `--budget`, still bounded.
 */
const MAP_MD_MAX_BYTES = 32 * 1024; // 32 KB

/**
 * Same relative path as `octograph-install.ts`'s exported `GRAPH_RELATIVE_PATH` (in
 * `apps/vscode-extension/src/host/`). Not importable here — this script ships standalone, run
 * under bare `node` in an unrelated workspace with no node_modules and no TypeScript build step,
 * the same constraint `entity-io.mjs` operates under. Hand-duplicated; cross-referenced so a
 * rename of the installed location does not silently orphan this pointer.
 */
const GRAPH_CLI_RELATIVE_PATH = ".claude/skills/graph/octograph.mjs";

/** Display-only, forward-slashed regardless of OS — this is a message a person reads, not a path
 *  handed to a command. */
const MAP_MD_DISPLAY_PATH = ".octobots/graph/map.md";

/**
 * Where octograph writes `map.md` for THIS workspace: `.octobots/graph/map.md`.
 *
 * This is one of `packages/graph/src/artifact.ts`'s `resolveOut` two default branches (the
 * `hasBoard(repoRoot)` TRUE case) — the same rule `apps/vscode-extension/src/host/octograph.ts`'s
 * `artifactPath` also hand-duplicates, for the identical reason: this script cannot import
 * `@octoshell/graph` (mission criterion 4) or the extension's TypeScript (it ships standalone).
 * Unlike `artifactPath`, this copy only ever needs the board-present branch: the `.octobots`
 * existence check just above this function's only call site already exits the whole process
 * before this runs, so the `.octograph` fallback `artifactPath`/`resolveOut` both define for a
 * boardless workspace is unreachable here and is deliberately not re-derived. If that early exit
 * is ever removed, this needs the same two-branch check `artifactPath` has — cross-referenced here
 * so that dependency stays visible.
 */
function mapMdPath(projectDir) {
  return join(projectDir, ".octobots", "graph", "map.md");
}

/**
 * The additive architecture-map block, appended after `PRIMER`. Injects `map.md`'s content when
 * it exists and is under {@link MAP_MD_MAX_BYTES}; otherwise a ONE-LINE pointer naming the path —
 * in BOTH non-injecting cases (present-but-over-cap AND absent), never silence. Over the cap this
 * never reads or slices the file's content: a truncated architecture map reads as complete, which
 * is worse than none, so the only safe non-injecting output is a pointer that names where to read
 * it directly. A read failure (permission error, `map.md` replaced by a directory) is treated the
 * same as absent, matching `graphStatus`'s "any read failure reads as absent" convention.
 */
function graphBlock(projectDir) {
  const path = mapMdPath(projectDir);
  const pointer =
    `No architecture map yet - run \`node ${GRAPH_CLI_RELATIVE_PATH} setup\` ` +
    `(Octobots: Install Graph) to build one at \`${MAP_MD_DISPLAY_PATH}\`.`;

  let size;
  try {
    size = statSync(path).size;
  } catch {
    return pointer; // absent, or unreadable as a file at all
  }
  if (size > MAP_MD_MAX_BYTES) {
    return (
      `Architecture map at \`${MAP_MD_DISPLAY_PATH}\` exceeds ${MAP_MD_MAX_BYTES} bytes - read ` +
      `it directly instead of via session context.`
    );
  }
  try {
    const body = readFileSync(path, "utf8");
    return `Architecture map (\`${MAP_MD_DISPLAY_PATH}\`):\n\n${body}`;
  } catch {
    return pointer; // existed for the stat, gone (or unreadable) by the time we read it
  }
}

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
// Additive: everything PRIMER carried before this mission is unchanged; the graph block is
// appended after it, separated by a blank line, never edited in.
const fullContext = `${PRIMER}\n\n${graphBlock(projectDir)}`;
const payload =
  backend === "copilot"
    ? { additionalContext: fullContext }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: fullContext } };

process.stdout.write(JSON.stringify(payload));
process.exit(0);
