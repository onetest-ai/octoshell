#!/usr/bin/env node
// Tokenomics rollup — Stage 2 (join + price + shape to the submission schema).
//
// Reads `raw/segments.jsonl` (Stage 1) and joins it to:
//   * the Octobots board  — mission identity, tracker ref, authored sizing fields
//   * git                 — net_loc / files_changed vs the merge-base
//   * gh (best effort)    — PR-open timestamp, which splits build vs iterate cost
//
// Emits `runs.json`: one row per MISSION (our work_item_level is `story`; a
// mission is the unit that ships behind one PR and carries its own acceptance
// criteria), plus the once-per-submission segment header.
//
// Costs are recomputed from raw tokens under the cached LiteLLM price table
// (`prices.json`) on every run — the
// token counts are canonical, the dollars are derived and disposable.
//
// Usage: node .octobots/tokenomics/rollup.mjs [--project-dir DIR] [--no-gh] [--quiet]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const useGh = !args.includes("--no-gh");
const log = (...a) => { if (!quiet) console.error(...a); };

const pdIdx = args.indexOf("--project-dir");
const PROJECT_DIR = pdIdx !== -1 ? args[pdIdx + 1] : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const TOK_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");
const CAMPAIGNS_DIR = join(PROJECT_DIR, ".octobots", "campaigns");

// Board entities are `<kind>.yaml` since the md->yaml migration; a board not yet
// migrated still carries `<kind>.md`. BOTH are read, YAML first.
//
// Reading only Markdown against a migrated board does not fail — it finds zero
// missions and reports every dollar as unattributed, which is what this file did
// for the whole board after the migration. Hence the dual read AND the loud
// guard in loadBoard(): a rollup that cannot see the board must say so.
let yamlLoad = null;
for (const spec of [
  pathToFileURL(join(PROJECT_DIR, ".claude", "skills", "mission-planner", "scripts", "vendor", "js-yaml.mjs")).href,
  "js-yaml",
]) {
  try {
    const mod = await import(spec);
    yamlLoad = mod.load ?? mod.default?.load ?? null;
    if (yamlLoad) break;
  } catch {
    // Try the next candidate; absence is reported by loadBoard(), not here.
  }
}

const TOKEN_KEYS = [
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "cache_creation_5m_tokens", "cache_creation_1h_tokens",
];
// Our token counters -> LiteLLM's cost fields. Costs upstream are USD PER
// TOKEN, so these multiply directly with no scaling.
//
// `cache_creation_input_tokens` is the TTL-agnostic total and is deliberately
// NOT priced — the 5m/1h split covers the same tokens at their real rates, so
// pricing both would double-count every cache write.
const PRICE_FIELDS = {
  input_tokens: "input_cost_per_token",
  output_tokens: "output_cost_per_token",
  cache_read_input_tokens: "cache_read_input_token_cost",
  cache_creation_5m_tokens: "cache_creation_input_token_cost",
  cache_creation_1h_tokens: "cache_creation_input_token_cost_above_1hr",
};

const pricing = JSON.parse(readFileSync(join(TOK_DIR, "prices.json"), "utf8"));
const unpriced = new Set();

function priceOf(model) {
  // Tolerate variant suffixes like `claude-opus-4-8[1m]` and dated ids.
  const base = model.replace(/\[.*$/, "");
  const entry = pricing.models[base] ?? pricing.models[base.replace(/-\d{8}$/, "")];
  if (!entry) unpriced.add(model);
  return entry ?? {};
}

// Rate for one cost field, with documented fallbacks when upstream omits it:
// cache reads bill at 0.1x input, 5-minute writes at 1.25x, 1-hour at 2x.
function rate(entry, field) {
  if (entry[field] != null) return entry[field];
  const input = entry.input_cost_per_token ?? 0;
  switch (field) {
    case "cache_read_input_token_cost": return input * 0.1;
    case "cache_creation_input_token_cost": return input * 1.25;
    // Some upstream entries omit the 1h rate (and a few legacy ones report it
    // below the 5m rate, which cannot be right) — fall back to the documented
    // 2x rather than trusting a value we know is wrong.
    case "cache_creation_input_token_cost_above_1hr":
      return Math.max(input * 2, entry.cache_creation_input_token_cost ?? 0);
    default: return 0;
  }
}

function costOf(byModel) {
  let usd = 0;
  for (const [model, tok] of Object.entries(byModel)) {
    const entry = priceOf(model);
    for (const [k, field] of Object.entries(PRICE_FIELDS)) usd += (tok[k] ?? 0) * rate(entry, field);
  }
  return usd;
}

function cacheReadCost(byModel) {
  let usd = 0;
  for (const [model, tok] of Object.entries(byModel)) {
    usd += (tok.cache_read_input_tokens ?? 0) * rate(priceOf(model), "cache_read_input_token_cost");
  }
  return usd;
}

function git(...a) {
  try {
    return execFileSync("git", a, { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board: discover campaigns/missions and how branches map onto them.
//
// Branch names already encode the work (`feat/edgeserver-auth-t4`,
// `feat/edge-ops-ui-m9-t3`), so mapping is derivable with no new instrumentation
// — but a mission may also declare its branches explicitly, which always wins.
// ---------------------------------------------------------------------------
// A `## Tokenomics` block on any board file:
//   effort_days: 3
//   size_tshirt: M
//   complexity_score: 18
function parseTokenomicsBlock(text, END) {
  const out = {};
  const block = text.match(new RegExp(`^##\\s+Tokenomics\\s*\\n([\\s\\S]*?)${END}`, "m"))?.[1];
  if (!block) return out;
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*[-*]?\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// An authored map — YAML `tokenomics:` or a legacy `## Tokenomics` block — folded
// to flat lowercase strings. Every downstream consumer already coerces with
// `Number(...)`, `?? null` or `=== "true"`, so normalising HERE lets both board
// formats flow through the row builders unchanged. A YAML list (`branches: [a, b]`)
// re-joins to the comma string `declaredBranches` splits.
function normaliseAuthored(map) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  for (const [k, v] of Object.entries(map)) {
    if (v === null || v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function readYamlEntity(file) {
  if (!existsSync(file) || !yamlLoad) return null;
  try {
    const doc = yamlLoad(readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? doc : {};
  } catch (e) {
    log(`tokenomics: WARN could not parse ${file}: ${e.message}`);
    return null;
  }
}

// `M1 - Name` / `T2.3 - Name`. The `<id> - <name>` title is a board contract, and
// on a YAML entity the id lives nowhere else — the folder slug is only a fallback.
function splitTitle(title, fallbackId) {
  const m = /^\s*([MT]\d+(?:\.\d+)?)\s*[-–—:]\s*(.+)$/.exec(String(title ?? ""));
  if (m) return { id: m[1], name: m[2].trim() };
  return { id: fallbackId, name: String(title ?? "").trim() || fallbackId };
}

function taskIdFromSlug(dir) {
  const m = dir.match(/^t(\d+)-(\d+)/i);
  return m ? `T${m[1]}.${m[2]}` : null;
}

// Per-task estimates live in each `tasks/<slug>/task.yaml` (`tokenomics:`), or in
// the planner-owned `## Tokenomics` block of a legacy `task.md`. Estimating at
// PLANNING time is the point: effort is the rubric's sizing key and cannot be
// recovered afterwards.
//
// On a YAML board the task LIST is folder-derived too — a parent never projects
// its children — so this returns both the tasks and their estimates.
function loadTasks(missionPath, END) {
  const est = new Map();
  const tasks = [];
  const tasksDir = join(missionPath, "tasks");
  if (!existsSync(tasksDir)) return { tasks, est };

  for (const dir of readdirSync(tasksDir)) {
    const slugId = taskIdFromSlug(dir);
    const y = readYamlEntity(join(tasksDir, dir, "task.yaml"));
    if (y) {
      const { id, name } = splitTitle(y.name, slugId);
      if (!id) continue;
      tasks.push({
        id, name,
        role: y.role ?? null,
        status: y.status ?? null,
        num: Number(id.split(".")[1]),
      });
      const a = normaliseAuthored(y.tokenomics);
      if (Object.keys(a).length) est.set(id, a);
      continue;
    }
    // Legacy: the task list comes from the mission's `## Tasks` section, so only
    // the estimate is harvested here.
    const f = join(tasksDir, dir, "task.md");
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const id = text.match(/^#\s+(T\d+\.\d+)\b/m)?.[1] ?? slugId;
    if (!id) continue;
    const a = normaliseAuthored(parseTokenomicsBlock(text, END));
    if (Object.keys(a).length) est.set(id, a);
  }
  return { tasks, est };
}

function parseMissionYaml(campaignSlug, missionDir, missionPath, doc) {
  const { id, name } = splitTitle(doc.name, missionDir.match(/^m(\d+)/i) ? `M${missionDir.match(/^m(\d+)/i)[1]}` : missionDir);

  const desc = String(doc.description ?? "");
  const brief = desc.trim().replace(/\s+/g, " ").slice(0, 400);
  const tracker = `${desc}\n${doc.notes ?? ""}`.match(/Tracker:\s*(\S+#\d+)/)?.[1] ?? null;

  const criteria = Array.isArray(doc.acceptance_criteria) ? doc.acceptance_criteria : [];
  const authored = normaliseAuthored(doc.tokenomics);
  const { tasks, est: taskEstimates } = loadTasks(missionPath, null);

  return {
    id, name, campaign: campaignSlug, dir: missionDir, brief, tracker, tasks, taskEstimates,
    criteria_total: criteria.length,
    criteria_done: criteria.filter((c) => c && c.done === true).length,
    authored,
    declaredBranches: (authored.branches ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    missionNum: Number(String(id).replace(/\D/g, "")),
  };
}

function parseMission(campaignSlug, missionDir, missionPath) {
  const path = join(missionPath, "mission.md");
  const text = readFileSync(path, "utf8");
  const titleMatch = text.match(/^#\s+(M\d+)\s*[-–]\s*(.+)$/m);
  const id = titleMatch?.[1] ?? (missionDir.match(/^m(\d+)/i) ? `M${missionDir.match(/^m(\d+)/i)[1]}` : missionDir);
  const name = titleMatch?.[2]?.trim() ?? missionDir;

  // Description = the `## Description` body, collapsed to a brief.
  // NOTE: the terminating `$` must be end-of-INPUT, not end-of-line — under the
  // `/m` flag needed for `^##`, a bare `$` makes the lazy body match stop at the
  // first newline and silently truncate the block to one line.
  const END = "(?=\\n##\\s|\\n<!--|$(?![\\s\\S]))";
  const desc = text.match(new RegExp(`^##\\s+Description\\s*\\n([\\s\\S]*?)${END}`, "m"))?.[1] ?? "";
  const brief = desc.trim().replace(/\s+/g, " ").slice(0, 400);

  const criteria = [...text.matchAll(/^-\s+\[( |x)\]\s+(.+)$/gm)].map((m) => ({ done: m[1] === "x", text: m[2] }));
  const tracker = text.match(/Tracker:\s*(\S+#\d+)/)?.[1] ?? null;

  // Authored (non-derivable) fields live in an optional `## Tokenomics` block:
  //   effort_days: 3
  //   complexity_score: 18
  //   self_size: M
  //   maturity: production
  //   branches: feat/a, feat/b
  const authored = normaliseAuthored(parseTokenomicsBlock(text, END));
  const { est: taskEstimates } = loadTasks(missionPath, END);

  const declaredBranches = (authored.branches ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // The agent-owned `## Tasks` section, e.g.
  //   - [role:python-dev] [status:done] T11.3 - Port OIDC IdP (Authlib): …
  // Role and status are optional and may appear in either order.
  const tasks = [];
  // NOTE: terminate only on the next `## ` heading — NOT on `<!--`. The Tasks
  // section routinely carries inline HTML comments (e.g. "T11.2 moved to
  // another campaign"), and stopping at the first one silently truncates the
  // list to whatever preceded it.
  const TASKS_END = "(?=\\n##\\s|$(?![\\s\\S]))";
  const tasksBlock = text.match(new RegExp(`^##\\s+Tasks\\s*\\n([\\s\\S]*?)${TASKS_END}`, "m"))?.[1] ?? "";
  for (const line of tasksBlock.split("\n")) {
    const m = line.match(/^\s*-\s*(.*?)(T\d+\.\d+)\s*[-–]\s*(.+?)\s*$/);
    if (!m) continue;
    const [, tags, id, name] = m;
    tasks.push({
      id,
      name,
      role: tags.match(/\[role:([^\]]+)\]/)?.[1] ?? null,
      status: tags.match(/\[status:([^\]]+)\]/)?.[1] ?? null,
      num: Number(id.split(".")[1]),
    });
  }

  return {
    id, name, campaign: campaignSlug, dir: missionDir, brief, tracker, tasks, taskEstimates,
    criteria_total: criteria.length,
    criteria_done: criteria.filter((c) => c.done).length,
    authored, declaredBranches,
    missionNum: Number(id.replace(/\D/g, "")),
  };
}

function loadBoard() {
  const missions = [];
  if (!existsSync(CAMPAIGNS_DIR)) return missions;

  let skippedYaml = 0;
  for (const campaign of readdirSync(CAMPAIGNS_DIR)) {
    const mdir = join(CAMPAIGNS_DIR, campaign, "missions");
    if (!existsSync(mdir)) continue;
    for (const m of readdirSync(mdir)) {
      const missionPath = join(mdir, m);
      const yamlPath = join(missionPath, "mission.yaml");
      if (existsSync(yamlPath)) {
        const doc = readYamlEntity(yamlPath);
        if (doc) missions.push(parseMissionYaml(campaign, m, missionPath, doc));
        else skippedYaml++;
        continue;
      }
      if (existsSync(join(missionPath, "mission.md"))) missions.push(parseMission(campaign, m, missionPath));
    }
  }

  // A board that exists but yields no missions means the join is broken, not that
  // there is no work — and every dollar would silently land in `unattributed`.
  // Say it out loud.
  if (skippedYaml) {
    log(
      `tokenomics: ERROR ${skippedYaml} mission.yaml file(s) could not be read` +
      (yamlLoad ? "" : " — no YAML parser found (install the Octobots pack, or `npm i js-yaml`)"),
    );
  }
  if (!missions.length && readdirSync(CAMPAIGNS_DIR).length) {
    log("tokenomics: ERROR the board has campaigns but no readable missions — every segment will report as unattributed");
  }
  return missions;
}

// Map a branch to a mission. Explicit declaration wins; otherwise match the
// longest campaign slug appearing in the branch, then disambiguate by an `m<n>`
// token — and if the campaign has exactly one mission, that one.
function mapBranch(branch, missions) {
  for (const m of missions) {
    if (m.declaredBranches.includes(branch)) return m;
  }
  const campaigns = [...new Set(missions.map((m) => m.campaign))]
    .filter((c) => branch.includes(c))
    .sort((a, b) => b.length - a.length);
  if (!campaigns.length) return null;

  const inCampaign = missions.filter((m) => m.campaign === campaigns[0]);
  const num = branch.match(/-m(\d+)\b/i)?.[1];
  if (num) return inCampaign.find((m) => m.missionNum === Number(num)) ?? null;
  return inCampaign.length === 1 ? inCampaign[0] : null;
}

// ---------------------------------------------------------------------------
// Diff signals — three-dot vs the merge-base, excluding generated/vendored.
// These are lane AUDIT signals only; sizing is Effort-anchored (rubric §3.3).
// ---------------------------------------------------------------------------
const EXCLUDE = /(^|\/)(package-lock\.json|yarn\.lock|poetry\.lock|uv\.lock)$|(^|\/)vendor\/|\.min\.|generated/i;

// Added and removed are tracked separately, not just their difference. `net_loc`
// alone hides the shape of the work: a 600-added/580-removed refactor and a
// 20-line feature both report net 20, and a deletion-heavy cleanup reports
// negative. The schema still carries `net_loc` (the rubric's lane signal), but
// `lines_added` / `lines_removed` are what make it readable.
// The branch a mission was actually cut from is NOT always `main`. A campaign
// that runs on a long-lived integration branch opens its mission PRs against
// THAT branch (see the campaign board's `## Branching`), so diffing such a
// branch against `main` sweeps in every previously-merged mission: M2 reports
// M1+M2, M3 reports M1+M2+M3, and the lane signal inflates cumulatively.
//
// That matters more than a cosmetic wrong number — `net_loc` is the rubric's
// lane-audit signal, so an inflated diff silently argues that every later
// mission was under-estimated. Observed on edgeserver-microplus/M2: reported
// +7321/-58 across 80 files, against an actual PR diff of +3349/-140 across 26.
//
// Resolve the real base per branch from its PR (`prsFor` already requests
// `baseRefName`), and fall back to `base` only when there is no PR to ask —
// offline, no `gh`, or a purely local branch.
function baseRefFor(branch, fallback) {
  const withBase = prsFor(branch).filter((p) => p.baseRefName);
  if (!withBase.length) return fallback;
  // Newest PR wins: a branch reopened against a different base (as happens when
  // a PR is retargeted) should be measured against where it actually landed.
  const newest = withBase.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return newest.baseRefName;
}

function diffStats(branches, base = "main") {
  let added = 0;
  let removed = 0;
  const files = new Set();
  let any = false;
  let resolved = 0;
  for (const branch of branches) {
    if (!git("rev-parse", "--verify", "--quiet", branch)) continue;
    const branchBase = baseRefFor(branch, base);
    // A branch already MERGED into its base has an empty standalone diff by
    // definition — merge-base(base, branch) is the branch tip itself, so
    // `mb...branch` is nothing. A stale local branch left behind after
    // `gh pr merge --delete-branch` (which only removes the remote) therefore
    // reports ~zero LoC and looks like a complete, healthy measurement.
    // Observed on edgeserver-microplus/M5: +1/-0 across 1 file, against a PR of
    // +4146/-450 across 34. Treat it as unresolved so the PR wins.
    const mergedInto =
      git("rev-parse", "--verify", "--quiet", `origin/${branchBase}`) ||
      git("rev-parse", "--verify", "--quiet", branchBase);
    if (mergedInto) {
      const tip = git("rev-parse", branch);
      const mbWithBase = git("merge-base", mergedInto, branch);
      if (tip && mbWithBase && tip === mbWithBase) continue; // fully merged
    }
    resolved += 1;
    // Prefer the remote-tracking ref: mission branches are routinely deleted
    // locally after merge, and `merge-base` against a missing local ref would
    // silently drop the branch from the totals entirely.
    const baseRev =
      git("rev-parse", "--verify", "--quiet", `origin/${branchBase}`) ? `origin/${branchBase}`
      : git("rev-parse", "--verify", "--quiet", branchBase) ? branchBase
      : base;
    const mb = git("merge-base", baseRev, branch) ?? git("merge-base", base, branch);
    if (!mb) continue;
    const numstat = git("diff", "--numstat", `${mb}...${branch}`);
    if (numstat === null) continue;
    any = true;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del, path] = line.split("\t");
      if (!path || EXCLUDE.test(path)) continue;
      files.add(path);
      // "-" marks a binary file: countable as changed, not as lines.
      if (add !== "-" && del !== "-") { added += Number(add); removed += Number(del); }
    }
  }
  // `resolved` matters as much as the numbers: mission branches are routinely
  // deleted on merge (`gh pr merge --delete-branch`), so a mission can have SOME
  // of its branches locally and produce a real-looking-but-partial diff. That
  // partial then pre-empted the PR fallback, which is authoritative. Observed on
  // edgeserver-microplus/M5: reported +1/-0 across 1 file against a PR of
  // +4146/-450 across 34.
  const complete = branches.length > 0 && resolved === branches.length;
  return any
    ? { lines_added: added, lines_removed: removed, net_loc: added - removed, files_changed: files.size, complete }
    : { lines_added: null, lines_removed: null, net_loc: null, files_changed: null, complete: false };
}

// PR lookup serves two fields at once: `createdAt` is the build/iterate
// boundary (rubric §4.4), and additions/deletions cover the common case where
// the mission branch was deleted after merge so no local diff exists.
// Best effort: offline, no `gh`, or no PR simply leaves these unreported.
const PR_CACHE = new Map();
function prsFor(branch) {
  if (PR_CACHE.has(branch)) return PR_CACHE.get(branch);
  let list = [];
  try {
    const out = execFileSync("gh", [
      "pr", "list", "--head", branch, "--state", "all", "--limit", "5",
      "--json", "number,createdAt,additions,deletions,changedFiles,baseRefName",
    ], { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
    list = JSON.parse(out);
  } catch { /* offline / no gh / no PR */ }
  PR_CACHE.set(branch, list);
  return list;
}

function prInfo(branches, base = "main") {
  if (!useGh) return null;
  const found = branches.flatMap(prsFor);
  if (!found.length) return null;

  // A mission spans several branches: task branches (whose PRs target the
  // MISSION branch) and the mission branch itself. Only the latter describes
  // the mission's whole diff — picking whichever PR happened to be found first
  // under-reports it to one task's worth of work, and summing them all would
  // double-count, since task PRs are already contained in the mission PR.
  //
  // Identify it structurally rather than by assuming it targets `main`: the
  // mission PR is the one pointing OUT of the mission, i.e. whose base is not
  // itself one of this mission's branches. That holds for a trunk-based mission
  // (base `main`) and equally for one on a campaign integration branch (base
  // `feat/<campaign>-integration`), where a `=== "main"` test matches nothing
  // and silently degrades to "largest diff wins".
  const own = new Set(branches);
  const outward = found.filter((p) => p.baseRefName && !own.has(p.baseRefName));
  const toBase = outward.length ? outward : found.filter((p) => p.baseRefName === base);
  const pool = toBase.length ? toBase : found;
  // Largest diff wins within the pool — the integration PR, not a follow-up fix.
  return pool.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))[0];
}

// ---------------------------------------------------------------------------
// Build the rows.
// ---------------------------------------------------------------------------
const rawFile = join(TOK_DIR, "raw", "segments.jsonl");
if (!existsSync(rawFile)) {
  console.error(`tokenomics: ${rawFile} missing — run collect.mjs first`);
  process.exit(1);
}
const segments = readFileSync(rawFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const missions = loadBoard();

const groups = new Map(); // mission key -> {mission, segments[]}
const unattributed = [];
for (const s of segments) {
  const m = mapBranch(s.branch, missions);
  if (!m) { unattributed.push(s); continue; }
  const key = `${m.campaign}/${m.id}`;
  if (!groups.has(key)) groups.set(key, { mission: m, segments: [] });
  groups.get(key).segments.push(s);
}

function sumTokens(segs) {
  const byModel = {};
  for (const s of segs) {
    for (const [model, tok] of Object.entries(s.tokens_by_model)) {
      const t = (byModel[model] ??= Object.fromEntries(TOKEN_KEYS.map((k) => [k, 0])));
      for (const k of TOKEN_KEYS) t[k] += tok[k] ?? 0;
    }
  }
  return byModel;
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Work log: session -> task, recorded by `.octobots/hooks/work-log.mjs` at the
// moment a task is flipped active/done. A recorded fact beats inferring a task
// from a branch name, so this is consulted first. Keyed both with and without
// the branch: the branch-qualified key wins when a session touched several
// tasks; the bare session key covers work whose branch changed mid-task.
// ---------------------------------------------------------------------------
const WORKLOG = new Map();
{
  const f = join(TOK_DIR, "worklog.jsonl");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e.session_id || !e.task) continue;
        if (e.branch) WORKLOG.set(`${e.session_id}|${e.branch}`, e.task.replace(/^T/, ""));
        WORKLOG.set(e.session_id, e.task.replace(/^T/, ""));
      } catch { /* skip corrupt line */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Task-level breakdown inside a mission.
//
// The same branch convention that maps work to a mission also maps it to a
// task: a trailing `-t<n>` names task T<missionNum>.<n>
// (`feat/edgeserver-auth-t4` -> T11.4, `feat/edge-ops-ui-m9-t3` -> T9.3).
// Branches with no `-t<n>` are mission-level work — planning, integration, the
// completion gate — and are bucketed separately rather than being forced onto
// an arbitrary task.
// ---------------------------------------------------------------------------
// Churn for one task's own branches. A task PR targets the MISSION branch, not
// main, so `base` filtering is not applied here — any PR for the branch is the
// task's PR.
//
// Task churn does NOT sum to the mission's. The mission PR is the merged result:
// rebases, squashes, conflict resolution, review fixes and integration commits
// all land there and belong to no single task, and a line written in one task and
// rewritten in another counts twice across tasks but once in the mission. Both
// numbers are correct at their own level; reconciling them would mean inventing
// an allocation. `_octobots.task_churn_reconciles: false` records this.
function taskDiff(branches) {
  if (!branches.length) return { lines_added: null, lines_removed: null, net_loc: null, files_changed: null, diff_source: null };
  const local = diffStats(branches);
  if (local.net_loc !== null) return { ...local, diff_source: "git-merge-base" };
  if (!useGh) return { ...local, diff_source: null };
  const prs = branches.flatMap(prsFor);
  if (!prs.length) return { ...local, diff_source: null };
  const pr = prs.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))[0];
  return {
    lines_added: pr.additions, lines_removed: pr.deletions,
    net_loc: pr.additions - pr.deletions, files_changed: pr.changedFiles,
    diff_source: `gh-pr#${pr.number}`,
  };
}

function taskBreakdown(mission, segs, missionCost) {
  const est = (key) => mission.taskEstimates.get(`T${key}`);
  const byTask = new Map();
  for (const s of segs) {
    // Recorded fact first (worklog), inference second. `attribution` records
    // which was used so the report can show how much is measured vs guessed.
    const logged = WORKLOG.get(`${s.session_id}|${s.branch}`) ?? WORKLOG.get(s.session_id);
    const num = logged
      ? logged.split(".")[1]
      : s.branch.match(/-t(\d+)(?:[-_.].*)?$/i)?.[1];
    const key = num ? `${mission.id.replace(/\D/g, "")}.${num}` : "(mission-level)";
    s._attribution = logged ? "worklog" : (num ? "branch-inference" : "mission-level");
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(s);
  }

  const rows = [];
  for (const [key, taskSegs] of byTask) {
    const declared = key === "(mission-level)" ? null : mission.tasks.find((t) => t.id === `T${key}`);
    const byModel = sumTokens(taskSegs);
    const cost = costOf(byModel);
    const subs = taskSegs.filter((s) => s.kind === "subagent");
    const orch = costOf(sumTokens(taskSegs.filter((s) => s.kind === "orchestrator")));
    const totals = TOKEN_KEYS.reduce((acc, k) => (acc[k] = Object.values(byModel).reduce((n, t) => n + (t[k] ?? 0), 0), acc), {});

    rows.push({
      // A branch can reference a task the board never declared (renamed, or
      // deleted after the work landed) — report the id rather than dropping it.
      id: key === "(mission-level)" ? null : `T${key}`,
      name: declared?.name ?? (key === "(mission-level)" ? "Mission-level work (planning, integration, gate)" : "(not on the board)"),
      role: declared?.role ?? null,
      status: declared?.status ?? null,
      size_tshirt: est(key)?.size_tshirt ?? null,
      effort_days: est(key)?.effort_days ? Number(est(key).effort_days) : null,
      complexity_score: est(key)?.complexity_score ? Number(est(key).complexity_score) : null,
      branches: [...new Set(taskSegs.map((s) => s.branch))].sort(),
      sessions: new Set(taskSegs.map((s) => s.session_id)).size,
      turns: taskSegs.reduce((n, s) => n + s.turns, 0),
      subagent_dispatches: subs.length,
      orchestrator_cost_pct: cost > 0 ? Math.round(100 * orch / cost) : 100,
      agent_types: [...new Set(subs.map((s) => s.agent_type).filter(Boolean))].sort(),
      attribution: [...new Set(taskSegs.map((s) => s._attribution))].sort().join("+"),
      // The mission-level bucket deliberately reports NO churn: its branch is
      // the mission branch, whose PR is the mission's own diff. Attributing that
      // here would restate the entire mission inside its own task list.
      ...(key === "(mission-level)"
        ? { lines_added: null, lines_removed: null, net_loc: null, files_changed: null, diff_source: null }
        : taskDiff([...new Set(taskSegs.map((s) => s.branch))].sort())),
      tokens: {
        input: totals.input_tokens,
        output: totals.output_tokens,
        cache_read: totals.cache_read_input_tokens,
        cache_create: totals.cache_creation_input_tokens,
      },
      cost_api_equivalent_usd: round2(cost),
      cost_share_pct: missionCost > 0 ? Math.round(100 * cost / missionCost) : 0,
    });
  }

  // Declared-but-unmeasured tasks still belong in the report: a task with no
  // branch of its own (done inline, or on a branch that didn't follow the
  // convention) reads as $0 rather than silently vanishing from the mission.
  for (const t of mission.tasks) {
    if (rows.some((r) => r.id === t.id)) continue;
    rows.push({
      id: t.id, name: t.name, role: t.role, status: t.status,
      size_tshirt: mission.taskEstimates.get(t.id)?.size_tshirt ?? null,
      effort_days: mission.taskEstimates.get(t.id)?.effort_days ? Number(mission.taskEstimates.get(t.id).effort_days) : null,
      complexity_score: null,
      branches: [], sessions: 0, turns: 0, subagent_dispatches: 0,
      orchestrator_cost_pct: 100, agent_types: [], attribution: null,
      lines_added: null, lines_removed: null, net_loc: null, files_changed: null, diff_source: null,
      tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
      cost_api_equivalent_usd: 0, cost_share_pct: 0, unmeasured: true,
    });
  }

  return rows.sort((a, b) => b.cost_api_equivalent_usd - a.cost_api_equivalent_usd);
}

function buildRow({ mission, segments: segs }) {
  const byModel = sumTokens(segs);
  const cost = costOf(byModel);
  const orchSegs = segs.filter((s) => s.kind === "orchestrator");
  const subSegs = segs.filter((s) => s.kind === "subagent");
  const orchCost = costOf(sumTokens(orchSegs));

  const branches = [...new Set(segs.map((s) => s.branch))];
  const pr = prInfo(branches);

  // Prefer the local merge-base diff; fall back to the PR's own stats once the
  // branch has been deleted post-merge.
  const local = diffStats(branches);
  let { lines_added, lines_removed, net_loc, files_changed } = local;
  let diff_source = net_loc === null ? null : "git-merge-base";
  // Trust the local diff only when every branch resolved. A partially-resolved
  // one under-reports silently, and the PR is the better witness once a branch
  // has been deleted on merge.
  if ((net_loc === null || !local.complete) && pr) {
    lines_added = pr.additions;
    lines_removed = pr.deletions;
    net_loc = pr.additions - pr.deletions;
    files_changed = pr.changedFiles;
    diff_source = `gh-pr#${pr.number}`;
  }

  // build vs iterate: partition segment cost by the PR-open instant. A segment
  // that straddles the boundary is assigned to the side holding PR-open
  // (rubric §4.4's stated fallback) — we do not split a segment.
  const prAt = pr?.createdAt ?? null;
  let build = null, iterate = null;
  if (prAt) {
    build = 0; iterate = 0;
    for (const s of segs) {
      const c = costOf(s.tokens_by_model);
      if ((s.started_at ?? "") >= prAt) iterate += c; else build += c;
    }
  }

  const a = mission.authored;
  const models = Object.keys(byModel).sort((x, y) => costOf({ [y]: byModel[y] }) - costOf({ [x]: byModel[x] }));
  const totals = TOKEN_KEYS.reduce((acc, k) => (acc[k] = Object.values(byModel).reduce((n, t) => n + t[k], 0), acc), {});

  return {
    work_item_ref: mission.tracker ?? `${mission.campaign}/${mission.id}`,
    work_item_level: "story",
    work_item_brief: mission.brief,
    parent_ref: mission.campaign,
    maturity: a.maturity ?? "production",

    // Authored — the only fields no pipeline can derive (rubric §3.3 is
    // Effort-anchored). Null means "declare it on the board", not "zero".
    size_tshirt: a.size_tshirt ?? null,
    effort_days: a.effort_days ? Number(a.effort_days) : null,
    complexity_score: a.complexity_score ? Number(a.complexity_score) : null,
    self_size: a.self_size ?? null,
    story_points: a.story_points ? Number(a.story_points) : null,

    // Metered
    sessions: new Set(segs.map((s) => s.session_id)).size,
    turns: segs.reduce((n, s) => n + s.turns, 0),
    subagent_dispatches: subSegs.length,
    orchestrator_cost_pct: cost > 0 ? Math.round(100 * orchCost / cost) : 100,
    tokens: {
      input: totals.input_tokens,
      output: totals.output_tokens,
      cache_read: totals.cache_read_input_tokens,
      cache_create: totals.cache_creation_input_tokens,
    },
    primary_model: models[0] ?? null,
    models_used: Object.keys(byModel).sort(),
    tokens_by_model: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, {
      input: t.input_tokens, output: t.output_tokens,
      cache_read: t.cache_read_input_tokens, cache_create: t.cache_creation_input_tokens,
    }])),
    cost_api_equivalent_usd: round2(cost),
    // Per-model cost priced exactly, not apportioned by token share. Models
    // differ ~2.5x in price per token, so a token-share split materially
    // understates the expensive model.
    cost_by_model: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, round2(costOf({ [m]: t }))])),
    cache_read_share_pct: cost > 0 ? Math.round(100 * cacheReadCost(byModel) / cost) : 0,

    // Implementation-stop fields. `net_loc` is the rubric's lane signal;
    // added/removed are reported alongside because net alone hides whether the
    // work was growth, refactor, or deletion.
    net_loc,
    lines_added,
    lines_removed,
    files_changed,
    build_cost_usd: build === null ? null : round2(build),
    iterate_cost_usd: iterate === null ? null : round2(iterate),

    // Provenance for this repo's own diagnostics (not part of the schema).
    _octobots: {
      mission_id: mission.id,
      mission_name: mission.name,
      campaign: mission.campaign,
      branches,
      criteria: `${mission.criteria_done}/${mission.criteria_total}`,
      agent_types: [...new Set(subSegs.map((s) => s.agent_type).filter(Boolean))].sort(),
      diff_source,
      estimated_retrospectively: a.estimated_retrospectively === "true",
      estimate_basis: a.estimate_basis ?? null,
      tasks: taskBreakdown(mission, segs, cost),
      // Task churn is measured per task branch, the mission's from the mission
      // PR — see taskDiff(). They are not expected to add up.
      task_churn_reconciles: false,
      started_at: segs.map((s) => s.started_at).filter(Boolean).sort()[0] ?? null,
      ended_at: segs.map((s) => s.ended_at).filter(Boolean).sort().at(-1) ?? null,
      pr_opened_at: prAt,
    },
  };
}

const runs = [...groups.values()].map(buildRow)
  .sort((a, b) => b.cost_api_equivalent_usd - a.cost_api_equivalent_usd);

// Unattributed work (planning on `main`, detached HEAD, cross-mission chores) is
// reported as its own bucket, never silently dropped — a submission that hides
// 20% of its spend is not a measurement.
const unattrByModel = sumTokens(unattributed);
const unattrTotals = TOKEN_KEYS.reduce((acc, k) => (acc[k] = Object.values(unattrByModel).reduce((n, t) => n + (t[k] ?? 0), 0), acc), {});
const unattributedBucket = {
  segments: unattributed.length,
  turns: unattributed.reduce((n, s) => n + s.turns, 0),
  branches: [...new Set(unattributed.map((s) => s.branch))].sort(),
  // Tokens as well as cost — `verify.mjs` compares whole-repo totals against
  // ccusage, and that only works if the unattributed side carries its tokens.
  tokens: {
    input: unattrTotals.input_tokens,
    output: unattrTotals.output_tokens,
    cache_read: unattrTotals.cache_read_input_tokens,
    cache_create: unattrTotals.cache_creation_input_tokens,
  },
  cost_api_equivalent_usd: round2(costOf(unattrByModel)),
};

const submission = {
  schema_version: "1.0",
  factory_id: "aquanautica-octobots",
  factory_name: "Aquanautica Octobots Factory",
  stop: "implementation",
  owner_group: "dev",
  work_item_level: "story",
  factory_type: "entire-sdlc",
  agent_tool: "claude-code",
  default_method: "metered",
  scope: { includes_subagents: true, includes_retries: true, includes_abandoned_runs: true },
  currency: "USD",
  efficiency_techniques: ["prompt-cache-warming", "subagent-parallelism", "context-pruning", "structured-run-artifacts", "output-shaping"],
  pipeline: "mission-planner -> mission-execution (task loop) -> mission-completion-gate (tests+coverage, black-box QA, critical review) -> merge",
  generated_at: new Date().toISOString(),
  pricing_source: pricing._source,
  pricing_fetched_at: pricing.fetched_at,
  runs,
  unattributed: unattributedBucket,
};

writeFileSync(join(TOK_DIR, "runs.json"), JSON.stringify(submission, null, 2) + "\n");

const totalCost = runs.reduce((n, r) => n + r.cost_api_equivalent_usd, 0);
const missingSizing = runs.filter((r) => r.effort_days === null).map((r) => r._octobots.mission_id);
log(`tokenomics: ${runs.length} mission rows · $${round2(totalCost)} attributed · $${unattributedBucket.cost_api_equivalent_usd} unattributed`);
if (unpriced.size) log(`tokenomics: WARNING unpriced models (fallback rate used): ${[...unpriced].join(", ")}`);
if (missingSizing.length) log(`tokenomics: NOTE no authored sizing for ${missingSizing.join(", ")} — add a 'tokenomics:' map (effort_days, size_tshirt) to those mission.yaml files`);
log(`tokenomics: wrote ${join(TOK_DIR, "runs.json")}`);
