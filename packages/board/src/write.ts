import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { renderManagedBlock, parseManagedBlock, mapBoardStatus, boardLineEntityName, type EntityKind, type ManagedFields } from "./managed-block.js";
import { slugify, uniqueSlug } from "./slug.js";
import { type BugParent, type BugSeverity, type WorkflowParent } from "./types.js";
import { findMetaSpan, serializeMeta, parseWorkflowMeta, type WorkflowMeta } from "./workflow-meta.js";
import { BoardModel } from "./board-model.js";

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

function writeBrief(absFolder: string, kind: EntityKind, fields: ManagedFields, tail: string): void {
  mkdirSync(absFolder, { recursive: true });
  const managed = renderManagedBlock(kind, fields, [], kind === "campaign" ? "orchestrator" : "planner");
  writeFileSync(join(absFolder, `${kind}.md`), managed + tail, "utf8");
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
  writeBrief(join(root, folderPath), "campaign", {
    name: input.name,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
    status: "draft",
    target: input.target ?? "",
  }, "## Missions\n_(none yet — the orchestrator proposes missions here)_\n");
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
  writeBrief(join(p.childrenDir, slug), "mission", {
    name: input.title,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
  }, "## Tasks\n_(none yet — the planner proposes tasks here)_\n");
  addBoardLine(p.parentMd, "## Missions", `- ${input.title}`);
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
  writeBrief(join(p.childrenDir, slug), "task", {
    name: input.name,
    description: input.description ?? "",
    acceptanceCriteria: input.acceptanceCriteria ?? "",
  }, "## Tasks\n_(no sub-tasks — atomic task)_\n");
  const marker = input.role ? `[role:${input.role}] ` : "";
  addBoardLine(p.parentMd, "## Tasks", `- ${marker}${input.name}`);
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
  const parentMd = join(
    root,
    parentEntity.folderPath,
    "campaignId" in parent ? "campaign.md" : "mission.md",
  );
  const bugsDir = join(root, parentEntity.folderPath, "bugs");
  const slug = uniqueSlug(slugify(input.title), siblingSlugs(bugsDir));
  const folderPath = join(parentEntity.folderPath, "bugs", slug);
  writeBrief(join(bugsDir, slug), "bug", {
    name: input.title,
    description: input.description ?? "",
    acceptanceCriteria: "",
    severity: input.severity ?? "major",
  }, "");
  const marker = input.severity && input.severity !== "major" ? `[severity:${input.severity}] ` : "";
  addBoardLine(parentMd, "## Bugs", `- ${marker}${input.title}`);
  return { id: `folder:${folderPath}`, folderPath };
}

// ── briefPathFor ─────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to the entity's `.md` file given a rebuilt BoardModel.
 * Returns null if the entity is not found.
 */
function briefPathFor(root: string, kind: EntityKind, id: string, board: BoardModel): string | null {
  if (kind === "campaign") {
    const c = board.getCampaign(id);
    return c ? join(root, c.folderPath, "campaign.md") : null;
  }
  if (kind === "mission") {
    const m = board.getMission(id);
    return m ? join(root, m.folderPath, "mission.md") : null;
  }
  if (kind === "task") {
    const t = board.getTask(id);
    return t ? join(root, t.folderPath, "task.md") : null;
  }
  // bug
  const b = board.getBug(id);
  return b ? join(root, b.folderPath, "bug.md") : null;
}

// ── updateBrief ───────────────────────────────────────────────────────────────

/**
 * Merge a patch of ManagedFields into an entity's .md file, preserving the
 * agent-owned tail below the `<!-- Auto-generated by Octobots` boundary comment.
 * Returns true on success, false if the entity or file is not found.
 */
export function updateBrief(root: string, kind: EntityKind, id: string, patch: Partial<ManagedFields>): boolean {
  const board = new BoardModel(root);
  board.rebuild();
  const briefPath = briefPathFor(root, kind, id, board);
  if (!briefPath || !existsSync(briefPath)) return false;
  const current = readFileSync(briefPath, "utf8");
  const base = parseManagedBlock(current);
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<ManagedFields>;
  const fields = { ...base, ...defined } as ManagedFields;
  if (!fields.name) fields.name = base.name;
  fields.id = base.id ?? fields.id; // disk id wins
  const managed = renderManagedBlock(kind, fields, [], kind === "campaign" ? "orchestrator" : "planner");
  // Preserve the agent-owned tail below the boundary comment.
  let preserved = "";
  const ci = current.search(/^<!-- Auto-generated by Octobots/m);
  if (ci >= 0) {
    const nl = current.indexOf("\n", ci);
    if (nl >= 0) preserved = current.slice(nl + 1);
  }
  const tail = preserved.trim();
  const md =
    kind === "mission" && !tail
      ? `${managed}## Tasks\n_(none yet — the planner proposes tasks here)_\n`
      : tail
        ? `${managed}${preserved.endsWith("\n") ? preserved : preserved + "\n"}`
        : managed;
  if (md !== current) writeFileSync(briefPath, md, "utf8");
  return true;
}

// ── editSection / criteria / documents ───────────────────────────────────────

function editSection(briefPath: string, mutate: (lines: string[]) => boolean): boolean {
  if (!existsSync(briefPath)) return false;
  const lines = readFileSync(briefPath, "utf8").split("\n");
  if (!mutate(lines)) return false;
  writeFileSync(briefPath, lines.join("\n"), "utf8");
  return true;
}

export function addCriterion(root: string, kind: EntityKind, id: string, text: string): boolean {
  const board = new BoardModel(root); board.rebuild();
  const p = briefPathFor(root, kind, id, board); if (!p) return false;
  return editSection(p, (lines) => {
    const start = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/.test(l));
    if (start < 0) return false;
    const items: number[] = [];
    for (let i = start + 1; i < lines.length; i++) { if (/^##\s+/.test(lines[i] ?? "")) break; if (/^- \[[ xX]\]/.test(lines[i] ?? "")) items.push(i); }
    // drop a placeholder body if present
    const ph = lines.findIndex((l, i) => i > start && i < (items[0] ?? lines.length) && /_\(not set\)_/.test(l));
    const insertAt = items.length ? (items[items.length - 1] ?? start) + 1 : start + 1;
    if (ph >= 0) lines.splice(ph, 1);
    lines.splice(ph >= 0 && ph < insertAt ? insertAt - 1 : insertAt, 0, `- [ ] ${text}`);
    return true;
  });
}

export function setCriterion(root: string, kind: EntityKind, id: string, index1: number, checked: boolean): boolean {
  const board = new BoardModel(root); board.rebuild();
  const p = briefPathFor(root, kind, id, board); if (!p) return false;
  return editSection(p, (lines) => {
    const start = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/.test(l));
    if (start < 0) return false;
    const items: number[] = [];
    for (let i = start + 1; i < lines.length; i++) { if (/^##\s+/.test(lines[i] ?? "")) break; if (/^- \[[ xX]\]/.test(lines[i] ?? "")) items.push(i); }
    const li = items[index1 - 1]; if (li === undefined) return false;
    lines[li] = (lines[li] ?? "").replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]");
    return true;
  });
}

export function addDocument(root: string, kind: EntityKind, id: string, label: string, target: string): boolean {
  const board = new BoardModel(root); board.rebuild();
  const p = briefPathFor(root, kind, id, board); if (!p || !existsSync(p)) return false;
  let text = readFileSync(p, "utf8");
  const head = text.search(/^##\s+Documents\s*$/m);
  const line = `- [${label}](${target})`;
  if (head < 0) { text = `${text.replace(/\s+$/, "")}\n\n## Documents\n${line}\n`; }
  else {
    const after = text.slice(head);
    if (after.includes(`(${target})`)) return true;                       // idempotent
    text = after.replace(/_\(none\)_/, line) !== after
      ? text.slice(0, head) + after.replace(/_\(none\)_/, line)
      : text.slice(0, head) + after.replace(/(\n)(##\s+|<!--|$)/, `\n${line}\n$2`);
  }
  writeFileSync(p, text, "utf8");
  return true;
}

export function removeDocument(root: string, kind: EntityKind, id: string, target: string): boolean {
  const board = new BoardModel(root); board.rebuild();
  const p = briefPathFor(root, kind, id, board); if (!p || !existsSync(p)) return false;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => !(l.includes(`(${target})`) && /^\s*-\s+\[.+\]\(.+\)\s*$/.test(l)));
  writeFileSync(p, lines.join("\n"), "utf8");
  return true;
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
 * Parse leading `[key:value]` markers from a board line body.
 */
function splitMarkers(body: string): { markers: { key: string; value: string }[]; bare: string } {
  let rest = body;
  const markers: { key: string; value: string }[] = [];
  for (;;) {
    const m = rest.match(/^\[([a-z]+):([^\]]*)\]\s*/i);
    if (!m) break;
    markers.push({ key: (m[1] ?? "").toLowerCase(), value: (m[2] ?? "").trim() });
    rest = rest.slice(m[0].length);
  }
  return { markers, bare: rest.trim() };
}

/**
 * Upsert (or remove when value is null) a `[key:value]` marker on a board line identified by
 * entity name within a section. Preserves other markers (e.g. [role:dev]).
 * Returns true if the line was found and the file was (or already was) updated.
 */
function upsertLineMarker(
  parentMd: string,
  section: "## Missions" | "## Tasks" | "## Bugs",
  entityName: string,
  key: string,
  value: string | null,
): boolean {
  if (!existsSync(parentMd)) return false;
  const text = readFileSync(parentMd, "utf8");
  const lines = text.split("\n");
  const headIdx = lines.findIndex((l) => new RegExp(`^${section}\\s*$`).test(l));
  if (headIdx < 0) return false;
  const nameKey = boardLineEntityName(entityName).toLowerCase();
  for (let i = headIdx + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^##\s+/.test(l)) break;
    const bullet = l.match(/^([-*]\s+)(.*)$/) ?? l.match(/^(\d+[.)]\s+)(.*)$/);
    if (!bullet) continue;
    const { markers, bare } = splitMarkers(bullet[2] ?? "");
    if (boardLineEntityName(bare).toLowerCase() !== nameKey) continue;
    const kept = markers.filter((m) => m.key !== key);
    if (value !== null) kept.push({ key, value });
    lines[i] = kept.length > 0
      ? `${bullet[1]}${kept.map((m) => `[${m.key}:${m.value}]`).join(" ")} ${bare}`
      : `${bullet[1]}${bare}`;
    writeFileSync(parentMd, lines.join("\n"), "utf8");
    return true;
  }
  return false;
}


/**
 * Set `[status:X]` on a board line identified by entity name within a section.
 * Preserves other markers (e.g. [role:dev]). If no board line exists for the entity yet —
 * which happens under folder-path identity, where an entity can exist as a folder with no
 * line in its parent — CREATE one so the status can persist (otherwise it silently reverts to
 * draft on the next read). Always returns true when the parent file exists.
 */
function setLineStatus(
  parentMd: string,
  section: "## Missions" | "## Tasks" | "## Bugs",
  entityName: string,
  mapped: string,
): boolean {
  if (upsertLineMarker(parentMd, section, entityName, "status", mapped)) return true;
  if (!existsSync(parentMd)) return false;
  // No board line for this folder-identity entity — add one carrying the status marker. The
  // model reads status back keyed by `boardLineEntityName`, which round-trips the bare name.
  addBoardLine(parentMd, section, `- [status:${mapped}] ${entityName}`);
  return true;
}

/**
 * Set the status of an entity on the board.
 *
 * - campaign: rewrites the `## Status` section of campaign.md via updateBrief.
 * - mission: sets `[status:X]` on the mission's line in parent campaign.md `## Missions`.
 * - task: sets `[status:X]` on the task's line in parent mission.md `## Tasks`.
 * - bug: sets `[status:X]` on the bug's line in the parent's `## Bugs`.
 *
 * Returns true on success, false when the entity/line isn't found or the state is unknown.
 */
export function setStatus(root: string, kind: EntityKind, id: string, state: string): boolean {
  const mapped = mapBoardStatus(state);
  if (!mapped) return false;
  const board = new BoardModel(root);
  board.rebuild();
  if (kind === "campaign") {
    const c = board.getCampaign(id);
    if (!c) return false;
    return updateBrief(root, "campaign", id, { status: mapped });
  }
  if (kind === "mission") {
    const m = board.getMission(id);
    if (!m) return false;
    const c = board.getCampaign(m.campaignId);
    if (!c) return false;
    return setLineStatus(join(root, c.folderPath, "campaign.md"), "## Missions", m.title, mapped);
  }
  if (kind === "task") {
    const t = board.getTask(id);
    if (!t) return false;
    const m = board.getMission(t.missionId);
    if (!m) return false;
    return setLineStatus(join(root, m.folderPath, "mission.md"), "## Tasks", t.name, mapped);
  }
  // bug
  const bug = board.getBug(id);
  if (!bug) return false;
  const parentFolderPath = bug.missionId
    ? board.getMission(bug.missionId)?.folderPath
    : board.getCampaign(bug.campaignId ?? "")?.folderPath;
  if (!parentFolderPath) return false;
  const parentMd = join(root, parentFolderPath, bug.missionId ? "mission.md" : "campaign.md");
  return setLineStatus(parentMd, "## Bugs", bug.title, mapped);
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

export function updateWorkflow(root: string, id: string, patch: { description?: string }): boolean {
  const folder = workflowFolder(root, id);
  if (folder === null) return false;
  const jsPath = join(folder, "workflow.js");
  if (!existsSync(jsPath)) return false;

  // Description lives in the script's `meta` (the source of truth) — rewrite only that literal.
  const source = readFileSync(jsPath, "utf8");
  const span = findMetaSpan(source);
  if (!span) return false; // never rewrite a script whose meta we could not locate
  const meta = parseWorkflowMeta(source);
  const next: WorkflowMeta = { ...meta, description: patch.description ?? meta.description };
  writeFileSync(jsPath, source.slice(0, span.start) + serializeMeta(next) + source.slice(span.end), "utf8");
  return true;
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
