#!/usr/bin/env node
// Delete a task from a mission board: remove its `## Tasks` block (the top-level item line plus its
// nested continuation lines) AND trash its `tasks/<slug>/` folder. Writing mission.md triggers the
// app's reconcile, which finalizes the removal (a draft task off the board is dropped; the trashed
// folder is pruned on the next disk reconcile for any non-draft task).
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const rawArgs = process.argv.slice(2);
const arg = rawArgs[0];
const name = (rawArgs[1] ?? "").trim();
if (!arg || !name) {
  console.error('usage: delete-task.js <mission.md|mission-dir> "<task name>"');
  process.exit(2);
}
let brief = arg;
if (existsSync(arg) && statSync(arg).isDirectory()) brief = join(arg, "mission.md");
if (!existsSync(brief)) { console.error(`delete-task: file not found: ${brief}`); process.exit(2); }
const missionDir = dirname(brief);
const nameKey = name.toLowerCase();

const cleanTitle = (s) =>
  s.replace(/^\[[ xX]\]\s*/, "").replace(/\*\*/g, "")
    .replace(/^\[(?:role|status):[^\]]+\]\s*/i, "").replace(/^\[(?:role|status):[^\]]+\]\s*/i, "").trim();

// 1) Remove the matching `## Tasks` block (top-level item + its nested lines).
let lineRemoved = false;
{
  const lines = readFileSync(brief, "utf8").split("\n");
  const start = lines.findIndex((l) => /^##\s+Tasks\s*$/.test(l.trim()));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test((lines[i] ?? "").trim())) { end = i; break; }
    const isTop = (l) => /^(\d+[.)]|[-*])\s+/.test(l);
    const tops = [];
    for (let i = start + 1; i < end; i++) if (isTop(lines[i] ?? "")) tops.push(i);
    for (let t = 0; t < tops.length; t++) {
      const bStart = tops[t];
      const bEnd = t + 1 < tops.length ? tops[t + 1] : end;
      const head = lines[bStart] ?? "";
      const mt = head.match(/^(\d+)[.)]\s+(.*)$/);
      const mb = head.match(/^[-*]\s+(.*)$/);
      let title = cleanTitle((mt ? mt[2] : mb ? mb[1] : "") ?? "");
      const hasNested = lines.slice(bStart + 1, bEnd).some((l) => l.trim() !== "");
      if (!hasNested) {
        const sep = title.match(/\s+[—–]\s+|:\s+/); // inline "Name — desc" → name is the head (ASCII hyphen stays in `T3.1 - name` ids)
        if (sep) title = title.slice(0, sep.index).trim();
      }
      if (title.toLowerCase() === nameKey) {
        const kept = [...lines.slice(0, bStart), ...lines.slice(bEnd)];
        writeFileSync(brief, kept.join("\n"), "utf8");
        lineRemoved = true;
        break;
      }
    }
  }
}

// 2) Trash the matching task folder.
let folderTrashed = false;
const tasksDir = join(missionDir, "tasks");
if (existsSync(tasksDir)) {
  for (const slug of readdirSync(tasksDir)) {
    const md = join(tasksDir, slug, "task.md");
    if (!existsSync(md)) continue;
    const heading = (readFileSync(md, "utf8").match(/^#\s+(.+?)\s*$/m)?.[1] ?? "").trim();
    if (heading.toLowerCase() === nameKey) { trashFolder(join(tasksDir, slug)); folderTrashed = true; break; }
  }
}

if (!lineRemoved && !folderTrashed) {
  console.error(`delete-task: no task named "${name}" found (no board line, no task.md folder)`);
  process.exit(1);
}
console.log(`deleted task: ${name}${lineRemoved ? " [board line]" : ""}${folderTrashed ? " [folder→.trash]" : ""}`);

function trashFolder(folder) {
  let root = folder;
  while (basename(root) !== ".octobots" && dirname(root) !== root) root = dirname(root);
  try {
    if (basename(root) === ".octobots") {
      const trash = join(root, ".trash");
      mkdirSync(trash, { recursive: true });
      let dest = join(trash, basename(folder));
      for (let n = 2; existsSync(dest); n++) dest = join(trash, `${basename(folder)}-${n}`);
      renameSync(folder, dest);
      return;
    }
  } catch { /* fall through */ }
  rmSync(folder, { recursive: true, force: true });
}
