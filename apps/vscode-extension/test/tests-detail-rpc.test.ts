// T1.2: the host's two RPCs behind the test-case panel, over cp -R copies of real boards (campaign
// octoshell-0-1-1, rules 2, 10, 11). tests:get returns the panel's data; tests:setStatus writes exactly what the
// shipped set-test-status.js writes, or refuses without writing. Expected values are READ FROM THE FILES, never
// pinned from HEAD (a TC's status moves as work lands).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEntity } from "@octoshell/board";
import type { TestCaseDetail, SetTestStatusResult } from "../src/protocol/index.js";
import { realRpc } from "./fixtures/real-rpc.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SET = join(HERE, "..", "resources", "octobots-pack", "skill", "mission-planner", "scripts", "set-test-status.js");
const DDP = "campaigns/direct-dispatch-process";
const TC4 = `${DDP}/tests/m6/TC-004_sidebar-tests-node-counts.md`;
const DAY = "2026-11-03";
/** 23:59:30 UTC on DAY: a local-time day would differ for most zones, so this pins "UTC day". */
const CLOCK = () => new Date(`${DAY}T23:59:30Z`);

// ── reading expected values out of a TC file's own frontmatter ──────────────────────────────────
const field = (text: string, key: string): string | undefined => new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(text)?.[1];
const unq = (v: string | undefined): string | undefined => v?.replace(/^"(.*)"$/, "$1");
const lastRunOf = (text: string): { date: string; evidence?: string } | null => {
  const line = field(text, "last_run");
  const date = line && /date:\s*([0-9-]+)/.exec(line)?.[1];
  if (!date) return null;
  const evidence = /evidence:\s*([^,}]+?)\s*[,}]/.exec(line)?.[1];
  return evidence ? { date, evidence } : { date };
};
const coversOfText = (text: string): string[] => (/^(?:covers|requirements):\s*\[(.*)\]/m.exec(text)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const baseOf = (text: string) => ({ status: (field(text, "status") ?? "unknown") as string, lastRun: lastRunOf(text) });

/** The board copy plus a clone of it for the script oracle. */
function copies(): { a: string; b: string } {
  const a = trackedBoardCopies()[0]!;
  const b = join(mkdtempClean("tc-oracle-"), ".octobots");
  cpSync(a, b, { recursive: true });
  return { a, b };
}

/** A fixture derived from the real TC-004 text: `edit` rewrites it, then it lands as `name` beside it. */
function derive(octo: string, name: string, edit: (real: string) => string, folder = "m6"): string {
  const real = readFileSync(join(octo, TC4), "utf8");
  const rel = `${DDP}/tests/${folder}/${name}`;
  mkdirSync(dirname(join(octo, rel)), { recursive: true });
  writeFileSync(join(octo, rel), edit(real));
  return rel;
}
const setFrontmatter = (text: string, key: string, line: string | null): string =>
  text.replace(new RegExp(`^${key}:.*\\n`, "m"), line === null ? "" : `${line}\n`);

/**
 * Solo's uwb m1 TC-003 (a legacy TC: requirements, no status, kind, mission or last_run), as the real file reads.
 * Used as a literal so the case runs on every checkout; the sweep below reads every real TC of every board copy.
 */
const LEGACY_UWB_TC003 = `---
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

/** Solo's uwb m5 TC-001 (M5 is cancelled in solo): its real frontmatter, body abbreviated. */
const UWB_M5_TC001 = `---
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

/** A fixture derived from a solo uwb TC's text (`source`): `edit` rewrites it, then it lands as `name` in `folder`. */
function fromUwb(octo: string, source: string, name: string, folder: string, edit: (t: string) => string = (t) => t): string {
  const rel = `${DDP}/tests/${folder}/${name}`;
  mkdirSync(dirname(join(octo, rel)), { recursive: true });
  writeFileSync(join(octo, rel), edit(source));
  return rel;
}

const get = async (r: ReturnType<typeof realRpc>, path: string) => (await r.rpc.call("tests:get", { path })) as TestCaseDetail | null;
const setStatus = async (r: ReturnType<typeof realRpc>, path: string, status: string, base: unknown) =>
  (await r.rpc.call("tests:setStatus", { path, status, base })) as SetTestStatusResult;
const onChanged = (r: ReturnType<typeof realRpc>): { count: () => number } => {
  let n = 0;
  r.board.on("entities:changed", () => { n++; });
  return { count: () => n };
};
const script = (octo: string, rel: string, status: string, date?: string): void => {
  execFileSync(process.execPath, [SET, join(octo, rel), status, ...(date ? ["--date", date] : [])], { stdio: "pipe" });
};

describe("tests:get over the real TC-004 (values read from its frontmatter)", () => {
  it("returns the header, criterion text, mission, evidence flag, writable and a frontmatter-free markdown body", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo, CLOCK);
    const text = readFileSync(join(octo, TC4), "utf8");
    const d = await get(r, TC4);
    expect(d).not.toBeNull();
    expect(d!.tc.id).toBe("TC-004");
    expect(d!.tc.status).toBe(field(text, "status"));
    expect(d!.tc.kind).toBe(field(text, "kind"));
    expect(d!.tc.covers).toEqual(coversOfText(text));
    expect(d!.tc.title).toBe(unq(field(text, "title")));
    expect(d!.tc.path).toBe(TC4);
    const run = lastRunOf(text)!;
    expect(d!.tc.lastRun).toEqual(run);
    expect(d!.evidence).toEqual({ path: run.evidence, exists: true });
    // M6's third acceptance criterion, read from its mission.yaml
    const m6 = r.board.listMissions(r.board.listCampaigns().find((c) => c.folderPath === DDP)!.id).find((m) => m.title.startsWith("M6"))!;
    const ac3 = loadEntity(readFileSync(join(octo, m6.folderPath, "mission.yaml"), "utf8")).acceptanceCriteria[2]!.text;
    expect(d!.missionId).toBe(m6.id);
    expect(d!.mission).toEqual({ id: m6.id, title: m6.title, status: m6.status });
    expect(d!.campaignId).toBe(m6.campaignId);
    expect(d!.criteria).toEqual([{ ac: "M6-AC3", text: ac3 }]);
    expect(d!.legacy).toBe(false);
    expect(d!.writable).toEqual({ ok: true });
    expect(d!.body.kind).toBe("markdown");
    const bodyText = (d!.body as { text: string }).text;
    expect(bodyText.split("\n").find((l) => l.trim() !== "")).toMatch(/^# TC-004/);
    expect(bodyText).not.toMatch(/^(status|kind|covers|last_run|mission):/m);
    expect(bodyText).toBe(text.slice(text.indexOf("\n---\n", 3) + 5));
  });

  it("flags an evidence file that does not exist (path kept, exists false)", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-090_missing-evidence.md", (t) => t.replace(/evidence: [^,}]+/, "evidence: .octobots/nope/RUN-404.md"));
    const d = await get(realRpc(octo, CLOCK), rel);
    expect(d!.evidence).toEqual({ path: ".octobots/nope/RUN-404.md", exists: false });
  });

  it("has evidence null when the TC never ran", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-090_never-ran.md", (t) => setFrontmatter(t, "last_run", null));
    const d = await get(realRpc(octo, CLOCK), rel);
    expect(d!.evidence).toBeNull();
    expect(d!.tc.lastRun).toBeUndefined();
  });

  it("a covers id beyond the mission's criteria has text null; the others keep their text", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-091_ac99.md", (t) => t.replace(/^covers:.*$/m, "covers: [M6-AC3, M6-AC99]"));
    const d = await get(realRpc(octo, CLOCK), rel);
    expect(d!.criteria.map((c) => c.ac)).toEqual(["M6-AC3", "M6-AC99"]);
    expect(d!.criteria[0]!.text).toEqual(expect.any(String));
    expect(d!.criteria[1]!.text).toBeNull();
  });
});

describe("tests:get over TCs derived from solo's uwb shapes", () => {
  it("a legacy TC (uwb m1 TC-003): unknown status, kind null, both ACs with the mission's texts, legacy, writable", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-003_set-ranging-mode-persists.md", () => LEGACY_UWB_TC003, "m1");
    const r = realRpc(octo, CLOCK);
    const d = (await get(r, rel))!;
    expect(d.tc.status).toBe("unknown");
    expect(d.tc.kind).toBeNull();
    expect(d.tc.covers).toEqual(["M1-AC2", "M1-AC5"]);
    expect(d.legacy).toBe(true);
    expect(d.writable).toEqual({ ok: true });
    expect(d.criteria.every((c) => typeof c.text === "string" && c.text.length > 0)).toBe(true);
    expect(d.evidence).toBeNull();
    expect(d.body.kind).toBe("markdown");
  });

  it("a TC with kind but no mission is still legacy; a complete one is not", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo, CLOCK);
    const noMission = derive(octo, "TC-092_no-mission.md", (t) => setFrontmatter(t, "mission", null));
    const noKind = derive(octo, "TC-093_no-kind.md", (t) => setFrontmatter(t, "kind", null));
    expect((await get(r, noMission))!.legacy).toBe(true);
    expect((await get(r, noKind))!.legacy).toBe(true);
    expect((await get(r, TC4))!.legacy).toBe(false);
  });

  it("unparseable frontmatter (uwb TC-003 with a broken title): id from the filename, title from the H1, covers [], the text after the block as markdown, not writable", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = fromUwb(octo, LEGACY_UWB_TC003, "TC-094_broken-yaml.md", "m1", (t) => t.replace(/^title:.*$/m, 'title: "unterminated'));
    const d = (await get(realRpc(octo, CLOCK), rel))!;
    expect(d.tc.id).toBe("TC-094");
    expect(d.tc.title).toBe("TC-003: Set ranging Mode and Persist");
    expect(d.tc.status).toBe("unknown");
    expect(d.tc.kind).toBeNull();
    expect(d.tc.covers).toEqual([]);
    expect(d.writable).toEqual({ ok: false, reason: "unparseable" });
    expect(d.body.kind).toBe("markdown");
    expect((d.body as { text: string }).text).not.toMatch(/^(requirements|title|tags):/m);
    expect((d.body as { text: string }).text).toBe(LEGACY_UWB_TC003.slice(LEGACY_UWB_TC003.indexOf("\n---\n", 3) + 5));
    expect(d.legacy).toBe(false);
  });

  it("no frontmatter block (uwb TC-003 with its block cut, and a `---` rule in the body): the whole file as a plain body, title from the H1, writable no-frontmatter", async () => {
    const octo = trackedBoardCopies()[0]!;
    const text = `${LEGACY_UWB_TC003.slice(LEGACY_UWB_TC003.indexOf("\n---\n", 3) + 5)}\n---\n\nrule above is not a block\n`;
    const rel = fromUwb(octo, text, "TC-095_bare.md", "m1");
    const d = (await get(realRpc(octo, CLOCK), rel))!;
    expect(d.body).toEqual({ kind: "plain", text });
    expect(d.tc.id).toBe("TC-095");
    expect(d.tc.title).toBe("TC-003: Set ranging Mode and Persist");
    expect(d.writable).toEqual({ ok: false, reason: "no-frontmatter" });
  });

  it("uwb TC-003 padded over 4 MiB: body too-large (no text), writable too-large", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = fromUwb(octo, LEGACY_UWB_TC003, "TC-096_huge.md", "m1", (t) => `${t}\n${"x".repeat(4 * 1024 * 1024 + 10)}\n`);
    const d = (await get(realRpc(octo, CLOCK), rel))!;
    expect(d.body).toEqual({ kind: "too-large" });
    expect(d.writable).toEqual({ ok: false, reason: "too-large" });
    expect(JSON.stringify(d).length).toBeLessThan(100_000);
  });

  it("uwb TC-003 copied into a tests folder no mission names (m9): mission null, missionId null, criteria texts null", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = fromUwb(octo, LEGACY_UWB_TC003, "TC-003_set-ranging-mode-persists.md", "m9");
    const d = (await get(realRpc(octo, CLOCK), rel))!;
    expect(d.tc.mission).toBe("M9");
    expect(d.mission).toBeNull();
    expect(d.missionId).toBeNull();
    expect(d.campaignId).toEqual(expect.any(String));
    expect(d.criteria).toEqual([{ ac: "M1-AC2", text: null }, { ac: "M1-AC5", text: null }]);
  });

  it("a TC of a cancelled mission (uwb m5 TC-001, under a cancelled M5): mission.status cancelled, criteria texts still present, writable", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = fromUwb(octo, UWB_M5_TC001, "TC-001_emulator-v01-5hz-pacing-and-acks.md", "m5");
    const m5dir = readdirSync(join(octo, DDP, "missions")).find((n) => /^m5-/.test(n))!;
    const mf = join(octo, DDP, "missions", m5dir, "mission.yaml");
    writeFileSync(mf, readFileSync(mf, "utf8").replace(/^status: .*$/m, "status: cancelled"));
    const ac1 = loadEntity(readFileSync(mf, "utf8")).acceptanceCriteria[0]!.text;
    const d = (await get(realRpc(octo, CLOCK), rel))!;
    expect(d.mission?.status).toBe("cancelled");
    expect(d.criteria).toEqual([{ ac: "M5-AC1", text: ac1 }]);
    expect(d.legacy).toBe(true);
    expect(d.writable).toEqual({ ok: true });
  });

  it("a TC symlink resolving inside the board reads, but is not writable (symlink)", async () => {
    const octo = trackedBoardCopies()[0]!;
    symlinkSync(join(octo, TC4), join(octo, DDP, "tests", "m6", "TC-098_link.md"));
    const d = await get(realRpc(octo, CLOCK), `${DDP}/tests/m6/TC-098_link.md`);
    expect(d?.writable).toEqual({ ok: false, reason: "symlink" });
  });
});

describe("every real TC of every real board copy answers tests:get like the listing says", () => {
  it("returns a detail whose tc equals tests:list's, with a body and no frontmatter line in a markdown body", async () => {
    let seen = 0;
    for (const octo of trackedBoardCopies()) {
      const r = realRpc(octo, CLOCK);
      for (const c of r.board.listCampaigns()) {
        for (const tc of r.board.listTests(c.id)) {
          const d = await get(r, tc.path);
          expect(d, tc.path).not.toBeNull();
          expect(d!.tc, tc.path).toEqual(tc);
          expect(d!.body.kind, tc.path).toBe("markdown");
          const file = readFileSync(join(octo, tc.path), "utf8");
          const body = (d!.body as { text: string }).text;
          expect(file.endsWith(body) && body.length < file.length, tc.path).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("tests:setStatus writes what set-test-status.js writes, or refuses without writing", () => {
  it("pass with a matching base equals `set-test-status.js <tc> pass --date <clock day>` and emits entities:changed once", async () => {
    const { a, b } = copies();
    const before = readFileSync(join(a, TC4), "utf8");
    const status = field(before, "status") === "pass" ? "fail" : "pass";
    const r = realRpc(a, CLOCK);
    const ev = onChanged(r);
    const res = await setStatus(r, TC4, status, baseOf(before));
    expect(res).toMatchObject({ ok: true, changed: true });
    script(b, TC4, status, DAY);
    const after = readFileSync(join(a, TC4), "utf8");
    expect(after).toBe(readFileSync(join(b, TC4), "utf8"));
    expect(after).not.toBe(before);
    expect(lastRunOf(after)).toEqual({ date: DAY });
    expect(ev.count()).toBe(1);
    if (res.ok) expect(res.tc).toMatchObject({ status, path: TC4 });
    // the panel's next read, and the host's own model, see it
    expect((await get(r, TC4))!.tc.status).toBe(status);
    expect(r.board.listTests(r.board.listCampaigns().find((c) => c.folderPath === DDP)!.id).find((t) => t.path === TC4)!.status).toBe(status);
  });

  it("the date is the injected clock's UTC day, not the local day", async () => {
    const { a } = copies();
    const r = realRpc(a, () => new Date("2026-12-31T23:59:59.999Z"));
    const before = readFileSync(join(a, TC4), "utf8");
    await setStatus(r, TC4, field(before, "status") === "fail" ? "blocked" : "fail", baseOf(before));
    expect(lastRunOf(readFileSync(join(a, TC4), "utf8"))).toEqual({ date: "2026-12-31" });
  });

  it("ready on a file holding draft equals `set-test-status.js <tc> ready` (no --date) and leaves last_run alone", async () => {
    const { a, b } = copies();
    const rel = derive(a, "TC-090_draft.md", (t) => t.replace(/^status:.*$/m, "status: draft"));
    derive(b, "TC-090_draft.md", (t) => t.replace(/^status:.*$/m, "status: draft"));
    const before = readFileSync(join(a, rel), "utf8");
    const r = realRpc(a, CLOCK);
    const ev = onChanged(r);
    expect(await setStatus(r, rel, "ready", baseOf(before))).toMatchObject({ ok: true, changed: true });
    script(b, rel, "ready");
    const after = readFileSync(join(a, rel), "utf8");
    expect(after).toBe(readFileSync(join(b, rel), "utf8"));
    expect(lastRunOf(after)).toEqual(lastRunOf(before));
    expect(ev.count()).toBe(1);
  });

  it("base.status ready while the file holds fail: stale with current fail, bytes unchanged, no event", async () => {
    const { a } = copies();
    const rel = derive(a, "TC-091_fail.md", (t) => t.replace(/^status:.*$/m, "status: fail"));
    const before = readFileSync(join(a, rel), "utf8");
    const r = realRpc(a, CLOCK);
    const ev = onChanged(r);
    const res = await setStatus(r, rel, "pass", { status: "ready", lastRun: null });
    expect(res).toMatchObject({ ok: false, reason: "stale", current: { status: "fail" } });
    expect(readFileSync(join(a, rel), "utf8")).toBe(before);
    expect(ev.count()).toBe(0);
  });

  it("a base whose last_run moved is stale even when the status matches", async () => {
    const { a } = copies();
    const before = readFileSync(join(a, TC4), "utf8");
    const r = realRpc(a, CLOCK);
    const res = await setStatus(r, TC4, field(before, "status") === "pass" ? "fail" : "pass", { status: baseOf(before).status, lastRun: { date: "1999-01-01" } });
    expect(res).toMatchObject({ ok: false, reason: "stale" });
    expect(readFileSync(join(a, TC4), "utf8")).toBe(before);
  });

  it("re-sending the file's current status is a host no-op: changed false, bytes and mtime unchanged, no event", async () => {
    const { a } = copies();
    const rel = derive(a, "TC-092_pass.md", (t) => t.replace(/^status:.*$/m, "status: pass"));
    const abs = join(a, rel);
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(abs, old, old);
    const before = readFileSync(abs, "utf8");
    const r = realRpc(a, CLOCK);
    const ev = onChanged(r);
    expect(await setStatus(r, rel, "pass", baseOf(before))).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(abs, "utf8")).toBe(before);
    expect(statSync(abs).mtimeMs).toBe(old.getTime());
    expect(ev.count()).toBe(0);
  });

  it("on the legacy uwb TC-003 shape a pass writes status and last_run, equals the script, and leaves kind and mission absent", async () => {
    const { a, b } = copies();
    const rel = derive(a, "TC-003_set-ranging-mode-persists.md", () => LEGACY_UWB_TC003, "m1");
    derive(b, "TC-003_set-ranging-mode-persists.md", () => LEGACY_UWB_TC003, "m1");
    const r = realRpc(a, CLOCK);
    expect(await setStatus(r, rel, "pass", { status: "unknown", lastRun: null })).toMatchObject({ ok: true, changed: true });
    script(b, rel, "pass", DAY);
    const after = readFileSync(join(a, rel), "utf8");
    expect(after).toBe(readFileSync(join(b, rel), "utf8"));
    expect(after).not.toMatch(/^(kind|mission):/m);
    expect(after).toMatch(/^status: pass$/m);
    expect(lastRunOf(after)).toEqual({ date: DAY });
    expect((await get(r, rel))!.legacy).toBe(true);
  });

  it("refuses an unwritable file with its own reason, writing nothing and emitting nothing", async () => {
    const octo = trackedBoardCopies()[0]!;
    const bare = derive(octo, "TC-095_bare.md", () => "# TC-095\n\nno frontmatter\n");
    const broken = derive(octo, "TC-094_broken.md", (t) => t.replace(/^title:.*$/m, 'title: "unterminated'));
    symlinkSync(join(octo, TC4), join(octo, DDP, "tests", "m6", "TC-098_link.md"));
    const r = realRpc(octo, CLOCK);
    const ev = onChanged(r);
    const snap = (p: string) => readFileSync(join(octo, p), "utf8");
    const was = { bare: snap(bare), broken: snap(broken), tc4: snap(TC4) };
    expect(await setStatus(r, bare, "pass", { status: "unknown", lastRun: null })).toMatchObject({ ok: false, reason: "no-frontmatter" });
    expect(await setStatus(r, broken, "pass", { status: "unknown", lastRun: null })).toMatchObject({ ok: false, reason: "unparseable" });
    expect(await setStatus(r, `${DDP}/tests/m6/TC-098_link.md`, "pass", baseOf(was.tc4))).toMatchObject({ ok: false, reason: "symlink" });
    expect({ bare: snap(bare), broken: snap(broken), tc4: snap(TC4) }).toEqual(was);
    expect(readdirSync(join(octo, DDP, "tests", "m6")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(ev.count()).toBe(0);
  });
});

/** sha256 of every file (and symlink target text) under dir. */
function hashTree(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) out[p] = `-> ${readlinkSync(p)}`;
    else if (e.isDirectory()) hashTree(p, out);
    else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

describe("tests:get and tests:setStatus accept only a real TC path", () => {
  it("a `..` path, an absolute path, an outside symlink, a mission.yaml, a tests README and a TC-*.md outside campaigns/<c>/tests/ read null, refuse, and change nothing", async () => {
    const repo = mkdtempClean("tc-guard-");
    const octo = join(repo, ".octobots");
    cpSync(trackedBoardCopies()[0]!, octo, { recursive: true });
    const outside = join(repo, "TC-001_outside.md");
    writeFileSync(outside, "---\nid: TC-001\nstatus: draft\n---\n\n# outside\n");
    symlinkSync(outside, join(octo, DDP, "tests", "m6", "TC-099_escape.md"));
    const mission = readdirSync(join(octo, DDP, "missions")).find((n) => /^m6-/.test(n))!;
    writeFileSync(join(octo, DDP, "TC-001_misplaced.md"), "---\nid: TC-001\nstatus: draft\n---\n\n# misplaced\n");
    const paths = [
      "../TC-001_outside.md",
      `${DDP}/tests/m6/../../../../TC-001_outside.md`,
      outside,
      "/etc/passwd",
      `${DDP}/tests/m6/TC-099_escape.md`,
      `${DDP}/missions/${mission}/mission.yaml`,
      `${DDP}/tests/m6/README.md`,
      `${DDP}/TC-001_misplaced.md`,
      `${DDP}/campaign.yaml`,
    ];
    const before = hashTree(repo);
    const r = realRpc(octo, CLOCK);
    const ev = onChanged(r);
    for (const p of paths) {
      expect(await get(r, p), `get ${p}`).toBeNull();
      expect(await setStatus(r, p, "pass", { status: "draft", lastRun: null }), `set ${p}`).toMatchObject({ ok: false, reason: "refused" });
    }
    expect(hashTree(repo)).toEqual(before);
    expect(ev.count()).toBe(0);
  });

  it("a TC that is gone reads null and refuses a write", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo, CLOCK);
    const gone = `${DDP}/tests/m6/TC-777_gone.md`;
    expect(await get(r, gone)).toBeNull();
    expect(await setStatus(r, gone, "pass", { status: "draft", lastRun: null })).toMatchObject({ ok: false });
    expect(existsSync(join(octo, gone))).toBe(false);
  });

  it("refuses a path the lstat finds to be a directory named TC-*.md", async () => {
    const octo = trackedBoardCopies()[0]!;
    mkdirSync(join(octo, DDP, "tests", "m6", "TC-066_dir.md"));
    const r = realRpc(octo, CLOCK);
    expect(await get(r, `${DDP}/tests/m6/TC-066_dir.md`)).toBeNull();
    expect(await setStatus(r, `${DDP}/tests/m6/TC-066_dir.md`, "pass", { status: "draft", lastRun: null })).toMatchObject({ ok: false });
    expect(lstatSync(join(octo, DDP, "tests", "m6", "TC-066_dir.md")).isDirectory()).toBe(true);
  });
});
