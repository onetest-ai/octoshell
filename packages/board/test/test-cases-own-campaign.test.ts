/**
 * TestCase parsing, listTestCases and per-mission AC coverage (mission M6 AC1) over REAL boards: what a
 * CI checkout has (`git archive HEAD .octobots`, this campaign's tracked tests) plus every board named in
 * OCTOBOTS_BOARD_COPIES (solo's uwb campaign, legacy frontmatter). Real boards change, so nothing here
 * asserts a count; every expectation is recomputed from the files by a separate, regex-level reader.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardModel } from "../src/board-model.js";
import { validateBoard } from "../src/validate.js";
import { loadEntity } from "../src/entity-schema.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";

const STATUSES = ["draft", "ready", "pass", "fail", "blocked"];

/** Every `campaigns/<slug>/tests/m<n>/TC-*.md` of a board, as board-relative paths, found by walking the folders. */
function tcFiles(board: string, slug: string): string[] {
  const tests = join(board, "campaigns", slug, "tests");
  if (!existsSync(tests)) return [];
  const out: string[] = [];
  for (const d of readdirSync(tests)) {
    if (!/^m\d+[a-z]*$/.test(d) || !statSync(join(tests, d)).isDirectory()) continue;
    for (const f of readdirSync(join(tests, d))) {
      if (/^TC-.*\.md$/.test(f) && statSync(join(tests, d, f)).isFile()) out.push(`campaigns/${slug}/tests/${d}/${f}`);
    }
  }
  return out.sort();
}

/** What a reader with no YAML parser sees: the raw frontmatter lines. */
function rawFrontmatter(text: string): string[] {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  return lines[0]?.trim() === "---" && end > 0 ? lines.slice(1, end) : [];
}
function rawCovers(fm: string[]): string[] {
  const i = fm.findIndex((l) => /^(covers|requirements):/.test(l));
  if (i < 0) return [];
  const inline = /\[(.*)\]/.exec(fm[i]!);
  if (inline) return inline[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const out: string[] = [];
  for (const l of fm.slice(i + 1)) {
    const m = /^\s+-\s*["']?([^"'\s]+)/.exec(l);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

describe("listTestCases over real boards", () => {
  it("lists exactly the TC-*.md files of every campaign, with status/covers/mission recomputed from the files", () => {
    let seen = 0;
    for (const board of trackedBoardCopies()) {
      const m = new BoardModel(board);
      m.rebuild();
      for (const camp of m.listCampaigns()) {
        const slug = camp.folderPath.split("/").pop()!;
        const files = tcFiles(board, slug);
        const cases = m.listTestCases(camp.id);
        expect(cases.map((t) => t.path).sort()).toEqual(files);
        for (const t of cases) {
          seen++;
          const text = readFileSync(join(board, t.path), "utf8");
          const fm = rawFrontmatter(text);
          const rawStatus = fm.map((l) => /^status:\s*["']?(\w+)/.exec(l)?.[1]).find(Boolean);
          expect(t.status).toBe(rawStatus && STATUSES.includes(rawStatus) ? rawStatus : "unknown");
          expect(t.mission).toBe("M" + /\/tests\/m(\d+[a-z]*)\//.exec(t.path)![1]);
          expect([...t.covers].sort()).toEqual([...new Set(rawCovers(fm))].sort());
          expect(t.id).toBe(t.path.split("/").pop()!.replace(/\.md$/, "").split("_")[0]);
        }
        // the optional mission filter takes m2, M2 or 2 and narrows to that folder
        for (const t of cases.slice(0, 3)) {
          const n = t.mission.slice(1);
          const expected = cases.filter((x) => x.mission === t.mission).map((x) => x.path);
          for (const arg of [`m${n}`, `M${n}`, n]) expect(m.listTestCases(camp.id, arg).map((x) => x.path)).toEqual(expected);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("this repo's own campaign: every tracked TC is listed and its mission has a coverage row per criterion", () => {
    const board = trackedBoardCopies()[0]!;
    const m = new BoardModel(board);
    m.rebuild();
    const camp = m.listCampaigns().find((c) => c.folderPath.endsWith("/direct-dispatch-process"))!;
    expect(camp).toBeTruthy();
    const cases = m.listTestCases(camp.id);
    const byMission = new Map<string, number>();
    for (const t of cases) byMission.set(t.mission, (byMission.get(t.mission) ?? 0) + 1);
    // the seven missions each authored tests/m<n>/
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(byMission.get(`M${n}`) ?? 0).toBeGreaterThan(0);
    // README.md, runs/ and evidence/ never become a TC
    expect(cases.some((t) => /README|\/runs\/|\/evidence\//.test(t.path))).toBe(false);
  });
});

describe("getTestCoverage", () => {
  it("maps each mission criterion to the TCs listing it in covers, and agrees with validate's uncovered warnings", () => {
    let rows = 0;
    let compared = 0;
    for (const board of trackedBoardCopies()) {
      const m = new BoardModel(board);
      m.rebuild();
      const findings = validateBoard(board).map((f) => f.message);
      for (const camp of m.listCampaigns()) {
        const cases = m.listTestCases(camp.id);
        for (const mission of m.listMissions(camp.id)) {
          const token = /^(M\d+[a-z]*)\b/i.exec(mission.title);
          const cov = m.getTestCoverage(mission.id);
          if (!token) { expect(cov.acs).toEqual([]); continue; }
          const id = `M${token[1]!.slice(1).toLowerCase()}`;
          // the criterion texts, whole: from the YAML entity (a criterion may span lines), else the md checklist
          const yamlFile = join(board, mission.folderPath, "mission.yaml");
          const criteria = existsSync(yamlFile)
            ? loadEntity(readFileSync(yamlFile, "utf8")).acceptanceCriteria.map((c) => c.text)
            : mission.acceptanceCriteria.split("\n").filter((l) => /^- \[[ xX]\] /.test(l)).map((l) => l.replace(/^- \[[ xX]\] /, ""));
          expect(cov.missionId).toBe(mission.id);
          expect(cov.mission).toBe(id);
          expect(cov.acs.map((a) => a.ac)).toEqual(criteria.map((_, i) => `${id}-AC${i + 1}`));
          cov.acs.forEach((a, i) => {
            rows++;
            expect(a.text).toBe(criteria[i]);
            const expected = cases.filter((t) => t.mission === id && t.covers.includes(a.ac)).map((t) => t.id).sort();
            expect([...a.tcs].sort()).toEqual(expected);
            expect(a.covered).toBe(expected.length > 0);
          });
          expect(cov.uncovered).toEqual(cov.acs.filter((a) => !a.covered).map((a) => a.ac));
          // Validate's per-criterion lines, for this mission's own tests folder. It says them only for a live
          // mission.yaml whose folder holds a README or a TC (a cancelled mission is exempt; a mission with
          // neither gets the single "README missing" line instead), so compare exactly there, never by bare
          // AC id (M1-AC1 exists in many campaigns).
          const rel = `${camp.folderPath}/tests/${token[1]!.toLowerCase()}`;
          const live = mission.status !== "cancelled" && existsSync(join(board, mission.folderPath, "mission.yaml"));
          const pairedFolder = !findings.includes(`${rel}/README.md: missing — ${id} has no tests README; run add-tests.js to scaffold it`) || cases.some((t) => t.mission === id);
          if (!live || !pairedFolder) continue;
          const warned = findings
            .map((msg) => new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (${id}-AC\\d+) is not covered by any test case$`).exec(msg)?.[1])
            .filter((x): x is string => !!x);
          expect(warned).toEqual(cov.uncovered);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
  });

  it("is empty for a mission id the board does not have", () => {
    const board = trackedBoardCopies()[0]!;
    const m = new BoardModel(board);
    m.rebuild();
    expect(m.getTestCoverage("no-such-mission").acs).toEqual([]);
  });
});

describe("cache invalidation", () => {
  /** A TC of this campaign that has a status line, and the two other statuses a write can move it to. */
  const pick = () => {
    const board = trackedBoardCopies()[0]!;
    const m = new BoardModel(board);
    m.rebuild();
    const camp = m.listCampaigns().find((c) => c.folderPath.endsWith("/direct-dispatch-process"))!;
    const t = m.listTestCases(camp.id).find((x) => x.status !== "unknown")!;
    const others = STATUSES.filter((s) => s !== t.status);
    return { board, m, camp, t, file: join(board, t.path), others };
  };
  const setStatus = (file: string, _from: string, to: string) => {
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^status: .*$/m);
    writeFileSync(file, text.replace(/^status: .*$/m, `status: ${to}`));
  };
  const statusOf = (m: BoardModel, campId: string, id: string, path: string) => m.listTestCases(campId).find((x) => x.path === path && x.id === id)!.status;

  it("a status written to the file shows on the next listing, with no rebuild (size/mtime/ctime check)", () => {
    const { m, camp, t, file, others } = pick();
    setStatus(file, t.status, others[0]!);
    expect(statusOf(m, camp.id, t.id, t.path)).toBe(others[0]);
    // pass -> fail keeps the byte length; pinning the same whole-millisecond mtime on both writes leaves
    // only ctime to tell them apart, and it must (a coarse-clock write must not hide)
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    setStatus(file, others[0]!, "pass");
    utimesSync(file, pinned, pinned);
    expect(statusOf(m, camp.id, t.id, t.path)).toBe("pass");
    const before = statSync(file);
    setStatus(file, "pass", "fail");
    utimesSync(file, pinned, pinned);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statusOf(m, camp.id, t.id, t.path)).toBe("fail");
  });

  it("a rebuild always re-reads, and an added TC joins the list", () => {
    const { board, m, camp, t, file, others } = pick();
    m.listTestCases(camp.id);
    setStatus(file, t.status, others[1]!);
    m.rebuild();
    expect(statusOf(m, camp.id, t.id, t.path)).toBe(others[1]);
    const extra = join(board, t.path.replace(/TC-[^/]+$/, "TC-990_added.md"));
    writeFileSync(extra, "---\nid: TC-990\ntitle: added\nstatus: ready\n---\n## Steps\n## Expected Final State\n");
    expect(m.listTestCases(camp.id).some((x) => x.id === "TC-990" && x.status === "ready")).toBe(true);
    unlinkSync(extra);
    expect(m.listTestCases(camp.id).some((x) => x.id === "TC-990")).toBe(false);
  });

  it("returns copies: a caller changing a result cannot change the cache", () => {
    const { m, camp } = pick();
    const a = m.listTestCases(camp.id);
    const status = a[0]!.status;
    a[0]!.status = status === "pass" ? "fail" : "pass";
    a[0]!.covers.push("M9-AC9");
    const b = m.listTestCases(camp.id)[0]!;
    expect(b.status).toBe(status);
    expect(b.covers).not.toContain("M9-AC9");
  });
});
