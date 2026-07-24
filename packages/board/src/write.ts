import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { parseManagedBlock, mapBoardStatus, boardLineEntityName, parseDocumentLinks, type EntityKind, type ManagedFields } from "./managed-block.js";
import { slugify, uniqueSlug } from "./slug.js";
import { type BugParent, type BugSeverity, type WorkflowParent } from "./types.js";
import { findMetaSpan, serializeMeta, type WorkflowMeta } from "./workflow-meta.js";
import { dumpEntity, loadEntity, type EntityFields, type AcceptanceCriterion, type DocumentLink } from "./entity-schema.js";
import { BoardModel } from "./board-model.js";

/** Entity kinds that are YAML files (workflow is a `.js` script, not an entity file). */
type YamlKind = "campaign" | "mission" | "task" | "bug";

/** Parse a `- [ ] text` / `- [x] text` checklist string into structured criteria. */
function parseCriteriaString(s: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  for (const line of (s ?? "").split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (m) out.push({ text: (m[2] ?? "").trim(), done: (m[1] ?? " ").toLowerCase() === "x" });
  }
  return out;
}

/** Field inputs for writing an entity; acceptance criteria are given in the checklist string form. */
interface WriteFields {
  name: string;
  description?: string;
  acceptanceCriteria?: string;
  status?: string;
  role?: string;
  target?: string;
  severity?: string;
  stepsToReproduce?: string;
  expected?: string;
  actual?: string;
  rca?: string;
  environment?: string;
  documents?: DocumentLink[];
  tokenomics?: Record<string, string | number | boolean>;
}

function toEntityFields(f: WriteFields): EntityFields {
  return {
    name: f.name,
    description: f.description ?? "",
    acceptanceCriteria: parseCriteriaString(f.acceptanceCriteria ?? ""),
    documents: f.documents ?? [],
    status: f.status,
    role: f.role,
    target: f.target,
    severity: f.severity,
    stepsToReproduce: f.stepsToReproduce,
    expected: f.expected,
    actual: f.actual,
    rca: f.rca,
    environment: f.environment,
    tokenomics: f.tokenomics,
  };
}

/** Write a `<kind>.yaml` from field inputs. */
function writeEntityYaml(absFolder: string, kind: YamlKind, f: WriteFields): void {
  mkdirSync(absFolder, { recursive: true });
  writeFileSync(join(absFolder, `${kind}.yaml`), dumpEntity(kind, toEntityFields(f)), "utf8");
}

/** Relative folder path of an entity by id (via a rebuilt BoardModel), or null. */
function entityFolderPath(kind: YamlKind, id: string, board: BoardModel): string | null {
  if (kind === "campaign") return board.getCampaign(id)?.folderPath ?? null;
  if (kind === "mission") return board.getMission(id)?.folderPath ?? null;
  if (kind === "task") return board.getTask(id)?.folderPath ?? null;
  return board.getBug(id)?.folderPath ?? null;
}

/** The resolved status the BoardModel computed for an entity (used when migrating a legacy .md). */
function entityStatus(kind: YamlKind, id: string, board: BoardModel): string | undefined {
  if (kind === "campaign") return board.getCampaign(id)?.status;
  if (kind === "mission") return board.getMission(id)?.status;
  if (kind === "task") return board.getTask(id)?.status;
  return board.getBug(id)?.status;
}

/**
 * Read an entity's current fields — from `<kind>.yaml` (full fidelity) or, during migration, a
 * legacy `<kind>.md` (best-effort; role lives on the parent line and may be dropped). Returns null
 * if neither file exists.
 */
function loadCurrentFields(root: string, kind: YamlKind, folderPath: string, resolvedStatus: string | undefined): EntityFields | null {
  const yamlPath = join(root, folderPath, `${kind}.yaml`);
  if (existsSync(yamlPath)) return loadEntity(readFileSync(yamlPath, "utf8"));
  const mdPath = join(root, folderPath, `${kind}.md`);
  if (!existsSync(mdPath)) return null;
  const md = readFileSync(mdPath, "utf8");
  const mf = parseManagedBlock(md);
  return {
    name: mf.name,
    description: mf.description ?? "",
    acceptanceCriteria: parseCriteriaString(mf.acceptanceCriteria ?? ""),
    documents: parseDocumentLinks(md),
    status: resolvedStatus, // md keeps status on the parent line — use the model's resolved value
    target: mf.target,
    severity: mf.severity,
    stepsToReproduce: mf.stepsToReproduce,
    expected: mf.expected,
    actual: mf.actual,
    rca: mf.rca,
    environment: mf.environment,
  };
}

/**
 * Read-modify-write an entity's `<kind>.yaml`. Reading tolerates a legacy `<kind>.md` (which the
 * write then migrates to YAML, trashing the `.md`). Returns false if the entity isn't found.
 */
function patchEntity(root: string, kind: YamlKind, id: string, mutate: (f: EntityFields) => void): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const folderPath = entityFolderPath(kind, id, board);
  if (!folderPath) return false;
  const fields = loadCurrentFields(root, kind, folderPath, entityStatus(kind, id, board));
  if (!fields) return false;
  mutate(fields);
  const abs = join(root, folderPath);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, `${kind}.yaml`), dumpEntity(kind, fields), "utf8");
  // A legacy .md may linger; YAML wins on dual-read and the dedicated migration retires the .md.
  return true;
}

function siblingSlugs(dir: string): Set<string> {
  try {
    return new Set(
      readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

function relFromRoot(root: string, abs: string): string {
  return abs.slice(root.length).replace(/^[/\\]+/, "");
}

export function createCampaign(
  root: string,
  input: { name: string; description?: string; acceptanceCriteria?: string; target?: string },
): { id: string; folderPath: string } {
  const slug = uniqueSlug(slugify(input.name), siblingSlugs(join(root, "campaigns")));
  const folderPath = `campaigns/${slug}`;
  writeEntityYaml(join(root, folderPath), "campaign", {
    name: input.name,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    status: "draft",
    target: input.target ?? "",
  });
  return { id: `folder:${folderPath}`, folderPath };
}

/**
 * Add a human-facing board line under a section in a parent brief.
 *
 * Logic lifted from add-task.js:26-36 and add-bug.js:36-38:
 * 1. If the file contains a placeholder matching `_(none...)_` or `_(no bugs yet)_`, replace it.
 * 2. Else if the section already exists, append the line at end of file.
 * 3. Else create the section at end of file.
 */
export function addBoardLine(
  parentMdPath: string,
  section: "## Missions" | "## Tasks" | "## Bugs",
  line: string,
): void {
  let text = existsSync(parentMdPath) ? readFileSync(parentMdPath, "utf8") : "";
  // Matches both "_(none yet — ...)_" (tasks) and "_(no bugs yet)_" (bugs)
  const placeholderRe = /_\(none[^)]*\)_|_\(no [^)]*\)_/;
  const sectionRe = new RegExp(`^${section}\\s*$`, "m");

  if (sectionRe.test(text) && placeholderRe.test(text.slice(text.search(sectionRe)))) {
    // Replace the placeholder within the section area
    const head = text.search(sectionRe);
    text = text.slice(0, head) + text.slice(head).replace(placeholderRe, line);
  } else if (sectionRe.test(text)) {
    // Section exists, no placeholder — insert at end of the section's body,
    // immediately before the next ## heading (or at end of file if the target
    // section is the last one).
    const headIdx = text.search(sectionRe);
    const afterHead = text.slice(headIdx);
    // Find where the next ## heading starts (relative to afterHead)
    const nextHeadingMatch = afterHead.match(/\n(?=## )/);
    if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
      // Insert just before the blank/newline that precedes the next heading
      const insertAt = headIdx + nextHeadingMatch.index;
      const before = text.slice(0, insertAt);
      const after = text.slice(insertAt);
      text = (before.endsWith("\n") ? before : before + "\n") + line + "\n" + after;
    } else {
      // Target section is last — append at end of file
      text = (text.endsWith("\n") ? text : text + "\n") + line + "\n";
    }
  } else {
    // No section yet — create it at end of file
    text = (text.endsWith("\n") ? text : text + "\n") + `\n${section}\n${line}\n`;
  }
  writeFileSync(parentMdPath, text, "utf8");
}

function parentFolder(
  root: string,
  kind: "mission" | "task",
  parentId: string,
): { abs: string; parentMd: string; childrenDir: string } | null {
  const board = new BoardModel(root);
  board.rebuild();
  if (kind === "mission") {
    const c = board.getCampaign(parentId);
    if (!c) return null;
    return {
      abs: join(root, c.folderPath),
      parentMd: join(root, c.folderPath, "campaign.md"),
      childrenDir: join(root, c.folderPath, "missions"),
    };
  }
  if (kind === "task") {
    const m = board.getMission(parentId);
    if (!m) return null;
    return {
      abs: join(root, m.folderPath),
      parentMd: join(root, m.folderPath, "mission.md"),
      childrenDir: join(root, m.folderPath, "tasks"),
    };
  }
  return null;
}

export function createMission(
  root: string,
  campaignId: string,
  input: { title: string; description?: string; acceptanceCriteria?: string },
): { id: string; folderPath: string } {
  const p = parentFolder(root, "mission", campaignId);
  if (!p) throw new Error(`Campaign not found: ${campaignId}`);
  const slug = uniqueSlug(slugify(input.title), siblingSlugs(p.childrenDir));
  const folderPath = join(relFromRoot(root, p.childrenDir), slug);
  writeEntityYaml(join(p.childrenDir, slug), "mission", {
    name: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
  });
  // No parent projection — the mission is folder-derived, discovered by scanning missions/.
  return { id: `folder:${folderPath}`, folderPath };
}

export function createTask(
  root: string,
  missionId: string,
  input: { name: string; description?: string; acceptanceCriteria?: string; role?: string },
): { id: string; folderPath: string } {
  const p = parentFolder(root, "task", missionId);
  if (!p) throw new Error(`Mission not found: ${missionId}`);
  const slug = uniqueSlug(slugify(input.name), siblingSlugs(p.childrenDir));
  const folderPath = join(relFromRoot(root, p.childrenDir), slug);
  writeEntityYaml(join(p.childrenDir, slug), "task", {
    name: input.name,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    role: input.role,
  });
  // No parent projection — the task is folder-derived; its role/status live in its own task.yaml.
  return { id: `folder:${folderPath}`, folderPath };
}

export function createBug(
  root: string,
  parent: BugParent,
  input: { title: string; severity?: BugSeverity; description?: string },
): { id: string; folderPath: string } {
  const board = new BoardModel(root);
  board.rebuild();
  const parentEntity =
    "campaignId" in parent
      ? board.getCampaign(parent.campaignId)
      : board.getMission(parent.missionId);
  if (!parentEntity) throw new Error("Bug parent not found");
  const bugsDir = join(root, parentEntity.folderPath, "bugs");
  const slug = uniqueSlug(slugify(input.title), siblingSlugs(bugsDir));
  const folderPath = join(parentEntity.folderPath, "bugs", slug);
  writeEntityYaml(join(bugsDir, slug), "bug", {
    name: input.title,
    description: input.description ?? "",
    severity: input.severity ?? "major",
  });
  // No parent projection — the bug is folder-derived; its severity/status live in its own bug.yaml.
  return { id: `folder:${folderPath}`, folderPath };
}

// ── briefPathFor ─────────────────────────────────────────────────────────────

// ── updateBrief ───────────────────────────────────────────────────────────────

/**
 * Merge a patch of ManagedFields into an entity's .md file, preserving the
 * agent-owned tail below the `<!-- Auto-generated by Octobots` boundary comment.
 * Returns true on success, false if the entity or file is not found.
 */
export function updateBrief(root: string, kind: EntityKind, id: string, patch: Partial<ManagedFields>): boolean {
  if (kind === "workflow") return false;
  return patchEntity(root, kind, id, (f) => {
    if (patch.name !== undefined) f.name = patch.name;
    if (patch.description !== undefined) f.description = patch.description;
    if (patch.acceptanceCriteria !== undefined) f.acceptanceCriteria = parseCriteriaString(patch.acceptanceCriteria);
    if (patch.status !== undefined) f.status = patch.status;
    if (patch.target !== undefined) f.target = patch.target;
    if (patch.severity !== undefined) f.severity = patch.severity;
    if (patch.stepsToReproduce !== undefined) f.stepsToReproduce = patch.stepsToReproduce;
    if (patch.expected !== undefined) f.expected = patch.expected;
    if (patch.actual !== undefined) f.actual = patch.actual;
    if (patch.rca !== undefined) f.rca = patch.rca;
    if (patch.environment !== undefined) f.environment = patch.environment;
  });
}

// ── criteria / documents ─────────────────────────────────────────────────────

export function addCriterion(root: string, kind: EntityKind, id: string, text: string): boolean {
  if (kind === "workflow") return false;
  return patchEntity(root, kind, id, (f) => {
    f.acceptanceCriteria.push({ text, done: false });
  });
}

export function setCriterion(root: string, kind: EntityKind, id: string, index1: number, checked: boolean): boolean {
  if (kind === "workflow") return false;
  let hit = false;
  const ok = patchEntity(root, kind, id, (f) => {
    const c = f.acceptanceCriteria[index1 - 1];
    if (c) {
      c.done = checked;
      hit = true;
    }
  });
  return ok && hit;
}

export function addDocument(root: string, kind: EntityKind, id: string, label: string, target: string): boolean {
  if (kind === "workflow") return false;
  return patchEntity(root, kind, id, (f) => {
    if (!f.documents.some((d) => d.target === target)) f.documents.push({ label, target }); // idempotent on target
  });
}

export function removeDocument(root: string, kind: EntityKind, id: string, target: string): boolean {
  if (kind === "workflow") return false;
  return patchEntity(root, kind, id, (f) => {
    f.documents = f.documents.filter((d) => d.target !== target);
  });
}

// ── trashFolder / delete helpers ─────────────────────────────────────────────

/**
 * Soft-delete a folder by moving it under `octobots/.trash/`.
 * `octobots` is the root of the `.octobots` tree (the `root` arg in all write functions).
 * Creates `.trash/` if absent, renames into `.trash/<name>` (with `-2`/`-3` suffix on collision).
 * Falls back to `rmSync` on error.
 *
 * Returns true if the folder was moved/removed, false if it did not exist or nothing was done.
 * Never throws to the caller — all errors are swallowed internally.
 *
 * Folder-trash is the authoritative signal for "entity removed": the delete functions
 * (deleteTask, deleteBug, deleteMission, deleteCampaign) return this value directly.
 *
 * Ported from `.claude/skills/mission-planner/scripts/delete-task.js:77-91`; the walk-up is replaced
 * by the explicit `octobots` root since the library already has it as a parameter.
 */
export function trashFolder(folder: string, octobots?: string): boolean {
  // When folder does not exist there is nothing to remove.
  if (!existsSync(folder)) return false;
  // When octobots root is not supplied, walk up to find the .octobots ancestor (compat with scripts).
  let r = octobots;
  if (!r) {
    let cur = folder;
    while (basename(cur) !== ".octobots" && dirname(cur) !== cur) cur = dirname(cur);
    if (basename(cur) === ".octobots") r = cur;
  }
  try {
    if (r) {
      const trash = join(r, ".trash");
      mkdirSync(trash, { recursive: true });
      let dest = join(trash, basename(folder));
      for (let n = 2; existsSync(dest); n++) dest = join(trash, `${basename(folder)}-${n}`);
      renameSync(folder, dest);
      return true;
    }
  } catch { /* fall through to rmSync */ }
  try {
    rmSync(folder, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a single `## <section>` list line matching `entityName` (using
 * `boardLineEntityName(...).toLowerCase()` as the key, same as the read model).
 * Ported from `delete-bug.js:34-44` single-line filter logic.
 */
function removeSectionLine(
  briefPath: string,
  section: "## Missions" | "## Tasks" | "## Bugs",
  entityName: string,
): boolean {
  if (!existsSync(briefPath)) return false;
  const nameKey = boardLineEntityName(entityName).toLowerCase();
  const lines = readFileSync(briefPath, "utf8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${section}\\s*$`).test(l.trim()));
  if (start < 0) return false;
  let removed = false;
  const kept = lines.filter((raw, i) => {
    if (removed || i <= start) return true;
    if (/^##\s+/.test(raw.trim())) return true; // next section
    const m = raw.match(/^[-*]\s+(.*)$/) ?? raw.match(/^(\d+[.)]\s+)(.*)$/);
    if (!m) return true;
    // For `## Missions` and `## Bugs`, body is m[1]; for numbered items m[2]. Normalise:
    const body = m.length === 3 ? (m[2] ?? "") : (m[1] ?? "");
    // Strip leading [key:value] markers (severity, role, status)
    let rest = body.trim();
    for (let n = 0; n < 4; n++) rest = rest.replace(/^\[(?:[a-z]+):[^\]]+\]\s*/i, "").trim();
    if (boardLineEntityName(rest).toLowerCase() === nameKey) { removed = true; return false; }
    return true;
  });
  if (!removed) return false;
  writeFileSync(briefPath, kept.join("\n"), "utf8");
  return true;
}

/**
 * Remove the task's top-level block (item + nested lines) from mission.md `## Tasks`.
 * Ported from `delete-task.js:34-56` block-scan logic.
 */
function removeTaskBlock(briefPath: string, entityName: string): boolean {
  if (!existsSync(briefPath)) return false;
  const nameKey = boardLineEntityName(entityName).toLowerCase();
  const lines = readFileSync(briefPath, "utf8").split("\n");
  const start = lines.findIndex((l) => /^##\s+Tasks\s*$/.test(l.trim()));
  if (start < 0) return false;

  let sectionEnd = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test((lines[i] ?? "").trim())) { sectionEnd = i; break; }
  }

  const isTop = (l: string) => /^(\d+[.)]|[-*])\s+/.test(l);
  const tops: number[] = [];
  for (let i = start + 1; i < sectionEnd; i++) {
    if (isTop(lines[i] ?? "")) tops.push(i);
  }

  for (let t = 0; t < tops.length; t++) {
    const bStart = tops[t] ?? 0;
    const bEnd = t + 1 < tops.length ? (tops[t + 1] ?? sectionEnd) : sectionEnd;
    const head = lines[bStart] ?? "";
    const mt = head.match(/^(\d+)[.)]\s+(.*)$/);
    const mb = head.match(/^[-*]\s+(.*)$/);
    let title = (mt ? (mt[2] ?? "") : mb ? (mb[1] ?? "") : "");
    // Strip leading [key:value] markers (role, status, etc.)
    for (let n = 0; n < 4; n++) title = title.replace(/^\[(?:[a-z]+):[^\]]+\]\s*/i, "").trim();
    const hasNested = lines.slice(bStart + 1, bEnd).some((l) => l.trim() !== "");
    if (!hasNested) {
      const sep = title.match(/\s+[—–]\s+|:\s+/);
      if (sep && sep.index !== undefined) title = title.slice(0, sep.index).trim();
    }
    if (boardLineEntityName(title).toLowerCase() === nameKey) {
      const kept = [...lines.slice(0, bStart), ...lines.slice(bEnd)];
      writeFileSync(briefPath, kept.join("\n"), "utf8");
      return true;
    }
  }
  return false;
}

// ── Public delete API ─────────────────────────────────────────────────────────

/**
 * Delete a task: remove its block from mission.md `## Tasks` AND trash its folder.
 *
 * The entity FOLDER is authoritative for existence (BoardModel derives entities from disk).
 * Returns true iff the task was found AND its folder was successfully trashed/removed.
 * The board-line removal is best-effort cleanup and does not affect the return value.
 */
export function deleteTask(root: string, id: string): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const task = board.getTask(id);
  if (!task) return false;
  const mission = board.getMission(task.missionId);
  if (!mission) return false;
  const missionMd = join(root, mission.folderPath, "mission.md");
  // Best-effort: remove the board line; outcome does not affect the delete result.
  removeTaskBlock(missionMd, task.name);
  // Authoritative: folder-trash determines the return value.
  return trashFolder(join(root, task.folderPath), root);
}

/**
 * Delete a bug: remove its `## Bugs` line from the parent brief AND trash its folder.
 *
 * The entity FOLDER is authoritative for existence (BoardModel derives entities from disk).
 * Returns true iff the bug was found AND its folder was successfully trashed/removed.
 * The board-line removal is best-effort cleanup and does not affect the return value.
 */
export function deleteBug(root: string, id: string): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const bug = board.getBug(id);
  if (!bug) return false;
  // Resolve parent folder and brief path
  const parentFolderPath = bug.missionId
    ? board.getMission(bug.missionId)?.folderPath
    : board.getCampaign(bug.campaignId ?? "")?.folderPath;
  if (!parentFolderPath) return false;
  const parentMd = join(root, parentFolderPath, bug.missionId ? "mission.md" : "campaign.md");
  // Best-effort: remove the board line; outcome does not affect the delete result.
  removeSectionLine(parentMd, "## Bugs", bug.title);
  // Authoritative: folder-trash determines the return value.
  return trashFolder(join(root, bug.folderPath), root);
}

/**
 * Delete a mission: remove its `## Missions` line from campaign.md AND trash its folder.
 *
 * The entity FOLDER is authoritative for existence (BoardModel derives entities from disk).
 * Returns true iff the mission was found AND its folder was successfully trashed/removed.
 * The board-line removal is best-effort cleanup and does not affect the return value.
 */
export function deleteMission(root: string, id: string): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const mission = board.getMission(id);
  if (!mission) return false;
  const campaign = board.getCampaign(mission.campaignId);
  if (!campaign) return false;
  const campaignMd = join(root, campaign.folderPath, "campaign.md");
  // Best-effort: remove the board line; outcome does not affect the delete result.
  removeSectionLine(campaignMd, "## Missions", mission.title);
  // Authoritative: folder-trash determines the return value.
  return trashFolder(join(root, mission.folderPath), root);
}

/**
 * Delete a campaign: trash its folder (campaigns have no parent board line).
 *
 * The entity FOLDER is authoritative for existence (BoardModel derives entities from disk).
 * Returns true iff the campaign was found AND its folder was successfully trashed/removed.
 */
export function deleteCampaign(root: string, id: string): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const campaign = board.getCampaign(id);
  if (!campaign) return false;
  // Authoritative: folder-trash determines the return value.
  return trashFolder(join(root, campaign.folderPath), root);
}

// ── setStatus ────────────────────────────────────────────────────────────────

/**
 * Set the status of an entity on the board. Status lives in the entity's own YAML — no parent
 * projection. Returns true on success, false when the entity isn't found or the state is unknown.
 */
export function setStatus(root: string, kind: EntityKind, id: string, state: string): boolean {
  const mapped = mapBoardStatus(state);
  if (!mapped || kind === "workflow") return false;
  // Status lives in the entity's OWN yaml — no parent projection to keep in sync.
  return patchEntity(root, kind, id, (f) => {
    f.status = mapped;
  });
}

// ── Workflows ────────────────────────────────────────────────────────────────

/** The scaffold body written beside a new workflow's meta — a valid, runnable single-phase script. */
function scaffoldScript(meta: WorkflowMeta): string {
  return [
    `export const meta = ${serializeMeta(meta)}`,
    "",
    "// Body: use phase() / agent() / parallel() / pipeline().",
    "// Keep `meta.phases` above in step with the phases this body enters —",
    "// the Octobots board draws its diagram from meta, not from this code.",
    `phase(${JSON.stringify(meta.phases[0]?.title ?? "Run")})`,
    "",
  ].join("\n");
}

export function createWorkflow(
  root: string,
  parent: WorkflowParent,
  input: { name: string; description?: string },
): { id: string; folderPath: string } {
  const board = new BoardModel(root);
  board.rebuild();
  const parentEntity =
    "campaignId" in parent ? board.getCampaign(parent.campaignId) : board.getMission(parent.missionId);
  if (!parentEntity) throw new Error("Workflow parent not found");

  const workflowsDir = join(root, parentEntity.folderPath, "workflows");
  const slug = uniqueSlug(slugify(input.name), siblingSlugs(workflowsDir));
  const folderPath = `${parentEntity.folderPath}/workflows/${slug}`;
  const description = input.description ?? "";

  // A workflow is now just its script (plus an append-only runs.jsonl when it runs) — no workflow.md.
  mkdirSync(join(root, folderPath), { recursive: true });
  writeFileSync(
    join(root, folderPath, "workflow.js"),
    scaffoldScript({
      name: slug,
      description,
      phases: [{ title: "Run", steps: [{ id: "s1", agent: "claude", label: input.name }] }],
    }),
    "utf8",
  );

  return { id: `folder:${folderPath}`, folderPath };
}

/** Absolute path of a workflow's folder, or null when the id is unknown. */
function workflowFolder(root: string, id: string): string | null {
  const board = new BoardModel(root);
  board.rebuild();
  const wf = board.getWorkflow(id);
  return wf ? join(root, wf.folderPath) : null;
}

export function setWorkflowMeta(root: string, id: string, meta: WorkflowMeta): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  const jsPath = join(folder, "workflow.js");
  if (!existsSync(jsPath)) return false;

  const source = readFileSync(jsPath, "utf8");
  const span = findMetaSpan(source);
  if (!span) return false; // never rewrite a script whose meta we could not locate

  writeFileSync(jsPath, source.slice(0, span.start) + serializeMeta(meta) + source.slice(span.end), "utf8");
  return true;
}

export function appendWorkflowRun(
  root: string,
  id: string,
  entry: { status: string; summary: string; at: string },
): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  // Runs are an append-only log beside the script, one JSON object per line.
  const line = JSON.stringify({ status: entry.status, summary: entry.summary, at: entry.at }) + "\n";
  appendFileSync(join(folder, "runs.jsonl"), line, "utf8");
  return true;
}

export function deleteWorkflow(root: string, id: string): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  return trashFolder(folder, root);
}

/** Convert a legacy `## Runs` markdown body to newline-delimited runs.jsonl content. */
function legacyRunsToJsonl(runsBody: string): string {
  const out: string[] = [];
  for (const line of runsBody.split("\n")) {
    // Legacy line shape: `- [status:done] 2026-07-23 — 4 agents, 12m`
    const m = line.match(/^\s*-\s*\[status:([^\]]+)\]\s*(\S+)?\s*(?:—\s*(.*))?$/);
    if (!m) continue;
    out.push(JSON.stringify({ status: (m[1] ?? "").trim(), summary: (m[3] ?? "").trim(), at: (m[2] ?? "").trim() }));
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/**
 * One-time migration to the js-only workflow layout: for every `workflows/<slug>/` folder that still
 * has a `workflow.md`, materialize its `## Runs` log into `runs.jsonl` (only when none exists yet) and
 * delete the stray `workflow.md`. Idempotent — a folder with no `workflow.md` is untouched. Returns
 * how many `workflow.md` files were retired.
 */
export function migrateLegacyWorkflows(root: string): number {
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  let retired = 0;
  const sweep = (workflowsDir: string): void => {
    for (const slug of dirs(workflowsDir)) {
      const folder = join(workflowsDir, slug);
      const mdPath = join(folder, "workflow.md");
      if (!existsSync(mdPath)) continue;
      const runsPath = join(folder, "runs.jsonl");
      if (!existsSync(runsPath)) {
        const jsonl = legacyRunsToJsonl(parseManagedBlock(readFileSync(mdPath, "utf8")).runs ?? "");
        if (jsonl) writeFileSync(runsPath, jsonl, "utf8");
      }
      rmSync(mdPath, { force: true });
      retired++;
    }
  };
  const campaigns = join(root, "campaigns");
  for (const c of dirs(campaigns)) {
    sweep(join(campaigns, c, "workflows"));
    const missions = join(campaigns, c, "missions");
    for (const m of dirs(missions)) sweep(join(missions, m, "workflows"));
  }
  return retired;
}

// ── md → yaml entity migration ────────────────────────────────────────────────

/** The status / role / severity a child carries on its parent's `## Tasks`/`## Bugs`/`## Missions` line. */
interface ParentMarker {
  status?: string;
  role?: string;
  severity?: string;
}

/**
 * Parse the `[key:value]` markers off the board lines under a `## Tasks`/`## Bugs`/`## Missions`
 * section of a parent `.md`, keyed by the child's board-line entity name (lowercased). Prefers the
 * agent-owned tail after the `<!-- Auto-generated by Octobots` boundary comment; falls back to the
 * whole text. Used only by the md→yaml migration to fold a child's status/role/severity into the
 * child's own file (mirrors `board-model.ts` `parseSectionBoardStatuses`, extended to role/severity).
 */
function parseParentMarkers(text: string, section: "## Tasks" | "## Bugs" | "## Missions"): Map<string, ParentMarker> {
  const out = new Map<string, ParentMarker>();
  if (!text) return out;
  const boundaryIdx = text.indexOf("<!-- Auto-generated by Octobots");
  const scan = boundaryIdx >= 0 ? text.slice(boundaryIdx) : text;
  const head = new RegExp(`^${section}\\s*$`, "m").exec(scan);
  if (!head) return out;
  const after = scan.slice(head.index + head[0].length);
  const nextHeading = after.search(/^##\s+/m);
  const body = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
  for (const line of body.split("\n")) {
    const bullet = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)/);
    if (!bullet) continue;
    let rest = bullet[1] ?? "";
    const marker: ParentMarker = {};
    for (;;) {
      const m = rest.match(/^\[([a-z]+):([^\]]*)\]\s*/i);
      if (!m) break;
      const key = (m[1] ?? "").toLowerCase();
      const val = (m[2] ?? "").trim();
      if (key === "status") marker.status = mapBoardStatus(val) ?? undefined;
      else if (key === "role") marker.role = val || undefined;
      else if (key === "severity") marker.severity = val || undefined;
      rest = rest.slice(m[0].length);
    }
    const nameKey = boardLineEntityName(rest).toLowerCase();
    if (!nameKey) continue;
    out.set(nameKey, marker);
  }
  return out;
}

/**
 * Fold a legacy `## Tokenomics` markdown block (`key: value` lines) into the open `tokenomics` map.
 * Numeric values coerce to numbers and `true`/`false` to booleans; everything else stays a string,
 * so `estimate_basis`/`note`/`maturity` survive. Returns undefined when there is no block.
 */
function parseTokenomicsBlock(md: string): Record<string, string | number | boolean> | undefined {
  const block = /^##[ \t]+Tokenomics[ \t]*\n([\s\S]*?)(?=\n##\s|\n<!--|$(?![\s\S]))/m.exec(md)?.[1];
  if (block === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const line of block.split("\n")) {
    const m = /^\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m || !m[1] || m[2] === undefined) continue;
    const raw = m[2].trim();
    let val: string | number | boolean = raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw);
    else if (raw === "true" || raw === "false") val = raw === "true";
    out[m[1].toLowerCase()] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Migrate one entity folder from `<kind>.md` to `<kind>.yaml`, folding a parent board-line marker
 * (status/role/severity) and — for missions/tasks — a `## Tokenomics` block into the child's own
 * fields. Skips a folder that has no `.md` or already has a `.yaml` (never overwrites). After writing
 * the yaml it re-reads it, then trashes the source `.md` (soft-delete, never a hard delete). Returns
 * true iff a `.md` was migrated.
 */
function migrateOneEntity(
  root: string,
  folder: string,
  kind: YamlKind,
  markers: Map<string, ParentMarker> | null,
): boolean {
  const mdPath = join(folder, `${kind}.md`);
  const yamlPath = join(folder, `${kind}.yaml`);
  if (!existsSync(mdPath) || existsSync(yamlPath)) return false; // only migrate md-without-yaml (idempotent)

  const md = readFileSync(mdPath, "utf8");
  const mf = parseManagedBlock(md);
  const marker = markers?.get(boardLineEntityName(mf.name).toLowerCase());
  const campaignStatus = mf.status ? mapBoardStatus(mf.status) ?? mf.status : undefined;

  const fields: WriteFields = {
    name: mf.name,
    description: mf.description,
    acceptanceCriteria: mf.acceptanceCriteria,
    documents: parseDocumentLinks(md),
    // Campaign carries its own `## Status`; every other kind takes its status from the parent line.
    status: kind === "campaign" ? campaignStatus : marker?.status,
    role: marker?.role,
    target: mf.target,
    // Severity lives in the bug's own `## Severity`; a parent `[severity:]` marker is the fallback.
    severity: kind === "bug" ? mf.severity || marker?.severity : undefined,
    stepsToReproduce: mf.stepsToReproduce,
    expected: mf.expected,
    actual: mf.actual,
    rca: mf.rca,
    environment: mf.environment,
    tokenomics: kind === "mission" || kind === "task" ? parseTokenomicsBlock(md) : undefined,
  };

  writeFileSync(yamlPath, dumpEntity(kind, toEntityFields(fields)), "utf8");
  // Reversible-ish: re-read the yaml we just wrote before trashing the source — bail on a bad read.
  try {
    loadEntity(readFileSync(yamlPath, "utf8"));
  } catch {
    return false;
  }
  trashFolder(mdPath, root); // trash-not-delete the legacy `.md`
  return true;
}

/**
 * One-time, idempotent migration of every entity file from Markdown to YAML. For each entity folder
 * that still has a legacy `<kind>.md` and no `<kind>.yaml`, parse the `.md`, fold the parent's
 * `[status:]`/`[role:]`/`[severity:]` board-line markers and a `## Tokenomics` block into the CHILD's
 * yaml, write `<kind>.yaml`, then trash the `.md`. A folder already on yaml is skipped and an existing
 * yaml is never overwritten. Dual-read keeps a half-migrated board working mid-sweep. Returns how many
 * `.md` entity files were migrated.
 *
 * Mirrors the workflow.md-retirement pattern in `migrateLegacyWorkflows` above.
 */
export function migrateEntitiesToYaml(root: string): number {
  const dirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

  let migrated = 0;
  const bump = (ok: boolean): void => {
    if (ok) migrated++;
  };

  const campaignsDir = join(root, "campaigns");
  for (const cslug of dirs(campaignsDir)) {
    const cFolder = join(campaignsDir, cslug);
    // Read the parent .md up front — the children fold its board-line markers before it is trashed.
    const cMd = readIf(join(cFolder, "campaign.md"));
    const cBugMarkers = parseParentMarkers(cMd, "## Bugs");
    const cMissionMarkers = parseParentMarkers(cMd, "## Missions");

    // Campaign-level bugs.
    for (const bslug of dirs(join(cFolder, "bugs"))) {
      bump(migrateOneEntity(root, join(cFolder, "bugs", bslug), "bug", cBugMarkers));
    }

    // Missions and their children.
    for (const mslug of dirs(join(cFolder, "missions"))) {
      const mFolder = join(cFolder, "missions", mslug);
      const mMd = readIf(join(mFolder, "mission.md"));
      const mBugMarkers = parseParentMarkers(mMd, "## Bugs");
      const mTaskMarkers = parseParentMarkers(mMd, "## Tasks");
      for (const bslug of dirs(join(mFolder, "bugs"))) {
        bump(migrateOneEntity(root, join(mFolder, "bugs", bslug), "bug", mBugMarkers));
      }
      for (const tslug of dirs(join(mFolder, "tasks"))) {
        bump(migrateOneEntity(root, join(mFolder, "tasks", tslug), "task", mTaskMarkers));
      }
      // The mission itself takes its status from the campaign's `## Missions` marker.
      bump(migrateOneEntity(root, mFolder, "mission", cMissionMarkers));
    }

    // The campaign itself carries its own `## Status`; no parent markers.
    bump(migrateOneEntity(root, cFolder, "campaign", null));
  }
  return migrated;
}
