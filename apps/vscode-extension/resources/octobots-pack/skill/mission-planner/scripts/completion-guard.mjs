// The mission done guard (pack v65): the record parser and the checks that set-status.js,
// gate-checks.mjs, gate-record.mjs, validate.js and doctor.js share. A pure module: nothing runs on
// import. It reads entities only through entity-io.mjs and test cases only through tc-io.mjs.
//
// Records live in a mission's `notes`. A record starts at a column-0 heading
// `## <heading> (<ISO-8601 UTC>)` and ends at the next column-0 `## ` line or the end of the notes.
// Among several records under one heading, the latest timestamp wins; on a tie, the lower one wins.
// A record is current when its Commit exists and the working tree matches it outside the board
// (`git diff --quiet <commit> -- . ':(exclude,literal)<board>'`). Any git error means not current.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { childDirs, mapBoardStatus, readEntity, resolveEntityFile } from "./entity-io.mjs";
import { missionToken, parseFrontmatter, readTestsText } from "./tc-io.mjs";

export const HEADINGS = { gate: "Gate checks", completion: "Completion gate", override: "Completion gate overridden" };

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMIT_RE = /^[0-9a-f]{40}$/;
const LEGACY_GREEN_RE = /^## Completion gate \([^)\n]*\):[ \t]*GREEN/m;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every record under `heading`, in notes order: `{ at, fields, lines }`. */
function recordsOf(notes, heading) {
  const head = new RegExp(`^## ${escapeRe(heading)} \\((\\d{4}-\\d{2}-\\d{2}T[\\d:]+Z)\\)[ \\t]*$`);
  const out = [];
  let cur = null;
  for (const line of String(notes ?? "").split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const m = head.exec(line);
      cur = m ? { at: m[1], fields: {}, lines: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    const text = line.trimEnd();
    cur.lines.push(text);
    const f = /^([A-Za-z]+):[ \t]?(.*)$/.exec(text);
    if (f) {
      const key = f[1].toLowerCase();
      if (!(key in cur.fields)) cur.fields[key] = f[2].trim();
    }
  }
  return out;
}

const timeOf = (at) => {
  const t = Date.parse(at);
  return Number.isNaN(t) ? -Infinity : t;
};

/** The latest record under `heading`, or null. Field keys are the lowercased line keys. */
export function latestRecord(notes, heading) {
  let best = null;
  for (const r of recordsOf(notes, heading)) {
    if (!best || timeOf(r.at) >= timeOf(best.at)) best = r;
  }
  return best;
}

/** True when the notes hold a `## Completion gate overridden (<ISO>)` record. */
export function hasOverride(notes) {
  return recordsOf(notes, HEADINGS.override).length > 0;
}

// ── git ──────────────────────────────────────────────────────────────────────────

const gitOut = (repoRoot, args) =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const real = (p) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** The toplevel of the git repository holding `dir`, or null. */
export function repoRootOf(dir) {
  try {
    const top = gitOut(dir, ["rev-parse", "--show-toplevel"]).trim();
    return top || null;
  } catch {
    return null;
  }
}

/**
 * The board folder, relative to `repoRoot`, `/`-separated: the nearest ancestor of `missionDir` named
 * `.octobots`, else (a board made with `add-campaign.js --root <dir>`) the folder the mission path's
 * shape names, since a mission lives at `<board>/campaigns/<campaign>/missions/<mission>`.
 */
export function boardRelPath(repoRoot, missionDir) {
  const start = real(missionDir);
  let d = start;
  while (basename(d) !== ".octobots") {
    const up = dirname(d);
    if (up === d) {
      d = resolve(start, "..", "..", "..", "..");
      break;
    }
    d = up;
  }
  return relative(real(repoRoot), d).split(sep).join("/") || ".";
}

// `literal`: a board folder whose name holds `*`, `?` or `[` must exclude only itself.
const boardPathspec = (repoRoot, missionDir) => `:(exclude,literal)${boardRelPath(repoRoot, missionDir)}`;

/** The tracked changes outside the board, as `git status --porcelain` lines. Throws on a git error. */
export function trackedChanges(repoRoot, missionDir) {
  const out = gitOut(repoRoot, ["status", "--porcelain", "--untracked-files=no", "--", ".", boardPathspec(repoRoot, missionDir)]);
  return out.split("\n").filter((l) => l.trim() !== "");
}

/** True when `commit` exists and the working tree outside the board matches it. */
export function isCurrent(repoRoot, commit, missionDir) {
  if (!COMMIT_RE.test(String(commit ?? ""))) return false;
  try {
    gitOut(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]);
    gitOut(repoRoot, ["diff", "--quiet", commit, "--", ".", boardPathspec(repoRoot, missionDir)]);
    return true;
  } catch {
    return false;
  }
}

/** The full HEAD commit of `repoRoot`. Throws on a git error. */
export function headCommit(repoRoot) {
  return gitOut(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/** The workspace's installed mission-planner scripts when they hold gate-checks.mjs, else this module's folder. */
export function scriptsDir(repoRoot) {
  if (repoRoot) {
    const installed = join(repoRoot, ".claude", "skills", "mission-planner", "scripts");
    if (existsSync(join(installed, "gate-checks.mjs"))) return installed;
  }
  return HERE;
}

// ── the checks ───────────────────────────────────────────────────────────────────

const quote = (p) => (/[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p);
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The tasks (yaml only) whose status is neither done nor cancelled, as `"<name>" (<status>)`. */
function unfinishedTasks(missionDir) {
  const out = [];
  const tasksDir = join(missionDir, "tasks");
  for (const slug of childDirs(tasksDir).sort()) {
    const res = resolveEntityFile(join(tasksDir, slug), ["task"]);
    if (!res || res.format !== "yaml") continue; // a legacy task.md keeps its status on the parent's board line
    let name = slug;
    let status;
    try {
      const t = readEntity(res.file, res.format);
      name = t.name || slug;
      status = t.status;
    } catch {
      out.push(`"${slug}" (unreadable task.yaml)`);
      continue;
    }
    const mapped = mapBoardStatus(status ?? "");
    if (mapped !== "done" && mapped !== "cancelled") out.push(`"${name}" (${status ?? "no status"})`);
  }
  return out;
}

/** The TC files of the mission's tests folder whose frontmatter status is not `pass`, as `<file> (<status>)`. */
function unpassedTests(campaignDir, name) {
  const token = missionToken(name);
  if (!token) return [];
  const dir = join(campaignDir, "tests", token.folder);
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const file of entries.filter((e) => /^TC-.*\.md$/.test(e)).sort()) {
    if (!isFile(join(dir, file))) continue;
    const fm = parseFrontmatter(readTestsText(join(dir, file)) ?? "");
    const status = fm.ok && typeof fm.data.status === "string" ? fm.data.status : "no status";
    if (status !== "pass") out.push(`${file} (${status})`);
  }
  return out;
}

/** Why a record is not current: uncommitted tracked changes outside the board, or a commit since. */
function staleReason(repoRoot, missionDir) {
  let dirty = false;
  try { dirty = trackedChanges(repoRoot, missionDir).length > 0; } catch { /* a git error: say the code changed */ }
  return dirty
    ? "there are uncommitted tracked changes outside the board (commit the mission's own changes; set aside any that are not the mission's)"
    : "the code changed since its commit";
}

/** Why the latest Gate checks record does not allow done, or null when it does. */
function gateChecksIssue(notes, repoRoot, missionDir) {
  const r = latestRecord(notes, HEADINGS.gate);
  if (!r) return "no Gate checks record in the mission notes";
  if (r.fields.verdict !== "green") return `the latest Gate checks record (${r.at}) is ${r.fields.verdict || "missing its Verdict"}, not green`;
  if (!isCurrent(repoRoot, r.fields.commit, missionDir)) {
    return `the latest Gate checks record (${r.at}) is not current: ${staleReason(repoRoot, missionDir)}`;
  }
  return null;
}

/** Why the latest Completion gate record does not allow done, or null when it does. */
function completionIssue(notes, repoRoot, missionDir, criteriaCount) {
  const r = latestRecord(notes, HEADINGS.completion);
  if (!r) return "no Completion gate record in the mission notes";
  if (r.fields.verdict === "pending-human") return "a human must check: move the mission to awaiting approval";
  const issues = [];
  if (r.fields.verdict !== "green") issues.push(`its Verdict is ${r.fields.verdict || "missing"}, not green`);
  const qa = /^(\d+)\s*\/\s*(\d+)\b/.exec(r.fields.qa ?? "");
  if (!qa) issues.push("it has no QA: <n>/<m> line");
  else if (Number(qa[1]) !== criteriaCount || Number(qa[2]) !== criteriaCount) {
    issues.push(`its QA line reads ${qa[1]}/${qa[2]}, but the mission has ${criteriaCount} acceptance criteria`);
  }
  const review = /^stillOpen=(\d+)$/.exec(r.fields.review ?? "");
  if (!review) issues.push("it has no Review: stillOpen=<k> line");
  else if (Number(review[1]) !== 0) issues.push(`its Review line reads stillOpen=${review[1]}`);
  if (!isCurrent(repoRoot, r.fields.commit, missionDir)) issues.push(`it is not current: ${staleReason(repoRoot, missionDir)}`);
  return issues.length ? `the latest Completion gate record (${r.at}): ${issues.join("; ")}` : null;
}

/**
 * Why `missionDir` may not be set done: `[{ check, message, next? }]`, empty when done is allowed.
 * `fields` are the mission's entity fields (readEntity). All checks are evaluated and reported
 * together; outside git, the two record checks are replaced by one `git` problem.
 */
export function doneProblems({ missionDir, fields, campaignDir = join(missionDir, "..", "..") }) {
  const problems = [];
  const repoRoot = repoRootOf(missionDir);
  const scripts = scriptsDir(repoRoot);
  const md = quote(missionDir);
  const notes = fields.notes ?? "";
  const criteria = Array.isArray(fields.acceptanceCriteria) ? fields.acceptanceCriteria : [];

  const tasks = unfinishedTasks(missionDir);
  if (tasks.length) {
    problems.push({
      check: "tasks",
      message: `${tasks.length} task(s) not done or cancelled: ${tasks.join(", ")}`,
      next: `finish each task, then node ${quote(join(scripts, "set-status.js"))} ${md} "<task title>" done (or cancelled)`,
    });
  }

  const unticked = criteria.filter((c) => !c.done).length;
  if (unticked) {
    problems.push({
      check: "criteria",
      message: `${unticked} of ${criteria.length} acceptance criteria not ticked`,
      next: `after QA verifies each one, tick it with node ${quote(join(scripts, "set-criterion.js"))} ${md} check <n>`,
    });
  }

  const tests = unpassedTests(campaignDir, fields.name);
  if (tests.length) {
    problems.push({
      check: "tests",
      message: `${tests.length} test case(s) not passed: ${tests.join(", ")}`,
      next: `run them, then record each with node ${quote(join(scripts, "set-test-status.js"))} <tc-file> pass`,
    });
  }

  if (!repoRoot) {
    problems.push({ check: "git", message: "not a git repository: the guard cannot check the records; use --force=<reason>" });
    return problems;
  }

  const gate = gateChecksIssue(notes, repoRoot, missionDir);
  if (gate) {
    problems.push({ check: "gate-checks", message: gate, next: `node ${quote(join(scripts, "gate-checks.mjs"))} ${md}` });
  }

  const completion = completionIssue(notes, repoRoot, missionDir, criteria.length);
  if (completion) {
    problems.push({
      check: "completion-gate",
      message: completion,
      next: `run the mission-completion-gate skill (phases 2-3), then node ${quote(join(scripts, "gate-record.mjs"))} ${md} --verdict <green|red|pending-human> --qa <n>/<m> --still-open <k>`,
    });
  }
  return problems;
}

/**
 * A warning for a done mission whose notes hold no green Completion gate record (any age), no
 * legacy `## Completion gate (…): GREEN` heading and no override; else null. Presence only.
 */
export function atRestWarning(fields) {
  if (mapBoardStatus(fields?.status ?? "") !== "done") return null;
  const notes = fields.notes ?? "";
  if (recordsOf(notes, HEADINGS.completion).some((r) => r.fields.verdict === "green")) return null;
  if (LEGACY_GREEN_RE.test(notes) || hasOverride(notes)) return null;
  return `mission "${fields.name ?? ""}" is done but has no green Completion gate record; run the mission-completion-gate skill, or record why with set-status.js --force=<reason>`;
}
