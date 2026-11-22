#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { dumpEntity, mapBoardStatus, readEntity, resolveEntityFile, resolveStatusTarget } from "./entity-io.mjs";
import { planReviewStatus } from "./plan-review.mjs";
import { worklogFile, worklogProjectDir } from "./worklog-path.mjs";

// Set an entity's status in its OWN `<kind>.yaml` — status is a field in the child's file, never a
// marker on a parent board line (children are folder-derived). Resolve the target by name within the
// given parent folder: the parent itself (campaign/mission self-status), or a child under
// missions/ | tasks/ | bugs/.
//
// Usage: set-status.js <parent-dir|entity.yaml> "<entity title>" <state>
//   <state>  draft | active | executing | awaiting approval | done | failed | cancelled
//
// A mission moves INTO executing (`active`, `in progress` and `running` map to it) only when a
// BA + tech-lead plan review is recorded in its notes or its campaign's notes (plan-review.mjs).
// Exit 3 = refused for that reason. `--force=<reason>` (any argv position) overrides and records
// `## Plan review overridden (<date>)` in the mission notes. No other move is gated.
const rawArgs = process.argv.slice(2);
let forceReason = null;
const positional = [];
for (const a of rawArgs) {
  if (a === "--force" || a.startsWith("--force=")) {
    forceReason = a.slice("--force=".length).replace(/\s+/g, " ").trim();
    if (!forceReason) {
      console.error("set-status: --force needs a reason: --force=<reason>");
      process.exit(2);
    }
    // The reason is written on its own line under the overridden heading. A reason starting with `#`
    // would put a column-0 `## Plan review (...)` line there, which plan-review.mjs reads as a (legacy)
    // review, so a later plain start would pass. Escape it: Markdown renders `\#` as `#`.
    if (forceReason.startsWith("#")) forceReason = `\\${forceReason}`;
  } else {
    positional.push(a);
  }
}
const [arg, rawTitle, ...stateParts] = positional;
const title = (rawTitle ?? "").trim();
const state = stateParts.join(" ").trim();
if (!arg || !title || !state) {
  console.error('usage: set-status.js <parent-dir|entity.yaml> "<entity title>" <state> [--force=<reason>]');
  console.error("  state: draft | active | executing | awaiting approval | done | failed | cancelled");
  process.exit(2);
}

const mapped = mapBoardStatus(state);
if (!mapped) {
  console.error(`set-status: invalid state "${state}" (expected one of: draft, active, executing, awaiting approval, done, failed, cancelled)`);
  process.exit(2);
}
if (!existsSync(arg)) { console.error(`set-status: path not found: ${arg}`); process.exit(2); }

const match = resolveStatusTarget(arg, title);
if (!match) {
  console.error(`set-status: no entity named "${title}" found under ${arg} (self, missions/, tasks/, or bugs/)`);
  process.exit(1);
}

const resolved = resolveEntityFile(match.dir, [match.kind]);
const fields = readEntity(resolved.file, resolved.format);
// The before-state as the board shows it (BoardModel's resolveStatus): a hand-written `awaiting approval`
// or `Done` is the canonical `awaitingApproval` / `done`, so `Done` -> done is no transition, and the
// printed `from` never contains a space the hooks' parser would have to guess around.
const from = mapBoardStatus(fields.status ?? "") ?? "draft";
if (from === mapped) {
  // Already there: write nothing (same bytes). The PostToolUse hooks read this line to tell a re-run
  // from a real transition.
  console.log(`set status of "${title}" to ${mapped} (already)`);
  console.log(`octobots: status ${match.kind} ${JSON.stringify(title)} unchanged (${mapped})`);
  process.exit(0);
}
if (match.kind === "mission" && mapped === "executing") {
  const campaignDir = join(match.dir, "..", "..");
  const campaignFile = resolveEntityFile(campaignDir, ["campaign"]);
  // An unreadable campaign file holds no review we can see. It must not crash the script: an
  // uncaught throw exits 1, and exit 1 means "no such entity".
  let campaignNotes = "";
  let campaignError = null;
  try {
    campaignNotes = campaignFile ? readEntity(campaignFile.file, campaignFile.format).notes : "";
  } catch (e) {
    campaignError = `${campaignFile.file}: ${String(e.message).split("\n")[0]}`;
  }
  const review = planReviewStatus(fields.notes, campaignNotes);
  if (review.ok) {
    if (review.legacy) {
      console.error(`warning: legacy plan review "${review.heading}" (${review.where} notes) has no Reviewers:/Verdict: lines; accepted`);
    }
  } else if (forceReason === null) {
    refuse(review.candidates, campaignError);
  } else {
    const day = new Date().toISOString().slice(0, 10);
    const note = `## Plan review overridden (${day})\n${forceReason}`;
    const old = fields.notes ?? "";
    fields.notes = old ? `${old}${old.endsWith("\n") ? "\n" : "\n\n"}${note}` : note;
    console.log(`plan review overridden with --force; recorded in the notes of "${title}"`);
  }
}
fields.status = mapped;
writeFileSync(join(match.dir, `${match.kind}.yaml`), dumpEntity(match.kind, fields), "utf8");
console.log(`set status of "${title}" to ${mapped}`);
// Machine-readable, one per call: the hooks (hooks/status-flip.mjs) act only on a line like this.
console.log(`octobots: status ${match.kind} ${JSON.stringify(title)} ${from} -> ${mapped}`);
recordWorklog();

/**
 * Append the tokenomics work-log line for a real task or mission start/finish: which Claude Code session
 * did which task (`.octobots/tokenomics/worklog.jsonl`). This script performs the transition, so it is
 * the one place that knows the target for certain; the PostToolUse hook (work-log.mjs) can only guess it
 * from the command text and sees nothing when the call passes its arguments through shell variables.
 * The session comes from CLAUDE_CODE_SESSION_ID. Without one nothing is written (the hook still can).
 * Analytics must never fail a status change.
 */
function recordWorklog() {
  try {
    const session = process.env.CLAUDE_CODE_SESSION_ID;
    const requested = state.toLowerCase();
    if (!session || !["active", "done"].includes(requested)) return;
    const taskId = title.match(/^(T\d+\.\d+)\b/)?.[1] ?? null;
    const missionId = taskId ? null : (title.match(/^(M\d+)\b/)?.[1] ?? null);
    if (!taskId && !missionId) return;
    // The file is the session's project dir's, the same rule the work-log hook uses (worklog-path.mjs).
    // It self-gates on `.octobots/` there, like the hook. The branch is the board's own checkout's.
    if (!existsSync(join(worklogProjectDir(), ".octobots"))) return;
    const abs = resolve(arg);
    const at = abs.indexOf(`${sep}.octobots${sep}`);
    let branch = null;
    try {
      if (at !== -1) branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: abs.slice(0, at), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // Detached HEAD or not a git repo: the session id alone still links the work.
    }
    const file = worklogFile();
    mkdirSync(dirname(file), { recursive: true });
    const target = taskId ? { task: taskId } : { mission: missionId };
    appendFileSync(file, JSON.stringify({ session_id: session, ...target, state: requested, branch, at: new Date().toISOString() }) + "\n");
  } catch {
    // Never fail the status change over analytics.
  }
}

/** Print why the move into executing is refused, and how to fix or override it, then exit 3. */
function refuse(candidates, campaignError) {
  // (a) no `## Plan review (...)` section at all; (b) sections exist but none satisfies the rule.
  // Keep this wording and the record template identical to packages/board/src/write.ts (planReviewRefusal).
  const reason = candidates.length === 0 ? "no plan review is recorded" : "a plan review is recorded but does not approve the start";
  const lines = [`set-status: refusing to move "${title}" into executing: ${reason}.`];
  if (campaignError) lines.push(`  the campaign notes could not be read (${campaignError})`);
  if (candidates.length === 0) {
    lines.push("  no `## Plan review (...)` heading in the mission notes or the campaign notes");
  } else {
    for (const c of candidates) lines.push(`  ${c.where} notes: "${c.heading}": ${c.missing.join("; ")}`);
  }
  lines.push(
    "To record a review, write the record below into the mission notes or the campaign notes with entity-io.mjs",
    "(loadEntity/dumpEntity; see mission-planner SKILL.md, Plan review), never by editing the YAML text.",
    "Fill the placeholders and keep one verdict. The lines between the markers start in column 0:",
    "--- record template (paste into the mission or campaign notes) ---",
    "## Plan review (<names or roles>, <date>)",
    "Reviewers: ba (<name>), tech-lead (<name>)",
    "Verdict: approved | approved with nits",
    "--- end of record template ---",
    "To start without one, re-run with --force=<reason>; the reason is recorded in the mission notes.",
  );
  console.error(lines.join("\n"));
  process.exit(3);
}
