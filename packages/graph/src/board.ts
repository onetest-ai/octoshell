/**
 * Reads missions, tasks and acceptance criteria off an Octobots board through
 * `@octoshell/board`'s public API — `BoardModel`, reached only via its
 * package-name import, never a deep path into its `src/`. A second, hand-
 * rolled parse of `.octobots` YAML here would be a THIRD spelling of the
 * board schema (the first two — `packages/board/src/entity-schema.ts` and
 * the pack's `entity-io.mjs` — already diverged once in production and lost
 * a campaign's notes; see `.agents/knowledge/architecture/dual-schema-
 * entity-io.md`). This module exists so `own`/`conflicts` never become the
 * third.
 */
import { BoardModel, parseCriteriaString } from "@octoshell/board";
import { boardDir } from "./artifact.js";
import { compare } from "./rollup.js";

export interface BoardTask {
  id: string;
  name: string;
  mission: string;
  campaign: string;
  criteria: string[];
}

export interface BoardView {
  tasks: BoardTask[];
  missionOf: (taskId: string) => string | null;
  /** The human-authored mission title for the SAME task `missionOf` answers
   *  with a folder id — `own`'s rendered output names a mission by the words
   *  a person gave it (`mission.title`), never by `folder:campaigns/.../
   *  missions/<slug>`, which is what shipped before (see cli.ts's
   *  `formatOwnAnswer`). A second map, populated in the same loop as
   *  `missionOfTask` below, so the two can never disagree about which task a
   *  mission id/name pair belongs to. */
  missionNameOf: (taskId: string) => string | null;
}

/**
 * `@octoshell/board`'s public `Task.acceptanceCriteria` is a STRING — a
 * rendered `"- [ ] text"` / `"- [x] text"` checklist (see board-model.ts's
 * `renderCriteria`), not a structured `AcceptanceCriterion[]`. There IS a
 * structured type on the package (`entity-schema.ts`'s `AcceptanceCriterion`),
 * but it is not what `BoardModel` exposes on `Task`, and reaching for it
 * would mean reading `task.yaml`'s `acceptance_criteria` array a second way.
 *
 * Parsing the rendered checklist back is deliberately format-agnostic — a
 * legacy `.md` board's criteria come from a markdown section with no YAML
 * array to re-read at all — but the parse is `@octoshell/board`'s OWN
 * `parseCriteriaString`, never a local regex.
 *
 * The two board generations do not hand us the same string, which is exactly
 * what a local copy gets wrong. `board-model.ts`'s `readEntity` runs
 * `renderCriteria` only on the YAML branch (machine-perfect `- [x] text`); its
 * `.md` branch returns `parseManagedBlock`'s `## Acceptance Criteria` section
 * body VERBATIM, so `  - [ ] indented` and `-  [x]  loose` are the authored
 * form there. A stricter local regex silently reports those criteria as
 * ABSENT — an empty-criteria claim the file does not support. There is exactly
 * one spelling of this rule and it lives in `@octoshell/board`;
 * `test/conventions.test.ts` fails the build on a second one appearing here.
 */
function readCriteria(rendered: string): string[] {
  return parseCriteriaString(rendered).map((c) => c.text);
}

/**
 * Reads a board's missions/tasks through `@octoshell/board`, or `null` when
 * this repo has none — the ONE signal `own`/`conflicts` use to decide they
 * cannot answer; every other command must keep working on a boardless repo.
 *
 * Tasks are returned sorted by (campaign, mission, id) through `compare` —
 * never the `BoardModel`'s own newest-first listing order, which is a
 * function of file mtime and therefore not something a caller building a
 * deterministic answer from this list should depend on.
 */
export function readBoard(repoRoot: string): BoardView | null {
  const root = boardDir(repoRoot);
  if (root === null) return null;

  const model = new BoardModel(root);
  model.rebuild();

  const tasks: BoardTask[] = [];
  const missionOfTask = new Map<string, string>();
  const missionNameOfTask = new Map<string, string>();

  for (const campaign of model.listCampaigns()) {
    for (const mission of model.listMissions(campaign.id)) {
      // No `as Task[]` cast: `listTasks` is already typed `Task[]`, and an
      // assertion here would silence — rather than surface — the day that
      // stops being true.
      for (const task of model.listTasks(mission.id)) {
        tasks.push({
          id: task.id,
          name: task.name,
          mission: mission.id,
          campaign: campaign.id,
          criteria: readCriteria(task.acceptanceCriteria),
        });
        missionOfTask.set(task.id, mission.id);
        missionNameOfTask.set(task.id, mission.title);
      }
    }
  }

  tasks.sort(
    (a, b) => compare(a.campaign, b.campaign) || compare(a.mission, b.mission) || compare(a.id, b.id),
  );

  return {
    tasks,
    missionOf: (taskId: string) => missionOfTask.get(taskId) ?? null,
    missionNameOf: (taskId: string) => missionNameOfTask.get(taskId) ?? null,
  };
}
