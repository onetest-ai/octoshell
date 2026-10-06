// Test-case (TC) files and a mission's functional-test folder, as the board sees them.
//
// A TC is `<campaign>/tests/m<n>/TC-NNN_<slug>.md`: YAML frontmatter between the first two `---` lines,
// then a markdown body. This module splits, parses and serializes that frontmatter (the body is carried
// byte-for-byte), holds the field checks of the TC format contract (M4 mission notes § TC format
// contract), and the pairing rule validate.js reports: a mission's tests README exists and is linked, every
// acceptance criterion is covered by some TC, and the README's AC map agrees with the TC frontmatter.
//
// Every finding is a WARNING and a plain string: `<path relative to the board root>: <what is wrong>`,
// `/`-separated. validate.js prints each as `warning: <string>`.
//
// DUAL IMPLEMENTATION: packages/board/src/tc-io.ts is the TypeScript spelling of this file (the pack
// script stays dependency-free, so it cannot import that). Text and rules must stay equal;
// packages/board/test/validate-tests-parity.test.ts runs both over real boards. Keep the two in step.
// set-test-status.js (M6) builds on this module.

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "./vendor/js-yaml.mjs";
import { mapBoardStatus } from "./entity-io.mjs";
import { readRegularFile } from "./pending-io.mjs";

export const TC_KINDS = ["api", "ui", "cli", "unit"];
export const TC_STATUSES = ["draft", "ready", "pass", "fail", "blocked", "unknown"];
export const TC_ID_RE = /^TC-\d{3,}$/;
export const MISSION_ID_RE = /^M\d+[a-z]*$/;
export const AC_ID_RE = /^M\d+[a-z]*-AC\d+$/;
export const REQUIRED_SECTIONS = ["Steps", "Expected Final State"];
/** The most a TC file or a tests README may hold (4 MiB); a larger one is read as unreadable. */
export const MAX_TC_BYTES = 4194304;

// ── frontmatter ──────────────────────────────────────────────────────────────────

/** The line starting at `pos`: its text (no line ending) and the offset just after its `\n`. */
function lineAt(text, pos) {
  const i = text.indexOf("\n", pos);
  return i < 0 ? { line: text.slice(pos), end: text.length } : { line: text.slice(pos, i), end: i + 1 };
}

/**
 * Split `text` into its frontmatter block and body: the block is the first `---` line (a BOM may
 * precede it) up to the next `---` line. `head + yaml + tail + body === text` always, so a rewrite that
 * touches only `yaml` leaves every other byte alone. Null when there is no complete block.
 */
export function splitFrontmatter(text) {
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
 * Parse a TC file's frontmatter. `{ ok: true, data, body }`, or `{ ok: false, body }` when there is no
 * block, the YAML does not parse, or it is not a mapping. `body` is everything after the block (the whole
 * text when there is none).
 */
export function parseFrontmatter(text) {
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, body: text };
  let data;
  try {
    // A block holding nothing but blanks and comments is an empty mapping (the loader rejects empty input).
    data = /\S/.test(parts.yaml.replace(/^\s*#.*$/gm, "")) ? yamlLoad(parts.yaml) ?? {} : {};
  } catch {
    return { ok: false, body: parts.body };
  }
  if (typeof data !== "object" || Array.isArray(data)) return { ok: false, body: parts.body };
  return { ok: true, data, body: parts.body };
}

/** Frontmatter block + body for `data`; the inverse of `parseFrontmatter` (key order is kept). */
export function serializeFrontmatter(data, body) {
  return `---\n${yamlDump(data, { lineWidth: -1, noRefs: true })}---\n${body}`;
}

/**
 * `text` with its frontmatter replaced by `update(data)` (it may mutate `data` and return nothing, or
 * return a new object). The opening and closing `---` lines and the body are kept byte-for-byte. Throws
 * when the frontmatter is missing or unparseable: nothing is guessed.
 */
export function rewriteFrontmatter(text, update) {
  const parts = splitFrontmatter(text);
  const parsed = parseFrontmatter(text);
  if (!parts || !parsed.ok) throw new Error("frontmatter is missing or unparseable");
  const next = update(parsed.data) ?? parsed.data;
  return parts.head + yamlDump(next, { lineWidth: -1, noRefs: true }) + parts.tail + parts.body;
}

// ── TC file checks ───────────────────────────────────────────────────────────────

/** The acceptance-criterion ids a TC lists: `covers`, else the legacy `requirements`. Null when neither is a list. */
export function coversOf(data) {
  const raw = data.covers ?? data.requirements;
  return Array.isArray(raw) ? raw : null;
}

/**
 * A legacy TC: its frontmatter parses but carries none of `status`, `kind` or `mission` (the fields the TC
 * format contract added; solo's uwb campaign predates them). It still lists, as status `unknown`; the
 * migrate suggestion is the one line `legacyMessage`. Twin of tc-io.ts.
 */
export function isLegacyTc(data) {
  return [data.status, data.kind, data.mission].every((v) => v === undefined || v === null);
}

/** The one-line suggestion for a legacy TC; the command is the one set-test-status.js (M6 T6.2) takes. */
export const LEGACY_TC_MESSAGE = "legacy test case (no status, kind or mission) lists as unknown: run set-test-status.js <tc-file> --migrate";

/**
 * The migrate suggestion for the TC file `text` (a warning line, after the path), or null: set when the file is
 * a legacy one (frontmatter parses, no status/kind/mission). Kept apart from `tcProblems`, which is the format
 * contract M4 defined; callers add it after the problems of the same file.
 */
export function legacyTcNote(text) {
  const fm = parseFrontmatter(text);
  return fm.ok && isLegacyTc(fm.data) ? LEGACY_TC_MESSAGE : null;
}

const show = (v) => JSON.stringify(v);

/** "M3b" for the folder token "m3b". */
export const missionIdOfFolder = (folder) => `M${folder.slice(1)}`;

/**
 * Contract violations of one TC file, as messages (no path). `folder` is the `m<n>` folder token;
 * `acIds` the ids of the mission's acceptance criteria (null when the mission is not known: then only the
 * mission prefix is checked). Extra keys never warn; an absent `mission`, `kind` or `status` is fine.
 */
export function tcProblems({ fileName, folder, text, acIds }) {
  const out = [];
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

    for (const [key, allowed] of [["kind", TC_KINDS], ["status", TC_STATUSES]]) {
      const v = d[key];
      if (v !== undefined && v !== null && !allowed.includes(v)) out.push(`${key} ${show(v)} is not one of ${allowed.join(", ")}`);
    }

  }
  for (const heading of REQUIRED_SECTIONS) {
    if (!new RegExp(`^## ${heading}[ \\t]*$`, "m").test(fm.body)) out.push(`missing the "## ${heading}" section`);
  }
  return out;
}

// ── README AC map ────────────────────────────────────────────────────────────────

/**
 * The rows of a tests README's AC map: every markdown table row whose first cell names acceptance
 * criteria (`M1-AC3`), with the TC ids found in its last cell. The header, the separator and any other
 * table are skipped, so the map is found wherever the README puts it.
 */
export function parseReadmeMap(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
    const acs = cells[0].match(/\bM\d+[a-z]*-AC\d+\b/g);
    if (!acs) continue;
    const tcs = cells.length > 1 ? [...new Set(cells[cells.length - 1].match(/\bTC-\d{3,}\b/g) ?? [])] : [];
    for (const ac of new Set(acs)) rows.push({ ac, tcs });
  }
  return rows;
}

// ── a mission's tests folder ─────────────────────────────────────────────────────

const posix = (p) => p.split(sep).join("/");
/**
 * The text of a TC or README, or null. Only a regular file of at most MAX_TC_BYTES is read, opened
 * non-blocking: tests/ is written by QA and by hand, and a FIFO or a symlink to /dev/zero named
 * README.md would otherwise block the reader forever (validateBoard runs in the extension host).
 */
export const readTestsText = (p) => { try { return readRegularFile(p, { max: MAX_TC_BYTES }); } catch { return null; } };
const readTextOrNull = readTestsText;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** `{ id: "M3b", folder: "m3b" }` from a mission name starting with its id token, else null. */
export function missionToken(name) {
  const m = /^(M\d+[a-z]*)\b/i.exec(String(name ?? "").trim());
  return m ? { id: `M${m[1].slice(1).toLowerCase()}`, folder: m[1].toLowerCase() } : null;
}

/** The ids `<mission>-AC1..ACn` of a mission with `n` acceptance criteria. */
export const acIdsOf = (id, n) => new Set(Array.from({ length: n }, (_, i) => `${id}-AC${i + 1}`));

/**
 * Pairing findings for one mission of the campaign at `campaignDir`, as `<rel>: <message>` strings with
 * `rel` relative to `base` (the board root). `mission` is `{ name, status, acceptanceCriteria, documents }`.
 * Nothing for a cancelled mission, or one whose name carries no `M<n>` token. A mission with no
 * `tests/m<n>/` folder gets the one missing-README finding; with a folder, the README link, the AC
 * coverage, the README map and every TC file are checked. Reads one directory and its TC/README files.
 */
export function missionTestsFindings({ campaignDir, campaign, base, mission }) {
  if (mapBoardStatus(mission.status ?? "") === "cancelled") return [];
  const token = missionToken(mission.name);
  if (!token) return [];
  const { id, folder } = token;
  const dir = join(campaignDir, "tests", folder);
  const rel = posix(relative(base, dir));
  const readmeRel = `${rel}/README.md`;
  const out = [];

  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { entries = null; }
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
    const covers = fm.ok ? coversOf(fm.data) ?? [] : [];
    return { fileName, text, num: fileName.replace(/\.md$/, "").split("_")[0], covers };
  });

  // A folder holding neither a README nor a TC (runs/ and evidence/ only) is one finding, not one per criterion.
  if (readme === null && tcs.length === 0) return out;
  const covered = new Set(tcs.flatMap((t) => t.covers));
  for (const ac of acIds) if (!covered.has(ac)) out.push(`${rel}: ${ac} is not covered by any test case`);

  if (readme !== null) {
    const seen = new Set();
    for (const { ac, tcs: listed } of parseReadmeMap(readme)) {
      if (!acIds.has(ac)) { seen.add(`${readmeRel}: map row ${ac} is not an acceptance criterion of ${id}`); continue; }
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
