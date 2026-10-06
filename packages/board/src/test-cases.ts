// The TestCase entity: one `<campaign>/tests/m<n>/TC-*.md` file as the board lists it.
//
// A test case is NOT a fifth entity kind of the YAML board: it lives in markdown, its identity is its file
// path relative to the board root (`.octobots/`), and nothing here writes. The parser is lenient on purpose:
// a malformed or legacy file is still LISTED (status `unknown`, empty covers), and validate.ts is what
// warns about it. Field reading is the one `tc-io.ts` already has (frontmatter split/parse, `coversOf`,
// the reader that refuses a FIFO or an oversize file); there is no second parser.

import { readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { TC_KINDS, TC_STATUSES, coversOf, missionIdOfFolder, parseFrontmatter, readTestsText } from "./tc-io.js";

export type TestCaseKind = (typeof TC_KINDS)[number];
/** `unknown` is what a reader reports for a status that is absent or not one of the contract's values. */
export type TestCaseStatus = (typeof TC_STATUSES)[number];

export interface TestCaseRun {
  /** YYYY-MM-DD. */
  date: string;
  /** Repo-relative path of the RUN file, when recorded. */
  evidence?: string;
}

export interface TestCase {
  /** `TC-NNN`: the filename prefix before the first `_`. */
  id: string;
  title: string;
  /** `M<n>`, from the `m<n>` folder (the frontmatter `mission` is only ever checked against it). */
  mission: string;
  /** Acceptance-criterion ids it covers: frontmatter `covers`, else the legacy `requirements`. */
  covers: string[];
  /** `null` when absent or not one of api|ui|cli|unit. */
  kind: TestCaseKind | null;
  status: TestCaseStatus;
  lastRun?: TestCaseRun;
  /** The file, relative to the board root (`.octobots/`), `/`-separated. */
  path: string;
}

/** One mission criterion and the test cases listing it. */
export interface AcCoverage {
  /** `M<n>-AC<k>`. */
  ac: string;
  /** The criterion's text. */
  text: string;
  /** Ids of the test cases whose `covers` lists it. */
  tcs: string[];
  covered: boolean;
}

export interface MissionCoverage {
  missionId: string;
  /** `M<n>` token of the mission name, or null when the name carries none (then `acs` is empty). */
  mission: string | null;
  acs: AcCoverage[];
  /** The `ac` of every uncovered criterion, in order. */
  uncovered: string[];
}

const isoDay = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** The first `# ` heading of a markdown body, or null. */
const h1Of = (body: string): string | null => /^#[ \t]+(.+?)[ \t]*$/m.exec(body)?.[1] ?? null;

/**
 * One TC file as a TestCase. `folder` is the `m<n>` folder token, `path` the board-relative path. Never
 * throws: text that is empty, has no frontmatter or an unparseable one yields the file-derived fields.
 */
export function parseTestCase(opts: { fileName: string; folder: string; text: string; path: string }): TestCase {
  const { fileName, folder, text, path } = opts;
  const stem = fileName.replace(/\.md$/, "");
  const fm = parseFrontmatter(text);
  const data = fm.ok ? fm.data : {};
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : (h1Of(fm.body) ?? stem);
  const covers = [...new Set((coversOf(data) ?? []).filter((c): c is string => typeof c === "string"))];
  const kind = (TC_KINDS as readonly unknown[]).includes(data.kind) ? (data.kind as TestCaseKind) : null;
  const status = (TC_STATUSES as readonly unknown[]).includes(data.status) ? (data.status as TestCaseStatus) : "unknown";
  const tc: TestCase = { id: stem.split("_")[0]!, title, mission: missionIdOfFolder(folder), covers, kind, status, path };
  const run = data.last_run;
  if (typeof run === "object" && run !== null && !Array.isArray(run)) {
    const date = isoDay((run as Record<string, unknown>).date);
    const evidence = (run as Record<string, unknown>).evidence;
    if (date) tc.lastRun = typeof evidence === "string" && evidence ? { date, evidence } : { date };
  }
  return tc;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const statOrNull = (p: string): Stats | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/** What a cached parse is valid for: the file's size, mtime, ctime and inode. ctime moves on every write, even one that keeps the mtime. */
const stamp = (st: Stats): string => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

/** `m2` and `M2` and `2` and 2 all name the folder `m2`. */
export const missionFolderOf = (mission: string | number): string => `m${String(mission).trim().replace(/^[mM]/, "").toLowerCase()}`;

const folderOrder = (folder: string): [number, string] => {
  const m = /^m(\d+)(.*)$/.exec(folder);
  return [Number(m?.[1] ?? 0), m?.[2] ?? ""];
};

/**
 * Lazy, per campaign test-case reader. `list` stats every TC file of the campaign (cheap) and re-reads only
 * the ones whose size/mtime/ctime/inode moved since the last call, so a status written by set-test-status.js
 * shows on the next listing with no help from anyone. `clear()` drops everything (BoardModel.rebuild()).
 */
export class TestCaseReader {
  private readonly cache = new Map<string, { stamp: string; tc: TestCase }>();

  constructor(private readonly root: string | null) {}

  clear(): void {
    this.cache.clear();
  }

  /** The campaign's TCs (all missions, or the one `mission` names), by mission then file name. `campaignFolder` is `campaigns/<slug>`. */
  list(campaignFolder: string, mission?: string | number): TestCase[] {
    if (!this.root) return [];
    const testsDir = join(this.root, campaignFolder, "tests");
    let folders: string[];
    try {
      folders = readdirSync(testsDir).filter((d) => /^m\d+[a-z]*$/.test(d) && isDir(join(testsDir, d)));
    } catch {
      return [];
    }
    if (mission !== undefined) {
      const want = missionFolderOf(mission);
      folders = folders.filter((d) => d === want);
    }
    folders.sort((a, b) => {
      const [na, sa] = folderOrder(a);
      const [nb, sb] = folderOrder(b);
      return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
    const live = new Set<string>();
    const out: TestCase[] = [];
    for (const folder of folders) {
      const dir = join(testsDir, folder);
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => /^TC-.*\.md$/.test(n)).sort();
      } catch {
        continue;
      }
      for (const fileName of names) {
        const abs = join(dir, fileName);
        const st = statOrNull(abs);
        if (!st?.isFile()) continue;
        const path = `${campaignFolder}/tests/${folder}/${fileName}`;
        live.add(path);
        const key = stamp(st);
        let hit = this.cache.get(path);
        if (!hit || hit.stamp !== key) {
          hit = { stamp: key, tc: parseTestCase({ fileName, folder, text: readTestsText(abs) ?? "", path }) };
          this.cache.set(path, hit);
        }
        out.push({ ...hit.tc, covers: [...hit.tc.covers], ...(hit.tc.lastRun ? { lastRun: { ...hit.tc.lastRun } } : {}) });
      }
    }
    // forget files that are gone, but only when the whole campaign was listed
    if (mission === undefined) {
      for (const p of [...this.cache.keys()]) if (p.startsWith(`${campaignFolder}/tests/`) && !live.has(p)) this.cache.delete(p);
    }
    return out;
  }
}

/** Coverage of a mission's criteria (`<id>-AC1..ACn`, texts in order) by `cases`; only the cases of `id` count. */
export function computeCoverage(opts: { missionId: string; mission: string | null; criteria: string[]; cases: TestCase[] }): MissionCoverage {
  const { missionId, mission, criteria, cases } = opts;
  if (!mission) return { missionId, mission, acs: [], uncovered: [] };
  const acs = criteria.map((text, i): AcCoverage => {
    const ac = `${mission}-AC${i + 1}`;
    const tcs = cases.filter((t) => t.mission === mission && t.covers.includes(ac)).map((t) => t.id);
    return { ac, text, tcs, covered: tcs.length > 0 };
  });
  return { missionId, mission, acs, uncovered: acs.filter((a) => !a.covered).map((a) => a.ac) };
}
