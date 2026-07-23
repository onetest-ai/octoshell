/**
 * BoardModel — parses the `.octobots/` disk tree into an in-memory entity read API.
 *
 * This is the in-memory model that replaces the SQLite-backed campaign/mission/task/bug tables.
 * The disk tree is the single source of truth; `rebuild()` clears and re-parses the whole tree.
 * No writes are performed here — this is a read-only snapshot.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseManagedBlock, mapBoardStatus, boardLineEntityName, type EntityKind } from "./managed-block.js";
import { parseWorkflowMeta } from "./workflow-meta.js";
import type { Campaign, Mission, Task, Bug, BugSeverity, Workflow, WorkflowPhase } from "./types.js";
import type { BugParent, WorkflowParent } from "./types.js";

/** Entry in the missingIdFiles() list — an .md that had no `<!-- octobots:id ... -->` marker. */
export interface MissingIdFile {
  kind: EntityKind;
  folderPath: string;
  mdPath: string;
}

/**
 * Reads the disk tree under `artifactsRoot` (the `.octobots/` directory) and exposes a
 * read-only snapshot of all entities. Call `rebuild()` to refresh.
 */
export class BoardModel {
  private readonly root: string | null;

  // Entity maps keyed by id
  private campaigns = new Map<string, Campaign>();
  private missions = new Map<string, Mission>();
  private tasks = new Map<string, Task>();
  private bugs = new Map<string, Bug>();
  private workflows = new Map<string, Workflow>();

  // Parent-indexed lists
  private missionsByCampaign = new Map<string, string[]>(); // campaignId → mission ids
  private tasksByMission = new Map<string, string[]>();     // missionId → task ids
  private bugsByCampaign = new Map<string, string[]>();     // campaignId → bug ids
  private bugsByMission = new Map<string, string[]>();      // missionId → bug ids
  private workflowsByCampaign = new Map<string, string[]>(); // campaignId → workflow ids
  private workflowsByMission = new Map<string, string[]>();  // missionId → workflow ids

  // FolderPath → id indexes
  private campaignByFolder = new Map<string, string>();
  private missionByFolder = new Map<string, string>();
  private taskByFolder = new Map<string, string>();
  private bugByFolder = new Map<string, string>();
  private workflowByFolder = new Map<string, string>();

  // Files without an id marker
  private missingIds: MissingIdFile[] = [];

  constructor(artifactsRoot: string | null) {
    this.root = artifactsRoot;
  }

  /** Re-parse the entire disk tree. All internal state is reset first. */
  rebuild(): void {
    // Clear all state
    this.campaigns.clear();
    this.missions.clear();
    this.tasks.clear();
    this.bugs.clear();
    this.workflows.clear();
    this.missionsByCampaign.clear();
    this.tasksByMission.clear();
    this.bugsByCampaign.clear();
    this.bugsByMission.clear();
    this.workflowsByCampaign.clear();
    this.workflowsByMission.clear();
    this.campaignByFolder.clear();
    this.missionByFolder.clear();
    this.taskByFolder.clear();
    this.bugByFolder.clear();
    this.workflowByFolder.clear();
    this.missingIds = [];

    if (!this.root) return;

    const campaignsDir = join(this.root, "campaigns");
    const cSlugs = safeReaddir(campaignsDir);

    for (const cslug of cSlugs) {
      const cFolder = `campaigns/${cslug}`;
      const cMdPath = join(this.root, cFolder, "campaign.md");
      const cText = safeReadFile(cMdPath);
      if (cText === null) continue; // no campaign.md → skip

      const cMtime = safeMtime(cMdPath);
      const cf = parseManagedBlock(cText);
      const hasCId = !!cf.id;
      const cId = cf.id ?? `folder:${cFolder}`;
      if (!hasCId) this.missingIds.push({ kind: "campaign", folderPath: cFolder, mdPath: cMdPath });

      const campaign: Campaign = {
        id: cId,
        name: cf.name || deSlug(cslug),
        isDefault: false,
        description: cf.description ?? "",
        acceptanceCriteria: cf.acceptanceCriteria ?? "",
        target: cf.target ?? "",
        status: (cf.status ? (mapBoardStatus(cf.status) ?? "draft") : "draft"),
        folderPath: cFolder,
        createdAt: cMtime,
        updatedAt: cMtime,
      };
      this.campaigns.set(cId, campaign);
      this.campaignByFolder.set(cFolder, cId);
      this.missionsByCampaign.set(cId, []);
      this.bugsByCampaign.set(cId, []);
      this.workflowsByCampaign.set(cId, []);
      for (const wf of parseWorkflows(this.root, cFolder, { campaignId: cId })) {
        this.workflows.set(wf.id, wf);
        this.workflowByFolder.set(wf.folderPath, wf.id);
        this.workflowsByCampaign.get(cId)!.push(wf.id);
      }

      // Parse campaign-level bug statuses from campaign.md ## Bugs board lines
      const cBugStatuses = parseSectionBoardStatuses(cText, "## Bugs");
      // Parse campaign-level mission statuses from campaign.md ## Missions board lines
      const cMissionStatuses = parseSectionBoardStatuses(cText, "## Missions");

      // Campaign-level bugs
      const cBugsDir = join(this.root, cFolder, "bugs");
      const bSlugs = safeReaddir(cBugsDir);
      for (const bslug of bSlugs) {
        const bFolder = `${cFolder}/bugs/${bslug}`;
        const bMdPath = join(this.root, bFolder, "bug.md");
        const bText = safeReadFile(bMdPath);
        if (bText === null) continue;
        const bMtime = safeMtime(bMdPath);
        const bf = parseManagedBlock(bText);
        const hasBId = !!bf.id;
        const bId = bf.id ?? `folder:${bFolder}`;
        if (!hasBId) this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bMdPath });

        // Key on the board-line entity NAME (em/en-dash and `: ` split off any description), matching
        // how the status map is keyed — otherwise an em-dash title like "M9 — Foo" never matches.
        const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
        const bug: Bug = {
          id: bId,
          campaignId: cId,
          missionId: null,
          title: bf.name || deSlug(bslug),
          status: (cBugStatuses.get(bugTitle) ?? "draft"),
          severity: parseSeverity(bf.severity),
          description: bf.description ?? "",
          stepsToReproduce: bf.stepsToReproduce ?? "",
          expected: bf.expected ?? "",
          actual: bf.actual ?? "",
          rca: bf.rca ?? "",
          environment: bf.environment ?? "",
          folderPath: bFolder,
          createdAt: bMtime,
          updatedAt: bMtime,
        };
        this.bugs.set(bId, bug);
        this.bugByFolder.set(bFolder, bId);
        this.bugsByCampaign.get(cId)!.push(bId);
      }

      // Missions under this campaign
      const missionsDir = join(this.root, cFolder, "missions");
      const mSlugs = safeReaddir(missionsDir);

      for (const mslug of mSlugs) {
        const mFolder = `${cFolder}/missions/${mslug}`;
        const mMdPath = join(this.root, mFolder, "mission.md");
        const mText = safeReadFile(mMdPath);
        if (mText === null) continue;

        const mMtime = safeMtime(mMdPath);
        const mf = parseManagedBlock(mText);
        const hasMId = !!mf.id;
        const mId = mf.id ?? `folder:${mFolder}`;
        if (!hasMId) this.missingIds.push({ kind: "mission", folderPath: mFolder, mdPath: mMdPath });

        const mission: Mission = {
          id: mId,
          campaignId: cId,
          title: mf.name || deSlug(mslug),
          status: (cMissionStatuses.get(boardLineEntityName(mf.name || deSlug(mslug)).toLowerCase()) ?? "draft"),
          description: mf.description ?? "",
          acceptanceCriteria: mf.acceptanceCriteria ?? "",
          folderPath: mFolder,
          createdAt: mMtime,
          updatedAt: mMtime,
        };
        this.missions.set(mId, mission);
        this.missionByFolder.set(mFolder, mId);
        this.missionsByCampaign.get(cId)!.push(mId);
        this.tasksByMission.set(mId, []);
        this.bugsByMission.set(mId, []);
        this.workflowsByMission.set(mId, []);
        for (const wf of parseWorkflows(this.root, mFolder, { missionId: mId })) {
          this.workflows.set(wf.id, wf);
          this.workflowByFolder.set(wf.folderPath, wf.id);
          this.workflowsByMission.get(mId)!.push(wf.id);
        }

        // Parse mission-level bug and task statuses from mission.md board lines
        const mBugStatuses = parseSectionBoardStatuses(mText, "## Bugs");
        const mTaskStatuses = parseSectionBoardStatuses(mText, "## Tasks");

        // Mission-level bugs
        const mBugsDir = join(this.root, mFolder, "bugs");
        const mbSlugs = safeReaddir(mBugsDir);
        for (const bslug of mbSlugs) {
          const bFolder = `${mFolder}/bugs/${bslug}`;
          const bMdPath = join(this.root, bFolder, "bug.md");
          const bText = safeReadFile(bMdPath);
          if (bText === null) continue;
          const bMtime = safeMtime(bMdPath);
          const bf = parseManagedBlock(bText);
          const hasBId = !!bf.id;
          const bId = bf.id ?? `folder:${bFolder}`;
          if (!hasBId) this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bMdPath });

          const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
          const bug: Bug = {
            id: bId,
            campaignId: null,
            missionId: mId,
            title: bf.name || deSlug(bslug),
            status: (mBugStatuses.get(bugTitle) ?? "draft"),
            severity: parseSeverity(bf.severity),
            description: bf.description ?? "",
            stepsToReproduce: bf.stepsToReproduce ?? "",
            expected: bf.expected ?? "",
            actual: bf.actual ?? "",
            rca: bf.rca ?? "",
            environment: bf.environment ?? "",
            folderPath: bFolder,
            createdAt: bMtime,
            updatedAt: bMtime,
          };
          this.bugs.set(bId, bug);
          this.bugByFolder.set(bFolder, bId);
          this.bugsByMission.get(mId)!.push(bId);
        }

        // Tasks under this mission
        const tasksDir = join(this.root, mFolder, "tasks");
        const tSlugs = safeReaddir(tasksDir);

        for (const tslug of tSlugs) {
          const tFolder = `${mFolder}/tasks/${tslug}`;
          const tMdPath = join(this.root, tFolder, "task.md");
          const tText = safeReadFile(tMdPath);
          if (tText === null) continue;

          const tMtime = safeMtime(tMdPath);
          const tf = parseManagedBlock(tText);
          const hasTId = !!tf.id;
          const tId = tf.id ?? `folder:${tFolder}`;
          if (!hasTId) this.missingIds.push({ kind: "task", folderPath: tFolder, mdPath: tMdPath });

          const taskName = boardLineEntityName(tf.name || deSlug(tslug)).toLowerCase();
          const task: Task = {
            id: tId,
            missionId: mId,
            name: tf.name || deSlug(tslug),
            status: (mTaskStatuses.get(taskName) ?? "draft"),
            description: tf.description ?? "",
            acceptanceCriteria: tf.acceptanceCriteria ?? "",
            folderPath: tFolder,
            createdAt: tMtime,
            updatedAt: tMtime,
          };
          this.tasks.set(tId, task);
          this.taskByFolder.set(tFolder, tId);
          this.tasksByMission.get(mId)!.push(tId);
        }
      }
    }
  }

  // ── Read API ────────────────────────────────────────────────────────────────

  /** All campaigns, sorted newest-first by createdAt then folderPath (mirrors `created_at DESC, rowid DESC`). */
  listCampaigns(): Campaign[] {
    return sortEntities([...this.campaigns.values()]);
  }

  getCampaign(id: string): Campaign | null {
    return this.campaigns.get(id) ?? null;
  }

  /** Missions for a campaign, sorted newest-first. */
  listMissions(campaignId: string): Mission[] {
    const ids = this.missionsByCampaign.get(campaignId) ?? [];
    const entities = ids.map((id) => this.missions.get(id)).filter((m): m is Mission => m !== undefined);
    return sortEntities(entities);
  }

  getMission(id: string): Mission | null {
    return this.missions.get(id) ?? null;
  }

  /** Tasks for a mission, sorted newest-first. */
  listTasks(missionId: string): Task[] {
    const ids = this.tasksByMission.get(missionId) ?? [];
    const entities = ids.map((id) => this.tasks.get(id)).filter((t): t is Task => t !== undefined);
    return sortEntities(entities);
  }

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
  }

  /** Bugs for a campaign or mission parent. */
  listBugs(parent: BugParent): Bug[] {
    let ids: string[];
    if ("campaignId" in parent) {
      ids = this.bugsByCampaign.get(parent.campaignId) ?? [];
    } else {
      ids = this.bugsByMission.get(parent.missionId) ?? [];
    }
    const entities = ids.map((id) => this.bugs.get(id)).filter((b): b is Bug => b !== undefined);
    return sortEntities(entities);
  }

  getBug(id: string): Bug | null {
    return this.bugs.get(id) ?? null;
  }

  /** Workflows for a campaign or mission parent, sorted newest-first. */
  listWorkflows(parent: WorkflowParent): Workflow[] {
    const ids =
      "campaignId" in parent
        ? this.workflowsByCampaign.get(parent.campaignId) ?? []
        : this.workflowsByMission.get(parent.missionId) ?? [];
    const entities = ids
      .map((id) => this.workflows.get(id))
      .filter((w): w is Workflow => w !== undefined);
    return sortEntities(entities);
  }

  getWorkflow(id: string): Workflow | null {
    return this.workflows.get(id) ?? null;
  }

  // ── FolderPath → id indexes ──────────────────────────────────────────────

  campaignIdByFolderPath(folderPath: string): string | null {
    return this.campaignByFolder.get(folderPath) ?? null;
  }

  missionIdByFolderPath(folderPath: string): string | null {
    return this.missionByFolder.get(folderPath) ?? null;
  }

  taskIdByFolderPath(folderPath: string): string | null {
    return this.taskByFolder.get(folderPath) ?? null;
  }

  bugIdByFolderPath(folderPath: string): string | null {
    return this.bugByFolder.get(folderPath) ?? null;
  }

  workflowIdByFolderPath(folderPath: string): string | null {
    return this.workflowByFolder.get(folderPath) ?? null;
  }

  // ── Missing ID tracking ──────────────────────────────────────────────────

  /** Returns all parsed .md files that had no `<!-- octobots:id ... -->` marker. */
  missingIdFiles(): MissingIdFile[] {
    return [...this.missingIds];
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Parse board-line status markers from a section in a parent file.
 *
 * Given the full text of a parent file (mission.md or campaign.md) and a section heading
 * (e.g. "## Tasks" or "## Bugs"), returns a Map from bare-title-lowercased → EntityStatus string.
 *
 * Board lines are `-`/`*` bullets or `N.`/`N)` numbered items at column 0. Their body is zero or
 * more leading `[key:value]` markers followed by the bare title. Lines after the
 * `<!-- Auto-generated by Octobots ... -->` boundary comment are preferred (agent-owned tail), but
 * if the boundary comment is absent the whole section is scanned.
 *
 * Unrecognised or absent `[status:]` values → entry omitted (callers default to "draft").
 */
function parseSectionBoardStatuses(text: string, sectionHeading: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    // Prefer the agent-owned tail after the boundary comment; fall back to whole text.
    const boundaryIdx = text.indexOf("<!-- Auto-generated by Octobots");
    const scanText = boundaryIdx >= 0 ? text.slice(boundaryIdx) : text;

    // Find the section heading inside scanText.
    const headingRe = new RegExp(`^${sectionHeading}\\s*$`, "m");
    const headMatch = headingRe.exec(scanText);
    if (!headMatch) return result;

    const afterHeading = scanText.slice(headMatch.index + headMatch[0].length);
    // Section body ends at the next `## ` heading or end of text.
    const nextHeadingIdx = afterHeading.search(/^##\s+/m);
    const sectionText = nextHeadingIdx >= 0 ? afterHeading.slice(0, nextHeadingIdx) : afterHeading;

    for (const line of sectionText.split("\n")) {
      // Match board lines: `-`/`*` bullet or `N.`/`N)` numbered item at column 0.
      const bullet = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)/);
      if (!bullet) continue;
      const body = bullet[1] ?? "";

      // Strip leading [key:value] markers.
      let rest = body;
      let statusValue: string | undefined;
      for (;;) {
        const m = rest.match(/^\[([a-z]+):([^\]]*)\]\s*/i);
        if (!m) break;
        if ((m[1] ?? "").toLowerCase() === "status") {
          statusValue = (m[2] ?? "").trim();
        }
        rest = rest.slice(m[0].length);
      }
      // Key by the entity NAME (split off any inline `: desc` / `— desc`), matching how the task/bug
      // is named from its own .md heading — otherwise a `- name: desc` board line never matches.
      const bareTitle = boardLineEntityName(rest).toLowerCase();
      if (!bareTitle) continue;

      if (statusValue !== undefined) {
        const mapped = mapBoardStatus(statusValue);
        if (mapped !== null) {
          result.set(bareTitle, mapped);
        }
      }
    }
  } catch {
    // Any parse error → return what we have so far (callers default to "draft")
  }
  return result;
}

/**
 * Parse every workflow folder under `<parentFolder>/workflows/`. A workflow whose script cannot be
 * read is still returned, carrying `parseError` — an unreadable workflow must be visible on the
 * board, not silently absent.
 */
function parseWorkflows(
  root: string,
  parentFolder: string,
  parent: WorkflowParent,
): Workflow[] {
  const out: Workflow[] = [];
  const dir = join(root, parentFolder, "workflows");
  for (const slug of safeReaddir(dir)) {
    const folderPath = `${parentFolder}/workflows/${slug}`;
    const mdPath = join(root, folderPath, "workflow.md");
    const mdText = safeReadFile(mdPath);
    if (mdText === null) continue; // no workflow.md → not a workflow folder

    const fields = parseManagedBlock(mdText);
    const jsPath = join(root, folderPath, "workflow.js");
    const jsText = safeReadFile(jsPath);

    let name = fields.name || deSlug(slug);
    let description = fields.description ?? "";
    let phases: WorkflowPhase[] = [];
    let parseError: string | null = null;

    if (jsText === null) {
      parseError = "workflow.js is missing";
    } else {
      try {
        const meta = parseWorkflowMeta(jsText);
        name = meta.name;
        if (meta.description) description = meta.description;
        phases = meta.phases;
      } catch (err) {
        parseError = (err as Error).message;
      }
    }

    const mtime = safeMtime(mdPath);
    out.push({
      id: `folder:${folderPath}`,
      campaignId: "campaignId" in parent ? parent.campaignId : null,
      missionId: "missionId" in parent ? parent.missionId : null,
      name,
      description,
      phases,
      scriptPath: `${folderPath}/workflow.js`,
      folderPath,
      parseError,
      lastRunStatus: newestRunStatus(fields.runs ?? ""),
      createdAt: mtime,
      updatedAt: mtime,
    });
  }
  return out;
}

/** Status of the last `- [status:x] …` line in a `## Runs` body, or null when there are none. */
function newestRunStatus(runsBody: string): string | null {
  let last: string | null = null;
  for (const line of runsBody.split("\n")) {
    const m = line.match(/^\s*-\s*\[status:([^\]]+)\]/i);
    if (!m) continue;
    const mapped = mapBoardStatus((m[1] ?? "").trim());
    if (mapped) last = mapped;
  }
  return last;
}

/** Safely read directory entries (returns [] on any error). */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Safely read a file (returns null on any error, e.g. not found). */
function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Safely get file mtime in milliseconds (returns Date.now() as fallback). */
function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** De-slug a folder name: `my-slug` → `My Slug`. Mirrors `parseEntityTitle` fallback. */
function deSlug(slug: string): string {
  return slug.replace(/-+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map a severity string from the .md to a valid BugSeverity (defaults to "major"). */
function parseSeverity(raw: string | undefined): BugSeverity {
  const valid: BugSeverity[] = ["blocker", "critical", "major", "minor", "trivial"];
  const s = (raw ?? "").trim().toLowerCase() as BugSeverity;
  return valid.includes(s) ? s : "major";
}

/** Sort entities newest-first by createdAt, then by folderPath for stability. */
function sortEntities<T extends { createdAt: number; folderPath: string }>(entities: T[]): T[] {
  return entities.slice().sort((a, b) => {
    const dtMs = b.createdAt - a.createdAt;
    if (dtMs !== 0) return dtMs;
    return a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0;
  });
}
