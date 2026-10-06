/**
 * Byte parity of the TC status writer (packages/board/src/tc-status.ts) with the pack's shipped
 * set-test-status.js (mission M1 / T1.1), the non-migrate path.
 *
 * Two oracles run the SHIPPED SCRIPT on one copy and the TypeScript on another and compare bytes:
 *  1. the shared case table fixtures/tc-status-cases.json (the awkward YAML shapes; each case with all
 *     five settable statuses, a refusal compared by outcome and by reason, against a recorded list so that
 *     "both refuse" cannot hide a broken oracle);
 *  2. every TC-*.md of every real board: the tracked board (`git archive HEAD .octobots`, what a CI checkout
 *     has) plus each board in OCTOBOTS_BOARD_COPIES, with each status that differs from the file's own.
 *     The script must refuse ZERO real pairs; no count is hard-coded.
 *
 * Statuses: pass, fail and blocked run the script with `--date D`; draft and ready run it with no flags (it
 * refuses --date there). Only statuses different from the file's current one are compared on real boards
 * (a same-status pass re-dates last_run in the script; the host skips it, tested in tc-status-write.test.ts).
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { editTestCaseStatus, parseTestCase, writeTestCaseStatus } from "../src/index.js";
import { gitArchiveBoard, scratchDir } from "./fixtures/real-board.js";

const SET = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/set-test-status.js");
const DATE = "2026-10-06";
const STATUSES = ["draft", "ready", "pass", "fail", "blocked"] as const;
type Status = (typeof STATUSES)[number];
const isRun = (s: Status): boolean => s === "pass" || s === "fail" || s === "blocked";
const dateFor = (s: Status): string | null => (isRun(s) ? DATE : null);
const CONCURRENCY = 8;
const SPAWN_TIMEOUT_MS = 60_000;

interface ScriptRun {
  code: number | string | null;
  stdout: string;
  stderr: string;
  refusal: string | null;
}

/** What the script's stderr says, as the reason words tc-status.ts uses; null when it exited 0. */
function classify(code: ScriptRun["code"], stderr: string): string | null {
  if (code === 0) return null;
  if (code !== 2) return `crashed (exit ${String(code)}): ${stderr.trim().split("\n")[0] ?? ""}`;
  if (/has no frontmatter/.test(stderr)) return "no-frontmatter";
  if (/is unparseable/.test(stderr)) return "unparseable";
  if (/could not edit the frontmatter of .* safely/.test(stderr)) return "unsafe";
  return `other: ${stderr.trim().split("\n")[0] ?? ""}`;
}

function runScript(file: string, status: Status): Promise<ScriptRun> {
  const args = [SET, file, status, ...(isRun(status) ? ["--date", DATE] : [])];
  return new Promise((done) => {
    execFile("node", args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? "error") : 0;
      done({ code: typeof code === "number" ? code : String(code), stdout, stderr, refusal: classify(typeof code === "number" ? code : -1, stderr) });
    });
  });
}

/** Run `fn` over `items`, at most `limit` at a time; results keep the input order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const put = (file: string, bytes: string | Buffer): void => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, bytes);
};

// ── 1. the shared case table ─────────────────────────────────────────────────────

interface Case { id: string; note: string; text: string }
const TABLE = JSON.parse(readFileSync(resolve(__dirname, "fixtures/tc-status-cases.json"), "utf8")) as {
  refusals: Record<string, Partial<Record<Status, string>>>;
  cases: Case[];
};

describe("tc-status parity: shared case table (shipped script vs editTestCaseStatus)", () => {
  it("holds every shape the plan lists, each with a note", () => {
    const ids = TABLE.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of TABLE.cases) expect(c.note, c.id).toMatch(/\S/);
    const wanted = [
      "t62-nested-status-and-block-scalar", "t62-comment-after-status", "t62-quoted-status-key", "t62-anchored-status-aliased", "t62-flow-mapping-frontmatter",
      "duplicate-status-key", "empty-frontmatter", "comment-only-frontmatter", "no-trailing-newline-at-eof", "list-form-last-run-flow", "list-form-last-run-block",
      "trailing-blank-and-comment-after-last-run-block", "trailing-blank-and-comment-after-last-run-end", "status-no-value", "crlf-line-endings", "leading-bom",
      "last-run-with-extra-note-key", "last-run-block-form", "last-run-before-status", "no-status-key", "quoted-status-value-double", "no-frontmatter", "unparseable-frontmatter",
      "real-tc004-new-frontmatter", "real-uwb-tc003-legacy",
    ];
    for (const id of wanted) expect(ids, id).toContain(id);
    // The record only names cases and statuses that exist.
    for (const [id, byStatus] of Object.entries(TABLE.refusals)) {
      expect(ids, id).toContain(id);
      for (const s of Object.keys(byStatus)) expect(STATUSES as readonly string[], `${id}/${s}`).toContain(s);
    }
    // Some cases are refused and some are not, or the table could not tell a working oracle from a broken one.
    expect(Object.keys(TABLE.refusals).length).toBeGreaterThan(0);
    expect(Object.keys(TABLE.refusals).length).toBeLessThan(ids.length);
  });

  it("writes the same bytes as the script for every case and status, and refuses exactly the recorded pairs for the recorded reason", { timeout: 300_000 }, async () => {
    const root = scratchDir("tc-status-cases-");
    const jobs = TABLE.cases.flatMap((c, ci) => STATUSES.map((status) => ({ c, status, dir: join(root, `${ci}-${status}`) })));
    const results = await pool(jobs, CONCURRENCY, async ({ c, status, dir }) => {
      const file = join(dir, "c", "tests", "m1", "TC-001_x.md");
      put(file, Buffer.from(c.text, "utf8"));
      const script = await runScript(file, status);
      return { c, status, script, scriptBytes: readFileSync(file) };
    });

    const mismatches: string[] = [];
    const seenRefusals: Record<string, Partial<Record<Status, string>>> = {};
    let compared = 0;
    for (const { c, status, script, scriptBytes } of results) {
      const edit = editTestCaseStatus(c.text, status, dateFor(status));
      const label = `${c.id} / ${status}`;
      if (script.refusal !== null) {
        (seenRefusals[c.id] ??= {})[status] = script.refusal;
        // the file is untouched by a refusal
        if (!scriptBytes.equals(Buffer.from(c.text, "utf8"))) mismatches.push(`${label}: the script refused but changed the file`);
        if (edit.ok) mismatches.push(`${label}: the script refused (${script.refusal}) but the edit succeeded`);
        else if (edit.reason !== script.refusal) mismatches.push(`${label}: the script refused as ${script.refusal}, the edit as ${edit.reason}`);
        continue;
      }
      compared++;
      if (!edit.ok) {
        mismatches.push(`${label}: the script wrote, the edit refused (${edit.reason}: ${edit.message})`);
        continue;
      }
      if (!Buffer.from(edit.text, "utf8").equals(scriptBytes)) mismatches.push(`${label}: bytes differ\n  script: ${JSON.stringify(scriptBytes.toString("utf8"))}\n  edit:   ${JSON.stringify(edit.text)}`);
      const scriptWrote = !/\(already\)/.test(script.stdout);
      if (edit.changed !== scriptWrote) mismatches.push(`${label}: changed ${String(edit.changed)} but the script ${scriptWrote ? "wrote" : "said (already)"}`);
    }
    expect(mismatches).toEqual([]);
    // The record is the script's actual behaviour, both ways (an unrecorded or vanished refusal fails here).
    expect(seenRefusals).toEqual(TABLE.refusals);
    expect(compared).toBeGreaterThan(TABLE.cases.length); // most pairs were compared as bytes, not as refusals
  });
});

// ── 2. every real TC ─────────────────────────────────────────────────────────────

/** Every `campaigns/<c>/tests/m<n>/TC-*.md` of a board directory: the path relative to the board, `/`-separated. */
function tcFilesOf(board: string): string[] {
  const out: string[] = [];
  const campaigns = join(board, "campaigns");
  if (!existsSync(campaigns)) return out;
  for (const c of readdirSync(campaigns).sort()) {
    const tests = join(campaigns, c, "tests");
    if (!existsSync(tests) || !statSync(tests).isDirectory()) continue;
    for (const folder of readdirSync(tests).sort()) {
      if (!/^m\d+[a-z]*$/.test(folder) || !statSync(join(tests, folder)).isDirectory()) continue;
      for (const f of readdirSync(join(tests, folder)).sort()) {
        if (/^TC-.*\.md$/.test(f) && statSync(join(tests, folder, f)).isFile()) out.push(`campaigns/${c}/tests/${folder}/${f}`);
      }
    }
  }
  return out;
}

/** Compare the script and the writer over every (TC, status) of one board; returns what was seen. */
async function compareBoard(board: string): Promise<{ tcs: number; pairs: number; refusals: string[]; mismatches: string[] }> {
  const scratch = scratchDir("tc-status-real-");
  const files = tcFilesOf(board);
  const jobs = files.flatMap((rel) => {
    const text = readFileSync(join(board, rel), "utf8");
    const current = parseTestCase({ fileName: rel.split("/").pop()!, folder: rel.split("/")[3]!, text, path: rel }).status;
    return STATUSES.filter((s) => s !== current).map((status) => ({ rel, status, text }));
  });
  const refusals: string[] = [];
  const mismatches: string[] = [];
  await pool(jobs.map((j, i) => ({ ...j, i })), CONCURRENCY, async ({ rel, status, text, i }) => {
    const scriptRoot = join(scratch, String(i), "script");
    const tsRoot = join(scratch, String(i), "ts");
    put(join(scriptRoot, rel), text);
    put(join(tsRoot, rel), text);
    const script = await runScript(join(scriptRoot, rel), status);
    if (script.refusal !== null) {
      refusals.push(`${rel} -> ${status}: ${script.refusal}`);
      return;
    }
    const ts = writeTestCaseStatus(tsRoot, rel, { status, date: dateFor(status) });
    if (!ts.ok) {
      mismatches.push(`${rel} -> ${status}: the script wrote, the writer refused (${ts.reason}: ${ts.message})`);
      return;
    }
    if (!ts.changed) mismatches.push(`${rel} -> ${status}: the script wrote but the writer reported changed: false`);
    if (!readFileSync(join(scriptRoot, rel)).equals(readFileSync(join(tsRoot, rel)))) mismatches.push(`${rel} -> ${status}: bytes differ`);
  });
  return { tcs: files.length, pairs: jobs.length, refusals, mismatches };
}

async function expectBoardParity(label: string, board: string): Promise<void> {
  const r = await compareBoard(board);
  console.info(`tc-status parity [${label}]: ${r.tcs} TCs, ${r.pairs} (TC, status) pairs compared, ${r.refusals.length} script refusals`);
  expect(r.tcs, `${label}: no TC found`).toBeGreaterThan(0);
  expect(r.pairs, `${label}: nothing compared`).toBeGreaterThan(0);
  expect(r.refusals, `${label}: the script refused real (TC, status) pairs, so agreement could come from both sides refusing`).toEqual([]);
  expect(r.mismatches).toEqual([]);
}

describe("tc-status parity: every real TC and every status different from the file's", () => {
  it("tracked board (git archive HEAD .octobots)", { timeout: 600_000 }, async () => {
    await expectBoardParity("tracked", gitArchiveBoard());
  });

  const named = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
  for (const [i, src] of named.entries()) {
    it(`OCTOBOTS_BOARD_COPIES[${i}] ${src}`, { timeout: 600_000 }, async () => {
      // Read only: the comparison copies each file into its own scratch directory, nothing is written under `src`.
      await expectBoardParity(`copies[${i}] ${src}`, src);
    });
  }
});
