/**
 * Every line the session primer emitted BEFORE M6 added the architecture-map block, frozen.
 *
 * **Deliberately a hand-copied snapshot, not a read of `primer.mjs`.** The property under test is
 * "the map block is ADDITIVE — nothing a workspace already relies on was dropped" (M6/T6.4
 * criterion 4). A guard that derives its expectations from the file it is guarding cannot fail:
 * delete a line from `PRIMER` and the expectation deletes itself with it. Verified 2026-08-11 by
 * planting exactly that violation — seven lines removed from `PRIMER`, including the whole
 * "every task needs an acceptance criterion" and "keep statuses current" doctrine — against the
 * suite as first written: all seven primer tests still passed. With this list they fail by name.
 *
 * Captured verbatim from `feat/octograph-code-architecture-graph-m6`'s
 * `resources/octobots-pack/hooks/primer.mjs`, the mission branch this task branched from.
 *
 * If a LATER, deliberate change edits one of these lines, this list is what has to be updated —
 * and updating it should be a decision someone makes on purpose, in a diff a reviewer can see,
 * which is the entire point of freezing it.
 */
export const PRE_MISSION_PRIMER_LINES: readonly string[] = [
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
] as const;

/** The pre-mission primer as one block, in order — the exact prefix the emitted context must
 *  still open with. Catches a REORDER, which a per-line containment check alone would not. */
export const PRE_MISSION_PRIMER = PRE_MISSION_PRIMER_LINES.join("\n");
