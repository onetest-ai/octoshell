#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = process.argv[2];
const digest = process.argv.includes("--digest");
if (!arg) { console.error("usage: show.js <board.md|entity-dir> [--digest]"); process.exit(2); }
let path = arg;
if (existsSync(arg) && statSync(arg).isDirectory()) {
  for (const name of ["campaign.md", "mission.md", "task.md"]) {
    if (existsSync(join(arg, name))) { path = join(arg, name); break; }
  }
}
if (!existsSync(path)) { console.error(`show: file not found: ${path}`); process.exit(2); }
const text = readFileSync(path, "utf8");

if (!digest) { process.stdout.write(text); process.exit(0); }

function section(label) {
  const re = new RegExp(`^##\\s+${label}\\s*$`, "m");
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const nextH = rest.search(/^##\s+/m);
  const comment = rest.search(/^<!--/m);
  const ends = [nextH, comment].filter((n) => n >= 0);
  const cut = ends.length ? Math.min(...ends) : -1;
  return (cut >= 0 ? rest.slice(0, cut) : rest).trim();
}
const titleM = text.match(/^#\s+(.*)$/m);
console.log(titleM ? titleM[1].trim() : "(untitled)");
const desc = section("Description"); if (desc) console.log(`\nDescription: ${desc}`);
const ac = section("Acceptance Criteria"); if (ac) console.log(`\nAcceptance Criteria:\n${ac}`);
