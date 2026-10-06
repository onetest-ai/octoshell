// Shared inputs for the test-case panel tests (campaign octoshell-0-1-1, M1 T1.3): reading expected values out of a
// TC file's own frontmatter (never pinned from HEAD), and fixtures derived from this repo's real TC-004 and from the
// real shapes of solo's uwb TCs (named in the case, so a derived record says so).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedBoardCopies } from "./real-board.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The shipped pack script: the oracle for what a status write looks like, and an "agent" that edits a TC on disk. */
export const SET_TEST_STATUS = join(HERE, "..", "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts", "set-test-status.js");

export const DDP = "campaigns/direct-dispatch-process";
export const TC4 = `${DDP}/tests/m6/TC-004_sidebar-tests-node-counts.md`;

export const field = (text: string, key: string): string | undefined =>
  new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(text)?.[1];
export const unquote = (v: string | undefined): string | undefined => v?.replace(/^"(.*)"$/, "$1");
export const lastRunOf = (text: string): { date: string; evidence?: string } | null => {
  const line = field(text, "last_run");
  const date = line && /date:\s*([0-9-]+)/.exec(line)?.[1];
  if (!date) return null;
  const evidence = /evidence:\s*([^,}]+?)\s*[,}]/.exec(line)?.[1];
  return evidence ? { date, evidence } : { date };
};
export const coversOf = (text: string): string[] =>
  (/^(?:covers|requirements):\s*\[(.*)\]/m.exec(text)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const setFrontmatter = (text: string, key: string, line: string | null): string =>
  text.replace(new RegExp(`^${key}:.*\\n`, "m"), line === null ? "" : `${line}\n`);

/** A fixture derived from the real TC-004 text: `edit` rewrites it, then it lands as `name` in `folder`. */
export function derive(octo: string, name: string, edit: (real: string) => string, folder = "m6"): string {
  const real = readFileSync(join(octo, TC4), "utf8");
  const rel = `${DDP}/tests/${folder}/${name}`;
  mkdirSync(dirname(join(octo, rel)), { recursive: true });
  writeFileSync(join(octo, rel), edit(real));
  return rel;
}

/** Solo's uwb m1 TC-003, as the real file reads (legacy: requirements, no status, kind, mission or last_run). */
export const LEGACY_UWB_TC003 = `---
id: TC-003
title: Set ranging mode with layout id and 0 mm tag height and read it back after reload and restart
priority: critical
type: functional
module: venue-ingest-mode
size: M
requirements: [M1-AC2, M1-AC5]
tags: [uwb-ranging-m1, api, persistence, api-tbd]
---

# TC-003: Set ranging Mode and Persist

## Steps

| # | Action | Expected |
|---|--------|----------|
| 1 | Set mode | persisted |
`;

/** Solo's uwb m1 TC-006's Steps cell, the sanitizer record: angle-bracket text that is not HTML. */
export const UWB_TC006_CELL = "<id of first SCHEDULED match from GET {{base_url}}/api/ops/matches>";

/** Solo's uwb m5 TC-001 (M5 is cancelled in solo): its real frontmatter, body abbreviated. */
export const UWB_M5_TC001 = `---
id: TC-001
title: Verify emulator v01 gateway sends 5 Hz range sets per tag and waits for acks
priority: high
type: integration
module: ea-emulator v01 gateway
size: M
requirements: [M5-AC1]
tags: [emulator, v01, tcp, ack, pacing, tbd-flags, no-browser]
---

# TC-001: Emulator v01 gateway pacing and acks
`;

/** Write `text` as `name` in `folder` of this repo's direct-dispatch-process campaign copy; returns its board-relative path. */
export function put(octo: string, folder: string, name: string, text: string): string {
  const rel = `${DDP}/tests/${folder}/${name}`;
  mkdirSync(dirname(join(octo, rel)), { recursive: true });
  writeFileSync(join(octo, rel), text);
  return rel;
}

/** The named copy of solo's board in OCTOBOTS_BOARD_COPIES, or null when the run has none (then the derived cases cover it). */
export function soloBoardCopy(): string | null {
  for (const b of trackedBoardCopies().slice(1)) if (existsSync(join(b, "campaigns", "uwb-ranging-ingest-vendor-v01"))) return b;
  return null;
}

/** Run the shipped script on a TC file, as an agent outside the extension would. */
export function runScript(absTc: string, ...args: string[]): void {
  execFileSync(process.execPath, [SET_TEST_STATUS, absTc, ...args], { stdio: "pipe" });
}
