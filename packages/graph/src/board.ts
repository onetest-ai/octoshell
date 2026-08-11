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
import { BoardModel, type Task } from "@octoshell/board";
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
}

/**
 * `@octoshell/board`'s public `Task.acceptanceCriteria` is a STRING — a
 * rendered `"- [ ] text"` / `"- [x] text"` checklist (see board-model.ts's
 * `renderCriteria`), not a structured `AcceptanceCriterion[]`. There IS a
 * structured type on the package (`entity-schema.ts`'s `AcceptanceCriterion`),
 * but it is not what `BoardModel` exposes on `Task`, and reaching for it
 * would mean reading `task.yaml`'s `acceptance_criteria` array a second way.
 *
 * Parsing the rendered checklist back into lines here, instead, is
 * deliberately format-agnostic: a legacy `.md` board's criteria come from a
 * markdown section (no YAML array to re-read at all), and a current YAML
 * board's come from `acceptance_criteria` — `BoardModel` already normalizes
 * both into the same checklist string, so parsing THAT is the one path that
 * works for either board generation without this module knowing which one
 * it is looking at.
 */
function parseCriteriaChecklist(rendered: string): string[] {
  const out: string[] = [];
  for (const line of rendered.split("\n")) {
    const m = /^-\s\[[ xX]\]\s(.*)$/.exec(line);
    if (m) out.push(m[1] ?? "");
  }
  return out;
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

  for (const campaign of model.listCampaigns()) {
    for (const mission of model.listMissions(campaign.id)) {
      for (const task of model.listTasks(mission.id) as Task[]) {
        tasks.push({
          id: task.id,
          name: task.name,
          mission: mission.id,
          campaign: campaign.id,
          criteria: parseCriteriaChecklist(task.acceptanceCriteria),
        });
        missionOfTask.set(task.id, mission.id);
      }
    }
  }

  tasks.sort(
    (a, b) => compare(a.campaign, b.campaign) || compare(a.mission, b.mission) || compare(a.id, b.id),
  );

  return {
    tasks,
    missionOf: (taskId: string) => missionOfTask.get(taskId) ?? null,
  };
}
