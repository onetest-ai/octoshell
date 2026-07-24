/**
 * BoardHost — host-side façade over @octoshell/board.
 *
 * Wraps the board package so the VS Code extension can read/create/edit/delete
 * board entities with no database. Each mutation call performs the @octoshell/board
 * write then reconciles (rebuilds the BoardModel and emits events).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";
import {
  BoardModel,
  createCampaign,
  createMission,
  createTask,
  createBug,
  updateBrief,
  setStatus,
  addDocument,
  removeDocument,
  deleteCampaign,
  deleteMission,
  deleteTask,
  deleteBug,
  createWorkflow as createWorkflowFile,
  deleteWorkflow as deleteWorkflowFile,
  setWorkflowMeta as setWorkflowMetaFile,
  appendWorkflowRun as appendWorkflowRunFile,
  migrateLegacyWorkflows as migrateLegacyWorkflowsFile,
  parseDocumentLinks,
  type EntityKind,
  type ManagedFields,
  type Campaign,
  type Mission,
  type Task,
  type Bug,
  type BugParent,
  type BugSeverity,
  type Workflow,
  type WorkflowParent,
  type WorkflowMeta,
} from "@octoshell/board";
import { rollupCampaign, type Rollup } from "./board-rollup.js";
import type { DocLink, DocFile, CampaignSummary, MissionProposal } from "../protocol/index.js";

export interface CampaignRollup extends Rollup {
  campaignId: string;
  name: string;
  isDefault: boolean;
}

export class BoardHost {
  private readonly octobotsDir: string;
  private model!: BoardModel; // assigned via rebuildModel() in the constructor
  private readonly emitter = new EventEmitter();

  constructor(octobotsDir: string) {
    this.octobotsDir = octobotsDir;
    this.rebuildModel(); // BoardModel does NOT parse on construction — must rebuild()
  }

  /**
   * Re-parse the board from disk into a fresh in-memory model WITHOUT emitting. Use this on
   * read/self-heal paths (the `*sync*` methods called from a panel's `load()`): emitting there
   * would re-trigger every open panel's `load()`, which calls back into sync → reconcile → emit,
   * a tight feedback loop that re-parses the whole board several times a second.
   */
  /**
   * The parsed board. Exposed so read-only consumers (e.g. tokenomics) can use
   * the already-parsed tree instead of re-walking or re-parsing the disk.
   * Callers must not mutate it — writes go through this host, which rebuilds.
   */
  get boardModel(): BoardModel {
    return this.model;
  }

  /** The `.octobots` directory this board was built from — `folderPath` is relative to it. */
  get artifactsRoot(): string {
    return this.octobotsDir;
  }

  private rebuildModel(): void {
    this.model = new BoardModel(this.octobotsDir);
    this.model.rebuild();
  }

  reconcile(): void {
    this.rebuildModel();
    this.emitter.emit("entities:changed");
  }

  on(e: "entities:changed", cb: () => void): void { this.emitter.on(e, cb); }
  off(e: "entities:changed", cb: () => void): void { this.emitter.off(e, cb); }

  // ── Read API ────────────────────────────────────────────────────────────────

  listCampaigns(): Campaign[] { return this.model.listCampaigns(); }
  getCampaign(id: string): Campaign | null { return this.model.getCampaign(id); }
  listMissions(cid: string): Mission[] { return this.model.listMissions(cid); }
  getMission(id: string): Mission | null { return this.model.getMission(id); }
  listTasks(mid: string): Task[] { return this.model.listTasks(mid); }
  getTask(id: string): Task | null { return this.model.getTask(id); }
  listBugs(parent: BugParent): Bug[] { return this.model.listBugs(parent); }
  getBug(id: string): Bug | null { return this.model.getBug(id); }

  /** Resolve a relative doc path inside a campaign's folder to an absolute path. */
  campaignDocPath(campaignId: string, relPath: string): string {
    const c = this.model.getCampaign(campaignId);
    if (!c) throw new Error(`Campaign not found: ${campaignId}`);
    return join(this.octobotsDir, c.folderPath, relPath);
  }

  /** Resolve a relative doc path inside a mission's folder to an absolute path. */
  missionDocPath(missionId: string, relPath: string): string {
    const m = this.model.getMission(missionId);
    if (!m) throw new Error(`Mission not found: ${missionId}`);
    return join(this.octobotsDir, m.folderPath, relPath);
  }

  campaignRollup(cid: string): CampaignRollup | null {
    const c = this.model.getCampaign(cid);
    if (!c) return null;
    const statuses = this.model.listMissions(cid).map((m) => m.status);
    const r = rollupCampaign(statuses);
    // explicit non-draft campaign status overrides the rollup
    let rollupStatus = r.rollupStatus;
    if (c.status && c.status !== "draft") {
      rollupStatus =
        c.status === "executing" || c.status === "awaitingApproval" ? "active"
        : c.status === "done" ? "completed"
        : c.status === "failed" ? "failed"
        : c.status === "cancelled" ? "cancelled" : r.rollupStatus;
    }
    return { campaignId: cid, name: c.name, isDefault: c.isDefault, ...r, rollupStatus };
  }

  campaignSummary(cid: string): CampaignSummary | null {
    const rollup = this.campaignRollup(cid);
    if (!rollup) return null;
    // Build per-exact-status counts from the mission list (e.g. "executing", "awaitingApproval", "done").
    const statuses = this.model.listMissions(cid).map((m) => m.status);
    const counts: Record<string, number> = {};
    for (const s of statuses) {
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return {
      campaignId: rollup.campaignId,
      name: rollup.name,
      isDefault: rollup.isDefault,
      counts,
      rollupStatus: rollup.rollupStatus,
      total: rollup.total,
      active: rollup.active,
      completed: rollup.completed,
      failed: rollup.failed,
      cancelled: rollup.cancelled,
      draft: rollup.draft,
    };
  }

  // ── Documents API ───────────────────────────────────────────────────────────

  campaignDocs(id: string): { files: DocFile[]; links: DocLink[]; attachedFiles: DocLink[] } {
    return this._entityDocs("campaign", id);
  }

  missionDocs(id: string): { files: DocFile[]; links: DocLink[]; attachedFiles: DocLink[] } {
    return this._entityDocs("mission", id);
  }

  /**
   * Create an empty markdown doc in the campaign folder; returns its absolute path.
   * Idempotent: if the file already exists, returns the path without overwriting.
   */
  createCampaignDocFile(campaignId: string, name: string): string {
    const c = this.model.getCampaign(campaignId);
    if (!c) throw new Error(`Campaign not found: ${campaignId}`);
    const campaignFolderAbs = join(this.octobotsDir, c.folderPath);
    mkdirSync(campaignFolderAbs, { recursive: true });
    const withExt = name.endsWith(".md") ? name : `${name}.md`;
    const target = join(campaignFolderAbs, withExt);
    if (!existsSync(target)) writeFileSync(target, `# ${name}\n`, "utf8");
    return target;
  }

  addCampaignLink(id: string, input: { url: string; title?: string }): DocLink {
    const label = input.title ?? input.url;
    addDocument(this.octobotsDir, "campaign", id, label, input.url);
    this.reconcile();
    return { id: input.url, kind: "link", target: input.url, label, createdAt: Date.now() };
  }

  removeCampaignLink(id: string, target: string): void {
    removeDocument(this.octobotsDir, "campaign", id, target);
    this.reconcile();
  }

  addCampaignFile(id: string, input: { path: string; label?: string }): DocLink {
    const label = input.label ?? basename(input.path);
    addDocument(this.octobotsDir, "campaign", id, label, input.path);
    this.reconcile();
    return { id: input.path, kind: "file", target: input.path, label, createdAt: Date.now() };
  }

  addMissionLink(id: string, input: { url: string; title?: string }): DocLink {
    const label = input.title ?? input.url;
    addDocument(this.octobotsDir, "mission", id, label, input.url);
    this.reconcile();
    return { id: input.url, kind: "link", target: input.url, label, createdAt: Date.now() };
  }

  removeMissionLink(id: string, target: string): void {
    removeDocument(this.octobotsDir, "mission", id, target);
    this.reconcile();
  }

  addMissionFile(id: string, input: { path: string; label?: string }): DocLink {
    const label = input.label ?? basename(input.path);
    addDocument(this.octobotsDir, "mission", id, label, input.path);
    this.reconcile();
    return { id: input.path, kind: "file", target: input.path, label, createdAt: Date.now() };
  }


  // ── Proposal sync API ───────────────────────────────────────────────────────

  /**
   * Parse `## Missions` board lines from campaign.md and report which ones already have a folder.
   * Parse `## Missions` board lines from campaign.md and report which ones already have a folder.
   */
  syncCampaignMissions(campaignId: string): { proposals: MissionProposal[] } {
    const c = this.model.getCampaign(campaignId);
    if (!c) return { proposals: [] };
    const briefPath = join(this.octobotsDir, c.folderPath, "campaign.md");
    let text = "";
    try { text = readFileSync(briefPath, "utf8"); } catch { return { proposals: [] }; }

    // Parse ## Missions bullets
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^##\s+Missions\s*$/.test(l.trim()));
    if (start < 0) return { proposals: [] };

    const raw: { title: string; description: string }[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^##\s+/.test(line.trim())) break;
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (!m) continue;
      const body = (m[1] ?? "").trim();
      if (!body) continue;
      // Split on em/en dash or colon separator (not ASCII hyphen — that's part of ids like M3 - name)
      const sep = body.match(/\s+[—–]\s+|:\s+/);
      const title = (sep ? body.slice(0, sep.index) : body).trim();
      const description = sep ? body.slice((sep.index ?? 0) + (sep[0]?.length ?? 0)).trim() : "";
      if (title) raw.push({ title, description });
    }

    const existing = new Set(this.model.listMissions(campaignId).map((m) => m.title.trim().toLowerCase()));
    const proposals: MissionProposal[] = raw.map((p) => ({
      ...p,
      exists: existing.has(p.title.trim().toLowerCase()),
    }));
    return { proposals };
  }

  /**
   * Materialize mission proposals from the board into real mission folders.
   * Skips missions that already exist (case-insensitive title match).
   */
  createMissionsFromBoard(campaignId: string, missions: { title: string; description?: string }[]): { created: number } {
    const existing = new Set(this.model.listMissions(campaignId).map((m) => m.title.trim().toLowerCase()));
    let created = 0;
    for (const mn of missions) {
      const key = mn.title.trim().toLowerCase();
      if (!mn.title.trim() || existing.has(key)) continue;
      this.createMission({ title: mn.title.trim(), campaignId, description: mn.description });
      existing.add(key);
      created++;
    }
    return { created };
  }

  /**
   * Absorb an external mission.md edit. Disk-authoritative: re-parse the board.
   * Task folders are no longer minted from board lines — returns `{ created: 0 }`.
   */
  syncMissionFromBoard(_missionId: string): { created: number } {
    this.rebuildModel(); // refresh model for the caller's read; do NOT emit (avoids load↔sync loop)
    return { created: 0 };
  }

  /**
   * Absorb a `## Bugs` board edit. Bugs are folder-backed; no board-line→folder materialization.
   * Pure board re-parse — returns `{ created: 0 }`.
   */
  syncBugsFromBoard(_parent: { campaignId?: string; missionId?: string }): { created: number } {
    this.rebuildModel(); // refresh model for the caller's read; do NOT emit (avoids load↔sync loop)
    return { created: 0 };
  }

  // ── Create API ──────────────────────────────────────────────────────────────

  createCampaign(input: { name: string; description?: string; acceptanceCriteria?: string; target?: string }): Campaign {
    // createCampaign returns { id, folderPath } — use the id directly
    const { id } = createCampaign(this.octobotsDir, input);
    this.reconcile();
    return this.model.getCampaign(id)!;
  }

  createMission(input: { title: string; campaignId: string; description?: string; acceptanceCriteria?: string }): Mission {
    // createMission returns { id, folderPath } — use the id directly
    const { id } = createMission(this.octobotsDir, input.campaignId, {
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
    });
    this.reconcile();
    return this.model.getMission(id)!;
  }

  createTask(input: { missionId: string; name: string; description?: string; acceptanceCriteria?: string; role?: string }): Task {
    // createTask returns { id, folderPath } — use the id directly
    const { id } = createTask(this.octobotsDir, input.missionId, {
      name: input.name,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      role: input.role,
    });
    this.reconcile();
    return this.model.getTask(id)!;
  }

  createBug(input: { title: string; campaignId?: string; missionId?: string; severity?: BugSeverity; description?: string }): Bug {
    // Build BugParent internally from flat shape
    const parent: BugParent = input.missionId
      ? { missionId: input.missionId }
      : { campaignId: input.campaignId! };
    // createBug returns { id, folderPath } — use the id directly
    const { id } = createBug(this.octobotsDir, parent, {
      title: input.title,
      severity: input.severity,
      description: input.description,
    });
    this.reconcile();
    return this.model.getBug(id)!;
  }

  // ── Edit API ────────────────────────────────────────────────────────────────

  updateBrief(kind: EntityKind, id: string, patch: Partial<ManagedFields>): void {
    updateBrief(this.octobotsDir, kind, id, patch);
    this.reconcile();
  }

  setStatus(kind: EntityKind, id: string, status: string): boolean {
    const ok = setStatus(this.octobotsDir, kind, id, status);
    if (ok) this.reconcile();
    return ok;
  }

  addDocument(kind: EntityKind, id: string, label: string, target: string): void {
    addDocument(this.octobotsDir, kind, id, label, target);
    this.reconcile();
  }

  removeDocument(kind: EntityKind, id: string, target: string): void {
    removeDocument(this.octobotsDir, kind, id, target);
    this.reconcile();
  }

  // ── Delete API ──────────────────────────────────────────────────────────────

  deleteCampaign(id: string): void { deleteCampaign(this.octobotsDir, id); this.reconcile(); }
  deleteMission(id: string): void { deleteMission(this.octobotsDir, id); this.reconcile(); }
  deleteTask(id: string): void { deleteTask(this.octobotsDir, id); this.reconcile(); }
  deleteBug(id: string): void { deleteBug(this.octobotsDir, id); this.reconcile(); }

  // ── Workflows API ───────────────────────────────────────────────────────────

  listWorkflows(parent: WorkflowParent): Workflow[] { return this.model.listWorkflows(parent); }
  getWorkflow(id: string): Workflow | null { return this.model.getWorkflow(id); }

  createWorkflow(parent: WorkflowParent, input: { name: string }): { id: string; folderPath: string } {
    const res = createWorkflowFile(this.octobotsDir, parent, input);
    this.reconcile();
    return res;
  }

  setWorkflowMeta(id: string, meta: WorkflowMeta): void {
    setWorkflowMetaFile(this.octobotsDir, id, meta);
    this.reconcile();
  }

  appendWorkflowRun(id: string, entry: { status: string; summary: string; at: string }): void {
    appendWorkflowRunFile(this.octobotsDir, id, entry);
    this.reconcile();
  }

  deleteWorkflow(id: string): void {
    deleteWorkflowFile(this.octobotsDir, id);
    this.reconcile();
  }

  /** One-time migration to the js-only workflow layout. Returns how many workflow.md were retired. */
  migrateLegacyWorkflows(): number {
    return migrateLegacyWorkflowsFile(this.octobotsDir);
  }

  /** Absolute path of a workflow's script, for opening it in a normal editor tab. */
  workflowScriptPath(id: string): string {
    const wf = this.model.getWorkflow(id);
    if (!wf) throw new Error(`Workflow not found: ${id}`);
    return join(this.octobotsDir, wf.scriptPath);
  }

  // ── Private helpers (documents) ──────────────────────────────────────────────

  private _entityDocs(kind: "campaign" | "mission", id: string): { files: DocFile[]; links: DocLink[]; attachedFiles: DocLink[] } {
    const entity = kind === "campaign" ? this.model.getCampaign(id) : this.model.getMission(id);
    if (!entity) return { files: [], links: [], attachedFiles: [] };

    const folderAbs = join(this.octobotsDir, entity.folderPath);
    const briefName = kind === "campaign" ? "campaign.md" : "mission.md";
    const briefPath = join(folderAbs, briefName);

    // Scan the entity folder for on-disk files (mirrors daemon's listFolder).
    const files: DocFile[] = [];
    try {
      for (const entry of readdirSync(folderAbs, { withFileTypes: true })) {
        if (!entry.isFile() && !entry.isDirectory()) continue;
        if (entry.isFile() && entry.name === briefName) continue; // exclude the brief itself
        try {
          const st = statSync(join(folderAbs, entry.name));
          files.push({ name: entry.name, kind: entry.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs });
        } catch { /* entry vanished */ }
      }
    } catch { /* folder unreadable */ }

    // Parse document links from the brief's ## Documents section.
    let briefText = "";
    try { briefText = readFileSync(briefPath, "utf8"); } catch { /* no brief */ }
    const parsed = parseDocumentLinks(briefText);

    // Separate links (URL-like targets) from attached files (path targets).
    const links: DocLink[] = [];
    const attachedFiles: DocLink[] = [];
    for (const { label, target } of parsed) {
      const isUrl = /^https?:\/\//i.test(target) || /^ftp:\/\//i.test(target);
      const entry: DocLink = { id: target, kind: isUrl ? "link" : "file", target, label, createdAt: 0 };
      if (isUrl) { links.push(entry); } else { attachedFiles.push(entry); }
    }

    return { files, links, attachedFiles };
  }
}

