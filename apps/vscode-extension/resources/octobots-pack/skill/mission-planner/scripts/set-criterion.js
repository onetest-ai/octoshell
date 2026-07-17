#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [path, op, arg] = process.argv.slice(2);
if (!path || !existsSync(path) || !op) {
  console.error('usage: set-criterion.js <board.md> add "<text>" | check <n> | uncheck <n>');
  process.exit(2);
}
const lines = readFileSync(path, "utf8").split("\n");
const start = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/.test(l.trim()));
if (start < 0) { console.error("set-criterion: no '## Acceptance Criteria' section"); process.exit(1); }
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i].trim()) || lines[i].startsWith("<!--")) { end = i; break; }
}
const itemIdx = []; // indices of `- [ ]`/`- [x]` lines within the section
for (let i = start + 1; i < end; i++) if (/^\s*[-*]\s*\[[ xX]\]/.test(lines[i])) itemIdx.push(i);

if (op === "add") {
  const text = (arg ?? "").trim();
  if (!text) { console.error("set-criterion add: missing text"); process.exit(2); }
  const insertAt = itemIdx.length ? itemIdx[itemIdx.length - 1] + 1 : start + 1;
  lines.splice(insertAt, 0, `- [ ] ${text}`);
} else if (op === "check" || op === "uncheck") {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > itemIdx.length) { console.error(`set-criterion: index out of range (1..${itemIdx.length})`); process.exit(2); }
  const li = itemIdx[n - 1];
  lines[li] = lines[li].replace(/\[[ xX]\]/, op === "check" ? "[x]" : "[ ]");
} else {
  console.error(`set-criterion: unknown op '${op}'`); process.exit(2);
}
writeFileSync(path, lines.join("\n"), "utf8");
console.log(`acceptance criteria updated (${op})`);
