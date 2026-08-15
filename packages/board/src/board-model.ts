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
import { loadEntity, ENTITY_STATUSES, type AcceptanceCriterion, type Tokenomics } from "./entity-schema.js";
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
      const cRead = readEntity(this.root, cFolder, "campaign");
      if (!cRead) continue; // no campaign.yaml or campaign.md → skip
      const cf = cRead.fields;
      const cMtime = cRead.mtime;
      const cId = cf.id ?? `folder:${cFolder}`;
      if (!cRead.isYaml && !cf.id) this.missingIds.push({ kind: "campaign", folderPath: cFolder, mdPath: cRead.mdPath });

      const campaign: Campaign = {
        id: cId,
        name: cf.name || deSlug(cslug),
        isDefault: false,
        description: cf.description,
        acceptanceCriteria: cf.acceptanceCriteria,
        target: cf.target ?? "",
        status: resolveStatus(cf.ownStatus),
        ...(cf.notes ? { notes: cf.notes } : {}),
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

      // Legacy .md children carry their status on the parent's board lines; a YAML campaign has no
      // such projection (its children carry their own status), so these maps stay empty for YAML.
      const cText = cRead.isYaml ? "" : (safeReadFile(join(this.root, cFolder, "campaign.md")) ?? "");
      const cBugStatuses = parseSectionBoardStatuses(cText, "## Bugs");
      const cMissionStatuses = parseSectionBoardStatuses(cText, "## Missions");

      // Campaign-level bugs
      const cBugsDir = join(this.root, cFolder, "bugs");
      const bSlugs = safeReaddir(cBugsDir);
      for (const bslug of bSlugs) {
        const bFolder = `${cFolder}/bugs/${bslug}`;
        const bRead = readEntity(this.root, bFolder, "bug");
        if (!bRead) continue;
        const bf = bRead.fields;
        const bId = bf.id ?? `folder:${bFolder}`;
        if (!bRead.isYaml && !bf.id) this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bRead.mdPath });

        // Key on the board-line entity NAME (em/en-dash and `: ` split off any description), matching
        // how the legacy status map is keyed. A YAML bug carries its own status (`ownStatus`).
        const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
        const bug: Bug = {
          id: bId,
          campaignId: cId,
          missionId: null,
          title: bf.name || deSlug(bslug),
          status: bf.ownStatus ?? cBugStatuses.get(bugTitle) ?? "draft",
          severity: parseSeverity(bf.severity),
          description: bf.description,
          stepsToReproduce: bf.stepsToReproduce ?? "",
          expected: bf.expected ?? "",
          actual: bf.actual ?? "",
          rca: bf.rca ?? "",
          environment: bf.environment ?? "",
          ...(bf.notes ? { notes: bf.notes } : {}),
          folderPath: bFolder,
          createdAt: bRead.mtime,
          updatedAt: bRead.mtime,
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
        const mRead = readEntity(this.root, mFolder, "mission");
        if (!mRead) continue;
        const mf = mRead.fields;
        const mId = mf.id ?? `folder:${mFolder}`;
        if (!mRead.isYaml && !mf.id) this.missingIds.push({ kind: "mission", folderPath: mFolder, mdPath: mRead.mdPath });

        const mission: Mission = {
          id: mId,
          campaignId: cId,
          title: mf.name || deSlug(mslug),
          status: mf.ownStatus ?? cMissionStatuses.get(boardLineEntityName(mf.name || deSlug(mslug)).toLowerCase()) ?? "draft",
          description: mf.description,
          acceptanceCriteria: mf.acceptanceCriteria,
          ...(mf.tokenomics ? { tokenomics: mf.tokenomics } : {}),
          ...(mf.notes ? { notes: mf.notes } : {}),
          folderPath: mFolder,
          createdAt: mRead.mtime,
          updatedAt: mRead.mtime,
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

        // Legacy .md children take their status from mission.md board lines; YAML children carry
        // their own (`ownStatus`), so these maps stay empty for a YAML mission.
        const mText = mRead.isYaml ? "" : (safeReadFile(join(this.root, mFolder, "mission.md")) ?? "");
        const mBugStatuses = parseSectionBoardStatuses(mText, "## Bugs");
        const mTaskStatuses = parseSectionBoardStatuses(mText, "## Tasks");

        // Mission-level bugs
        const mBugsDir = join(this.root, mFolder, "bugs");
        const mbSlugs = safeReaddir(mBugsDir);
        for (const bslug of mbSlugs) {
          const bFolder = `${mFolder}/bugs/${bslug}`;
          const bRead = readEntity(this.root, bFolder, "bug");
          if (!bRead) continue;
          const bf = bRead.fields;
          const bId = bf.id ?? `folder:${bFolder}`;
          if (!bRead.isYaml && !bf.id) this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bRead.mdPath });

          const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
          const bug: Bug = {
            id: bId,
            campaignId: null,
            missionId: mId,
            title: bf.name || deSlug(bslug),
            status: bf.ownStatus ?? mBugStatuses.get(bugTitle) ?? "draft",
            severity: parseSeverity(bf.severity),
            description: bf.description,
            stepsToReproduce: bf.stepsToReproduce ?? "",
            expected: bf.expected ?? "",
            actual: bf.actual ?? "",
            rca: bf.rca ?? "",
            environment: bf.environment ?? "",
            folderPath: bFolder,
            createdAt: bRead.mtime,
            updatedAt: bRead.mtime,
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
          const tRead = readEntity(this.root, tFolder, "task");
          if (!tRead) continue;
          const tf = tRead.fields;
          const tId = tf.id ?? `folder:${tFolder}`;
          if (!tRead.isYaml && !tf.id) this.missingIds.push({ kind: "task", folderPath: tFolder, mdPath: tRead.mdPath });

          const taskName = boardLineEntityName(tf.name || deSlug(tslug)).toLowerCase();
          const task: Task = {
            id: tId,
            missionId: mId,
            name: tf.name || deSlug(tslug),
            status: tf.ownStatus ?? mTaskStatuses.get(taskName) ?? "draft",
            description: tf.description,
            acceptanceCriteria: tf.acceptanceCriteria,
            ...(tf.tokenomics ? { tokenomics: tf.tokenomics } : {}),
            ...(tf.notes ? { notes: tf.notes } : {}),
            folderPath: tFolder,
            createdAt: tRead.mtime,
            updatedAt: tRead.mtime,
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
    const jsPath = join(root, folderPath, "workflow.js");

    // A folder may hold a pointer instead of a script: shared pipelines live at campaign level and
    // several missions run the same one. Without this a mission's workflow folder holds only its
    // run log, and the board draws nothing for it.
    let usesPath: string | null = null;
    let sourceFolder = folderPath;
    let jsText = safeReadFile(jsPath);
    if (jsText === null) {
      const pointer = readPointer(join(root, folderPath, "workflow.json"));
      if (pointer === null) continue; // no workflow.js and no usable pointer → not a workflow folder
      const resolved = resolveWithin(folderPath, pointer);
      if (resolved === null) continue; // escapes the board — validate reports it
      usesPath = resolved;
      sourceFolder = resolved;
      jsText = safeReadFile(join(root, resolved, "workflow.js"));
      if (jsText === null) continue;
    }

    let name = deSlug(slug);
    let description = "";
    let phases: WorkflowPhase[] = [];
    let parseError: string | null = null;

    try {
      const meta = parseWorkflowMeta(jsText);
      name = meta.name;
      if (meta.description) description = meta.description;
      phases = meta.phases;
    } catch (err) {
      parseError = (err as Error).message;
    }

    const mtime = safeMtime(jsPath);
    out.push({
      id: `folder:${folderPath}`,
      campaignId: "campaignId" in parent ? parent.campaignId : null,
      missionId: "missionId" in parent ? parent.missionId : null,
      name,
      description,
      phases,
      scriptPath: `${sourceFolder}/workflow.js`,
      folderPath,
      usesPath,
      parseError,
      lastRunStatus: readLastRunStatus(root, folderPath),
      createdAt: mtime,
      updatedAt: mtime,
    });
  }
  return out;
}

/**
 * Newest run status for a workflow: prefer `runs.jsonl` (the current log), and fall back to a
 * legacy `workflow.md` `## Runs` body so a not-yet-migrated folder still shows its last run.
 */
function readLastRunStatus(root: string, folderPath: string): string | null {
  const jsonl = safeReadFile(join(root, folderPath, "runs.jsonl"));
  if (jsonl !== null) return newestRunStatusFromJsonl(jsonl);
  const md = safeReadFile(join(root, folderPath, "workflow.md"));
  if (md !== null) return newestRunStatus(parseManagedBlock(md).runs ?? "");
  return null;
}

/** Status of the last well-formed JSON line in a `runs.jsonl` body (mapped), or null. */
function newestRunStatusFromJsonl(body: string): string | null {
  let last: string | null = null;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const status = (JSON.parse(t) as { status?: unknown }).status;
      const mapped = mapBoardStatus(String(status ?? "").trim());
      if (mapped) last = mapped;
    } catch {
      /* skip a malformed line */
    }
  }
  return last;
}

/** Status of the last `- [status:x] …` line in a legacy `## Runs` body, or null when there are none. */
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

/** Render structured criteria back to the checklist string the entity API exposes. */
function renderCriteria(cs: AcceptanceCriterion[]): string {
  return cs.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
}

/** Resolve a stored/authored status string to a canonical entity status. */
function resolveStatus(raw: string | undefined): string {
  if (!raw) return "draft";
  if ((ENTITY_STATUSES as readonly string[]).includes(raw)) return raw;
  return mapBoardStatus(raw) ?? "draft";
}

/**
 * The normalized fields of one entity, read from `<kind>.yaml` (primary) or a legacy `<kind>.md`
 * (fallback during migration). `ownStatus` is the status the entity carries in its OWN file — set for
 * every YAML entity and for a campaign's `## Status`; left undefined for a legacy md task/bug/mission
 * whose status still lives on the parent's board line.
 */
interface EntityRead {
  mtime: number;
  isYaml: boolean;
  mdPath: string;
  fields: {
    id?: string; // legacy octobots:id marker (md only)
    name: string;
    description: string;
    acceptanceCriteria: string;
    ownStatus?: string;
    role?: string;
    target?: string;
    severity?: string;
    stepsToReproduce?: string;
    expected?: string;
    actual?: string;
    rca?: string;
    environment?: string;
    tokenomics?: Tokenomics;
    notes?: string;
  };
}

/** Read an entity from `<kind>.yaml`, falling back to a legacy `<kind>.md`. Null if neither exists. */
function readEntity(root: string, folderPath: string, kind: "campaign" | "mission" | "task" | "bug"): EntityRead | null {
  const yamlPath = join(root, folderPath, `${kind}.yaml`);
  const mdPath = join(root, folderPath, `${kind}.md`);
  const yText = safeReadFile(yamlPath);
  if (yText !== null) {
    const f = loadEntity(yText);
    return {
      mtime: safeMtime(yamlPath),
      isYaml: true,
      mdPath,
      fields: {
        name: f.name,
        description: f.description,
        acceptanceCriteria: renderCriteria(f.acceptanceCriteria),
        ownStatus: resolveStatus(f.status),
        role: f.role,
        target: f.target,
        severity: f.severity,
        stepsToReproduce: f.stepsToReproduce,
        expected: f.expected,
        actual: f.actual,
        rca: f.rca,
        environment: f.environment,
        tokenomics: f.tokenomics,
        notes: f.notes,
      },
    };
  }
  const mText = safeReadFile(mdPath);
  if (mText === null) return null;
  const mf = parseManagedBlock(mText);
  return {
    mtime: safeMtime(mdPath),
    isYaml: false,
    mdPath,
    fields: {
      id: mf.id,
      name: mf.name,
      description: mf.description ?? "",
      acceptanceCriteria: mf.acceptanceCriteria ?? "",
      ownStatus: kind === "campaign" ? resolveStatus(mf.status) : undefined,
      target: mf.target,
      severity: mf.severity,
      stepsToReproduce: mf.stepsToReproduce,
      expected: mf.expected,
      actual: mf.actual,
      rca: mf.rca,
      environment: mf.environment,
    },
  };
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

/** The `uses` string of a pointer file, or null when absent or malformed. */
export function readPointer(path: string): string | null {
  const text = safeReadFile(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const uses = (parsed as { uses?: unknown })?.uses;
    return typeof uses === "string" && uses.trim() ? uses : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `rel` against `from`, both relative to the board root, refusing anything that climbs out
 * of it. A pointer is a link the board follows on every rebuild; it must not be able to leave the
 * tree, so this is a containment check and not merely a tidy-up.
 *
 * A leading `/` is refused outright rather than folded under `from`: an author who writes an
 * absolute-looking `uses` almost certainly means "from some root", and silently reinterpreting it
 * as same-folder-relative would resolve to a path they never asked for. A security boundary should
 * not quietly reinterpret its input.
 */
export function resolveWithin(from: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const stack: string[] = [];
  for (const part of `${from}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const resolved = stack.join("/");
  return resolved.startsWith("campaigns/") ? resolved : null;
}
