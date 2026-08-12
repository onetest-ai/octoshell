// octobots-pack-version: 46
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
 *
 * Named, not inlined, on purpose (T6.4 criterion 5): `test/octobots-primer.test.ts` parses this
 * exact declaration out of the source and drives every boundary case from the parsed value, so
 * inlining the literal at the comparison makes that suite fail by name rather than quietly
 * re-tuning the cap. Verified 2026-08-11 by planting that violation — the three cap tests failed
 * with "primer.mjs no longer declares `const MAP_MD_MAX_BYTES = <bytes>;`".
 */
const MAP_MD_MAX_BYTES = 32 * 1024; // 32 KB

// ---------------------------------------------------------------------------------------------
// Rules this script HAND-DUPLICATES from the extension host, and the guard that keeps them honest.
//
// This script ships standalone: it runs under bare `node` in someone else's workspace, with no
// node_modules and no TypeScript build step — the same constraint `entity-io.mjs` operates under —
// so it can import neither `@octoshell/graph` (mission criterion 4) nor the extension's own host
// modules. Every constant below is therefore a SECOND SPELLING of a rule that already exists in
// TypeScript, named here with its twin.
//
// Cross-referencing them in prose is not enough — that is how this campaign's duplicated rules
// drifted before. `test/octobots-primer.test.ts`'s "duplicated rules" suite imports the real
// TypeScript twins, drives ONE shared list of them, and asserts each appears verbatim in this
// script's emitted output. Rename `GRAPH_RELATIVE_PATH`, change `graphCommand`'s shape, move
// `artifactPath`, or retitle the `octoshell.installGraph` command, and that suite fails by name
// instead of this pointer quietly telling agents to run something that no longer exists.
// ---------------------------------------------------------------------------------------------

/** Twin of `octograph-install.ts`'s exported `GRAPH_RELATIVE_PATH`. */
const GRAPH_CLI_RELATIVE_PATH = ".claude/skills/graph/octograph.mjs";

/** Twin of `octograph.ts`'s `graphCommand("setup")` — the documented bare-`node` invocation. No
 *  `npx`, no network, no install at run time. Display-only here: this is text an agent reads, not
 *  a command this script ever spawns. */
const GRAPH_SETUP_COMMAND = `node ${GRAPH_CLI_RELATIVE_PATH} setup`;

/** Twin of the `octoshell.installGraph` command's `title` in `package.json` — the GUI route to the
 *  same thing, named so a person who would rather click than type can find it. */
const INSTALL_GRAPH_COMMAND_TITLE = "Octobots: Install Graph";

/**
 * Where octograph writes `map.md` for THIS workspace, as path segments — the ONE spelling in this
 * file, so the fs path and the displayed path can never disagree.
 *
 * Twin of `apps/vscode-extension/src/host/octograph.ts`'s `artifactPath` (its board-present
 * branch) joined with the `"map.md"` filename `packages/graph/src/cli.ts` writes. Both in turn
 * mirror `packages/graph/src/artifact.ts`'s `resolveOut`.
 *
 * TWO branches of `resolveOut` are deliberately NOT re-derived here, and neither is a claim this
 * makes:
 *  - the `.octograph` fallback for a boardless workspace is unreachable — the `.octobots`
 *    existence check above this function's only call site exits the process first. If that early
 *    exit is ever removed, this needs `artifactPath`'s two-branch check.
 *  - an `octograph.yaml` that sets `out:` wins over both defaults, exactly as `artifactPath`
 *    documents and `test/octograph.test.ts` pins. Honouring it would need a third spelling of
 *    `loadConfig`'s YAML read AND of its containment check, neither importable here. So this is
 *    the DEFAULT-LOCATION answer only, and {@link graphBlock}'s message says what it actually
 *    looked at rather than claiming a repo-wide "there is no map".
 */
const MAP_MD_SEGMENTS = [".octobots", "graph", "map.md"];

/** Forward-slashed regardless of OS — this is a path a person reads in a message, never one handed
 *  to a command. */
const MAP_MD_DISPLAY_PATH = MAP_MD_SEGMENTS.join("/");

function mapMdPath(projectDir) {
  return join(projectDir, ...MAP_MD_SEGMENTS);
}

/**
 * The additive architecture-map block, appended after `PRIMER`. Injects `map.md`'s content when
 * it exists and is under {@link MAP_MD_MAX_BYTES}; otherwise a ONE-LINE pointer naming the path —
 * in BOTH non-injecting cases (present-but-over-cap AND absent), never silence. Over the cap this
 * never reads or slices the file's content: a truncated architecture map reads as complete, which
 * is worse than none, so the only safe non-injecting output is a pointer that names where to read
 * it directly. A read failure (permission error, `map.md` replaced by a directory) and a zero-byte
 * file are both treated as absent — an "Architecture map:" heading over nothing is a claim with no
 * observation behind it, and "any read failure reads as absent" is `graphStatus`'s convention too.
 *
 * The absent-case message states ONLY what was observed: nothing readable at
 * {@link MAP_MD_DISPLAY_PATH}. It deliberately does not say "this repo has no architecture map" —
 * see {@link MAP_MD_SEGMENTS} on the `octograph.yaml` `out:` branch this does not resolve.
 */
function graphBlock(projectDir) {
  const path = mapMdPath(projectDir);
  const pointer =
    `No architecture map at \`${MAP_MD_DISPLAY_PATH}\` - run \`${GRAPH_SETUP_COMMAND}\` ` +
    `(${INSTALL_GRAPH_COMMAND_TITLE}) to build one there.`;

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
  if (size === 0) return pointer; // present but empty: nothing to inject, so do not announce one
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

// Exit only once stdout has actually drained. Node's stdout is ASYNCHRONOUS when it is a pipe —
// which is exactly what a hook runner gives us — so `process.exit(0)` on the next line would
// discard whatever has not been flushed yet. That was harmless while the payload was the ~2 KB
// primer (well inside a pipe's buffer); this mission appends up to MAP_MD_MAX_BYTES on top of it,
// and a payload cut mid-flight is not a shorter primer, it is JSON the runner cannot parse, so the
// session silently gets NO context at all. The callback fires after the write completes.
process.stdout.write(JSON.stringify(payload), () => process.exit(0));
