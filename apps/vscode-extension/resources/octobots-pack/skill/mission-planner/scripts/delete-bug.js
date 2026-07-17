#!/usr/bin/env node
// Delete a bug from the board: remove its `## Bugs` line from the parent brief AND trash its
// `bugs/<slug>/` folder. Both are required — the app treats the .octobots tree as the source of
// truth and keeps a bug whose folder still exists, so removing only the line would not delete it.
// Writing the parent brief triggers the app's reconcile, which finalizes the removal.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const rawArgs = process.argv.slice(2);
const arg = rawArgs[0];
const title = (rawArgs[1] ?? "").trim();
if (!arg || !title) {
  console.error('usage: delete-bug.js <campaign.md|mission.md|entity-dir> "<bug title>"');
  process.exit(2);
}

// Resolve a directory arg to its brief: prefer mission.md, else campaign.md.
let brief = arg;
if (existsSync(arg) && statSync(arg).isDirectory()) {
  const mission = join(arg, "mission.md");
  brief = existsSync(mission) ? mission : join(arg, "campaign.md");
}
if (!existsSync(brief)) { console.error(`delete-bug: file not found: ${brief}`); process.exit(2); }
const parentDir = dirname(brief);
const titleKey = title.toLowerCase();

// 1) Remove the matching `## Bugs` line (strip leading [severity:]/[status:] markers when matching).
let lineRemoved = false;
{
  const lines = readFileSync(brief, "utf8").split("\n");
  const start = lines.findIndex((l) => /^##\s+Bugs\s*$/.test(l.trim()));
  if (start >= 0) {
    let removed = false;
    const kept = lines.filter((raw, i) => {
      if (removed || i <= start) return true;
      if (/^##\s+/.test(raw.trim())) return true; // next section
      const m = raw.match(/^[-*]\s+(.*)$/);
      if (!m) return true;
      let t = m[1].trim();
      for (let n = 0; n < 2; n++) t = t.replace(/^\[(?:severity|status):[^\]]+\]\s*/i, "").trim();
      if (t.toLowerCase() === titleKey) { removed = true; return false; }
      return true;
    });
    if (removed) { writeFileSync(brief, kept.join("\n"), "utf8"); lineRemoved = true; }
  }
}

// 2) Find + trash the bug folder whose bug.md `# heading` matches the title.
let folderTrashed = false;
const bugsDir = join(parentDir, "bugs");
if (existsSync(bugsDir)) {
  for (const slug of readdirSync(bugsDir)) {
    const md = join(bugsDir, slug, "bug.md");
    if (!existsSync(md)) continue;
    const heading = (readFileSync(md, "utf8").match(/^#\s+(.+?)\s*$/m)?.[1] ?? "").trim();
    if (heading.toLowerCase() === titleKey) { trashFolder(join(bugsDir, slug)); folderTrashed = true; break; }
  }
}

if (!lineRemoved && !folderTrashed) {
  console.error(`delete-bug: no bug titled "${title}" found (no board line, no bug.md folder)`);
  process.exit(1);
}
console.log(`deleted bug: ${title}${lineRemoved ? " [board line]" : ""}${folderTrashed ? " [folder→.trash]" : ""}`);

/** Soft-delete a folder by moving it under `.octobots/.trash/` (mirrors the app); fall back to rm. */
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
