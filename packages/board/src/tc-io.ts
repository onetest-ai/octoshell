// Test-case (TC) files and a mission's functional-test folder, as the board sees them.
//
// A TC is `<campaign>/tests/m<n>/TC-NNN_<slug>.md`: YAML frontmatter between the first two `---` lines,
// then a markdown body. This module splits, parses and serializes that frontmatter (the body is carried
// byte-for-byte), holds the field checks of the TC format contract, and the pairing rule validateBoard
// reports: a mission's tests README exists and is linked, every acceptance criterion is covered by some
// TC, and the README's AC map agrees with the TC frontmatter.
//
// Every finding is a WARNING and a plain string: `<path relative to the board root>: <what is wrong>`,
// `/`-separated; validate.ts wraps each in a BoardFinding.
//
// DUAL IMPLEMENTATION: this is the TypeScript spelling of the pack's
// `resources/octobots-pack/skill/mission-planner/scripts/tc-io.mjs` (the pack script stays
// dependency-free, so it cannot import this). Text and rules must stay equal;
// `test/validate-tests-parity.test.ts` runs both over real boards. Keep the two in step.

import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { mapBoardStatus } from "./managed-block.js";
import type { EntityFields } from "./entity-schema.js";

export const TC_KINDS = ["api", "ui", "cli", "unit"] as const;
export const TC_STATUSES = ["draft", "ready", "pass", "fail", "blocked", "unknown"] as const;
export const TC_ID_RE = /^TC-\d{3,}$/;
export const MISSION_ID_RE = /^M\d+[a-z]*$/;
export const AC_ID_RE = /^M\d+[a-z]*-AC\d+$/;
export const REQUIRED_SECTIONS = ["Steps", "Expected Final State"] as const;
/** The most a TC file or a tests README may hold (4 MiB); a larger one is read as unreadable. A literal, so a
 * bundle that imports @octoshell/board without validate (the octograph payload) tree-shakes it away. */
export const MAX_TC_BYTES = 4194304;

// ── frontmatter ──────────────────────────────────────────────────────────────────

/** A TC file cut into its frontmatter block and body: `head + yaml + tail + body === text`. */
export interface FrontmatterParts {
  head: string;
  yaml: string;
  tail: string;
  body: string;
}

export type FrontmatterData = Record<string, unknown>;
export type ParsedFrontmatter = { ok: true; data: FrontmatterData; body: string } | { ok: false; body: string };

/** The line starting at `pos`: its text (no line ending) and the offset just after its `\n`. */
function lineAt(text: string, pos: number): { line: string; end: number } {
  const i = text.indexOf("\n", pos);
  return i < 0 ? { line: text.slice(pos), end: text.length } : { line: text.slice(pos, i), end: i + 1 };
}

/**
 * Split `text` into its frontmatter block and body: the block is the first `---` line (a BOM may
 * precede it) up to the next `---` line. `head + yaml + tail + body === text` always, so a rewrite that
 * touches only `yaml` leaves every other byte alone. Null when there is no complete block.
 */
export function splitFrontmatter(text: string): FrontmatterParts | null {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const first = lineAt(text, bom);
  if (first.line.trimEnd() !== "---") return null;
  let pos = first.end;
  while (pos < text.length) {
    const next = lineAt(text, pos);
    if (next.line.trimEnd() === "---") {
      return {
        head: text.slice(0, first.end),
        yaml: text.slice(first.end, pos),
        tail: text.slice(pos, next.end),
        body: text.slice(next.end),
      };
    }
    pos = next.end;
  }
  return null;
}

/**
 * Parse a TC file's frontmatter. `ok: false` when there is no block, the YAML does not parse, or it is
 * not a mapping. `body` is everything after the block (the whole text when there is none).
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, body: text };
  let data: unknown;
  try {
    // A block holding nothing but blanks and comments is an empty mapping (the loader rejects empty input).
    data = /\S/.test(parts.yaml.replace(/^\s*#.*$/gm, "")) ? yamlLoad(parts.yaml) ?? {} : {};
  } catch {
    return { ok: false, body: parts.body };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, body: parts.body };
  return { ok: true, data: data as FrontmatterData, body: parts.body };
}

/** Frontmatter block + body for `data`; the inverse of `parseFrontmatter` (key order is kept). */
export function serializeFrontmatter(data: FrontmatterData, body: string): string {
  return `---\n${yamlDump(data, { lineWidth: -1, noRefs: true })}---\n${body}`;
}

/**
 * `text` with its frontmatter replaced by `update(data)` (it may mutate `data` and return nothing, or
 * return a new object). The opening and closing `---` lines and the body are kept byte-for-byte. Throws
 * when the frontmatter is missing or unparseable: nothing is guessed.
 */
export function rewriteFrontmatter(text: string, update: (data: FrontmatterData) => FrontmatterData | void): string {
  const parts = splitFrontmatter(text);
  const parsed = parseFrontmatter(text);
  if (!parts || !parsed.ok) throw new Error("frontmatter is missing or unparseable");
  const next = update(parsed.data) ?? parsed.data;
  return parts.head + yamlDump(next, { lineWidth: -1, noRefs: true }) + parts.tail + parts.body;
}

// ── TC file checks ───────────────────────────────────────────────────────────────

/** The acceptance-criterion ids a TC lists: `covers`, else the legacy `requirements`. Null when neither is a list. */
export function coversOf(data: FrontmatterData): unknown[] | null {
  const raw = data.covers ?? data.requirements;
  return Array.isArray(raw) ? raw : null;
}

/**
 * A legacy TC: its frontmatter parses but carries none of `status`, `kind` or `mission` (the fields the TC
 * format contract added; solo's uwb campaign predates them). It still lists, as status `unknown`; the
 * migrate suggestion is the one line `legacyMessage`. Twin of tc-io.mjs.
 */
export function isLegacyTc(data: FrontmatterData): boolean {
  return [data.status, data.kind, data.mission].every((v) => v === undefined || v === null);
}

/** The one-line suggestion for a legacy TC; the command is the one set-test-status.js (M6 T6.2) takes. */
export const LEGACY_TC_MESSAGE = "legacy test case (no status, kind or mission) lists as unknown: run set-test-status.js <tc-file> --migrate";

/**
 * The migrate suggestion for the TC file `text` (a warning line, after the path), or null: set when the file is
 * a legacy one (frontmatter parses, no status/kind/mission). Kept apart from `tcProblems`, which is the format
 * contract M4 defined; callers add it after the problems of the same file.
 */
export function legacyTcNote(text: string): string | null {
  const fm = parseFrontmatter(text);
  return fm.ok && isLegacyTc(fm.data) ? LEGACY_TC_MESSAGE : null;
}

const show = (v: unknown): string => JSON.stringify(v);

/** "M3b" for the folder token "m3b". */
export const missionIdOfFolder = (folder: string): string => `M${folder.slice(1)}`;

/**
 * Contract violations of one TC file, as messages (no path). `folder` is the `m<n>` folder token;
 * `acIds` the ids of the mission's acceptance criteria (null when the mission is not known: then only the
 * mission prefix is checked). Extra keys never warn; an absent `mission`, `kind` or `status` is fine.
 */
export function tcProblems(opts: { fileName: string; folder: string; text: string; acIds: Set<string> | null }): string[] {
  const { fileName, folder, text, acIds } = opts;
  const out: string[] = [];
  const fm = parseFrontmatter(text);
  const mission = missionIdOfFolder(folder);
  if (!fm.ok) {
    out.push("frontmatter is missing or unparseable");
  } else {
    const d = fm.data;
    const prefix = fileName.replace(/\.md$/, "").split("_")[0];
    if (d.id === undefined || d.id === null) out.push("id is missing");
    else if (typeof d.id !== "string" || !TC_ID_RE.test(d.id)) out.push(`id ${show(d.id)} does not match TC-NNN`);
    else if (d.id !== prefix) out.push(`id ${d.id} does not match the filename prefix ${prefix}`);

    if (d.mission !== undefined && d.mission !== null) {
      if (typeof d.mission !== "string" || !MISSION_ID_RE.test(d.mission)) out.push(`mission ${show(d.mission)} does not match M<n>`);
      else if (d.mission !== mission) out.push(`mission ${d.mission} does not match the folder ${folder} (expected ${mission})`);
    }

    const covers = coversOf(d);
    if (!covers || covers.length === 0) {
      out.push("covers (or legacy requirements) is missing or empty");
    } else {
      for (const ac of new Set(covers)) {
        if (typeof ac !== "string" || !AC_ID_RE.test(ac)) out.push(`covers names ${show(ac)}, which is not an acceptance-criterion id (${mission}-AC<k>)`);
        else if (acIds ? !acIds.has(ac) : !ac.startsWith(`${mission}-AC`)) out.push(`covers names ${ac}, which is not an acceptance criterion of ${mission}`);
      }
    }

    for (const [key, allowed] of [["kind", TC_KINDS], ["status", TC_STATUSES]] as const) {
      const v = d[key];
      if (v !== undefined && v !== null && !(allowed as readonly unknown[]).includes(v)) out.push(`${key} ${show(v)} is not one of ${allowed.join(", ")}`);
    }

  }
  for (const heading of REQUIRED_SECTIONS) {
    if (!new RegExp(`^## ${heading}[ \\t]*$`, "m").test(fm.body)) out.push(`missing the "## ${heading}" section`);
  }
  return out;
}

// ── README AC map ────────────────────────────────────────────────────────────────

export interface ReadmeMapRow {
  ac: string;
  tcs: string[];
}

/**
 * The rows of a tests README's AC map: every markdown table row whose first cell names acceptance
 * criteria (`M1-AC3`), with the TC ids found in its last cell. The header, the separator and any other
 * table are skipped, so the map is found wherever the README puts it.
 */
export function parseReadmeMap(text: string): ReadmeMapRow[] {
  const rows: ReadmeMapRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
    const acs = cells[0]!.match(/\bM\d+[a-z]*-AC\d+\b/g);
    if (!acs) continue;
    const tcs = cells.length > 1 ? [...new Set(cells[cells.length - 1]!.match(/\bTC-\d{3,}\b/g) ?? [])] : [];
    for (const ac of new Set(acs)) rows.push({ ac, tcs });
  }
  return rows;
}

// ── a mission's tests folder ─────────────────────────────────────────────────────

const posix = (p: string): string => p.split(sep).join("/");
/**
 * The text of a TC or README, or null. Only a regular file of at most MAX_TC_BYTES is read, opened
 * non-blocking and checked with fstat on that same descriptor: tests/ is written by QA and by hand, and
 * a FIFO or a symlink to /dev/zero named README.md would otherwise block the extension host forever.
 * Twin of tc-io.mjs `readTestsText` (which uses pending-io.mjs `readRegularFile`).
 */
export function readTestsText(p: string): string | null {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_TC_BYTES) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
const readTextOrNull = readTestsText;
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** `{ id: "M3b", folder: "m3b" }` from a mission name starting with its id token, else null. */
export function missionToken(name: string | undefined): { id: string; folder: string } | null {
  const m = /^(M\d+[a-z]*)\b/i.exec(String(name ?? "").trim());
  return m ? { id: `M${m[1]!.slice(1).toLowerCase()}`, folder: m[1]!.toLowerCase() } : null;
}

/** The ids `<mission>-AC1..ACn` of a mission with `n` acceptance criteria. */
export const acIdsOf = (id: string, n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `${id}-AC${i + 1}`));

/**
 * Pairing findings for one mission of the campaign at `campaignDir`, as `<rel>: <message>` strings with
 * `rel` relative to `base` (the board root). Nothing for a cancelled mission, or one whose name carries
 * no `M<n>` token. A mission with no `tests/m<n>/` folder gets the one missing-README finding; with a
 * folder, the README link, the AC coverage, the README map and every TC file are checked. Reads one
 * directory and its TC/README files.
 */
export function missionTestsFindings(opts: {
  campaignDir: string;
  campaign: string;
  base: string;
  mission: Pick<EntityFields, "name" | "status" | "acceptanceCriteria" | "documents">;
}): string[] {
  const { campaignDir, campaign, base, mission } = opts;
  if (mapBoardStatus(mission.status ?? "") === "cancelled") return [];
  const token = missionToken(mission.name);
  if (!token) return [];
  const { id, folder } = token;
  const dir = join(campaignDir, "tests", folder);
  const rel = posix(relative(base, dir));
  const readmeRel = `${rel}/README.md`;
  const out: string[] = [];

  let entries: Dirent[] | null;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = null;
  }
  const readme = entries ? readTextOrNull(join(dir, "README.md")) : null;
  if (readme === null) out.push(`${readmeRel}: missing — ${id} has no tests README; run add-tests.js to scaffold it`);
  if (!entries) return out;

  const target = `.octobots/campaigns/${campaign}/tests/${folder}/README.md`;
  if (readme !== null && !mission.documents.some((d) => d.target === target)) {
    out.push(`${readmeRel}: not linked from the ${id} documents (expected target ${target}); run add-tests.js to link it`);
  }

  const acIds = acIdsOf(id, mission.acceptanceCriteria.length);
  const files = entries.filter((e) => /^TC-.*\.md$/.test(e.name) && isFile(join(dir, e.name))).map((e) => e.name).sort();
  const tcs = files.map((fileName) => {
    const text = readTextOrNull(join(dir, fileName)) ?? "";
    const fm = parseFrontmatter(text);
    const covers: unknown[] = fm.ok ? coversOf(fm.data) ?? [] : [];
    return { fileName, text, num: fileName.replace(/\.md$/, "").split("_")[0]!, covers };
  });

  // A folder holding neither a README nor a TC (runs/ and evidence/ only) is one finding, not one per criterion.
  if (readme === null && tcs.length === 0) return out;
  const covered = new Set(tcs.flatMap((t) => t.covers));
  for (const ac of acIds) if (!covered.has(ac)) out.push(`${rel}: ${ac} is not covered by any test case`);

  if (readme !== null) {
    const seen = new Set<string>();
    for (const { ac, tcs: listed } of parseReadmeMap(readme)) {
      if (!acIds.has(ac)) {
        seen.add(`${readmeRel}: map row ${ac} is not an acceptance criterion of ${id}`);
        continue;
      }
      for (const num of listed) {
        const tc = tcs.find((t) => t.num === num);
        if (!tc) seen.add(`${readmeRel}: map row ${ac} names ${num}, which has no file in ${rel}`);
        else if (!tc.covers.includes(ac)) seen.add(`${readmeRel}: map row ${ac} lists ${num}, which does not list ${ac} in covers`);
      }
    }
    out.push(...seen);
  }

  for (const t of tcs) {
    const note = legacyTcNote(t.text);
    for (const p of [...tcProblems({ fileName: t.fileName, folder, text: t.text, acIds }), ...(note ? [note] : [])]) out.push(`${rel}/${t.fileName}: ${p}`);
  }
  return out;
}
