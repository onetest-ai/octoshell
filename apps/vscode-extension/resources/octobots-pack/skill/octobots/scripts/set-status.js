#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// Set (or update) the `[status:<state>]` marker on an entity's `## Tasks` / `## Bugs` board line.
// Usage: set-status.js <parent board.md|dir> "<entity title>" <state>
//   <parent board.md|dir>  mission.md / campaign.md (or a dir containing one)
//   "<entity title>"       the task or bug title exactly as it reads on the board (markers ignored)
//   <state>                draft | active | executing | awaiting approval | done | failed | cancelled

const [arg, rawTitle, ...stateParts] = process.argv.slice(2);
const title = (rawTitle ?? "").trim();
const state = stateParts.join(" ").trim();
if (!arg || !title || !state) {
  console.error('usage: set-status.js <parent board.md|dir> "<entity title>" <state>');
  console.error("  state: draft | active | executing | awaiting approval | done | failed | cancelled");
  process.exit(2);
}

// Canonical status vocabulary the board understands (see SKILL.md "Status vocabulary").
const VALID = new Set([
  "draft",
  "active",
  "executing",
  "awaiting approval",
  "done",
  "failed",
  "cancelled",
]);
const normalized = state.toLowerCase().replace(/[\s_-]+/g, " ");
if (!VALID.has(normalized)) {
  console.error(`set-status: invalid state "${state}" (expected one of: ${[...VALID].join(", ")})`);
  process.exit(2);
}

// Resolve a directory arg to its brief: prefer mission.md, else campaign.md.
let path = arg;
if (existsSync(arg) && statSync(arg).isDirectory()) {
  const mission = join(arg, "mission.md");
  path = existsSync(mission) ? mission : join(arg, "campaign.md");
}
if (!existsSync(path)) { console.error(`set-status: file not found: ${path}`); process.exit(2); }

// Strip leading `[key:value]` markers off a board-line body, returning the bare title plus the markers.
function splitMarkers(body) {
  let rest = body;
  const markers = [];
  for (;;) {
    const m = rest.match(/^\[([a-z]+):([^\]]*)\]\s*/i);
    if (!m) break;
    markers.push({ key: m[1].toLowerCase(), value: m[2].trim() });
    rest = rest.slice(m[0].length);
  }
  return { markers, bare: rest.trim() };
}

const titleKey = title.toLowerCase();
const text = readFileSync(path, "utf8");
const lines = text.split("\n");

// Campaign-self path: a campaign.md has no parent board line — its OWN status lives in a `## Status`
// managed section. When the board file is a campaign.md AND the given title matches the campaign's
// `# heading` (the campaign name), set/replace that section instead of hunting a ## Tasks/## Bugs line.
if (/(^|[\\/])campaign\.md$/.test(path)) {
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  const campaignName = heading ? (heading[1] ?? "").trim() : "";
  if (campaignName && campaignName.toLowerCase() === titleKey) {
    // Replace an existing `## Status` body, or insert a new section right after the `# heading`
    // (and its optional `<!-- octobots:id -->` marker), before any other section.
    const statusRe = /^##\s+Status\s*$/m;
    if (statusRe.test(text)) {
      const updated = text.replace(/^(##\s+Status\s*\n)[\s\S]*?(?=\n##\s|\n<!--|$)/m, `$1${normalized}\n`);
      writeFileSync(path, updated, "utf8");
    } else {
      const out = [];
      let inserted = false;
      for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!inserted) {
          const isHeading = /^#\s+/.test(lines[i]);
          const nextIsIdMarker = /^<!--\s*octobots:id\s/.test(lines[i + 1] ?? "");
          // Insert after the heading, or after the id marker if it directly follows the heading.
          if (isHeading && !nextIsIdMarker) {
            out.push("", "## Status", normalized);
            inserted = true;
          } else if (/^<!--\s*octobots:id\s/.test(lines[i])) {
            out.push("", "## Status", normalized);
            inserted = true;
          }
        }
      }
      writeFileSync(path, out.join("\n"), "utf8");
    }
    console.log(`set status of campaign "${title}" to ${normalized}`);
    process.exit(0);
  }
}

let matched = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // A board entity line is a `-`/`*` bullet or a `1.`/`1)` numbered item at column 0.
  const bullet = line.match(/^([-*]\s+)(.*)$/) ?? line.match(/^(\d+[.)]\s+)(.*)$/);
  if (!bullet) continue;
  const prefix = bullet[1];
  const { markers, bare } = splitMarkers(bullet[2]);
  if (bare.toLowerCase() !== titleKey) continue;

  // Idempotent: drop any existing status marker, keep the rest (e.g. [severity:]/[role:]) in order.
  const kept = markers.filter((m) => m.key !== "status");
  kept.push({ key: "status", value: normalized });
  const markerStr = kept.map((m) => `[${m.key}:${m.value}]`).join(" ");
  lines[i] = `${prefix}${markerStr} ${bare}`;
  matched = true;
  break;
}

if (!matched) {
  console.error(`set-status: no board line matching title "${title}" (check ## Tasks / ## Bugs)`);
  process.exit(1);
}

writeFileSync(path, lines.join("\n"), "utf8");
console.log(`set status of "${title}" to ${normalized}`);
