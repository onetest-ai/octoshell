#!/usr/bin/env node
// Warn-only commit trailer writer. The pack's attribution CLI (.octobots/tokenomics/attribute.mjs) owns
// all branch-to-board mapping; this script only turns its answer into an `Octobots-Mission:` or
// `Octobots-Campaign:` trailer, plus an optional Codex `Co-Authored-By:` line.
//
// It is reached from two committed shims in the repo's hooks directory (core.hooksPath), never
// installed by the pack itself:
//   prepare-commit-msg  ->  node .octobots/hooks/prepare-commit-msg.mjs <file> [<source>]
//   commit-msg          ->  node .octobots/hooks/prepare-commit-msg.mjs --after-edit <file>
// Print the shim texts and check the wiring with `node .octobots/hooks/hooks-doctor.mjs`.
//
// RULES: never refuses a commit (always exits 0), never writes a duplicate trailer, prints at most one
// warning per commit.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let branch = "HEAD";
let warned = false;
function warn(reason) {
  if (warned) return;
  warned = true;
  console.error(
    `prepare-commit-msg: warning: ${branch}: ${reason}; branches must carry the campaign slug and -m<n> for mission work (see the mission-execution skill, "Branch topology").`,
  );
}
const git = (args, timeout = 2000) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();

// Two entry points share this file. prepare-commit-msg runs before the editor; commit-msg (--after-edit)
// runs after it. A trailer written before the editor makes an untouched message non-empty, so
// "save an empty message to abort" and `git commit -m ""` would commit a trailer-only message.
// Hence: with no message content yet, prepare-commit-msg leaves a marker and writes nothing; commit-msg
// adds the trailers only when that marker exists and the user has typed content.
const afterEdit = process.argv[2] === "--after-edit";
const file = process.argv[afterEdit ? 3 : 2];
const source = afterEdit ? "" : (process.argv[3] ?? "");
let marker = null;
try {
  marker = join(git(["rev-parse", "--absolute-git-dir"]), "OCTOBOTS_TRAILER_AFTER_EDIT");
} catch {
  /* Without git there is nothing to defer to; the content check below still applies. */
}

// Git writes its comment lines (and the verbose scissors line) with core.commentChar. `auto` means git
// picked a character that no message line starts with; the scissors line, when present, names it.
function commentChar(body) {
  let configured = "#";
  try {
    configured = git(["config", "--get", "core.commentChar"]) || "#";
  } catch {
    /* unset: git's default */
  }
  if (configured !== "auto") return configured[0];
  return body.match(/^(\S) -{24} >8 -{24}$/m)?.[1] ?? "#";
}
const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
// What git keeps of a message: no comment lines, no verbose diff after the scissors line.
function content(text, ch) {
  const scissors = new RegExp(`^${escapeRe(ch)} -{24} >8 -{24}$`, "m");
  return text
    .split(scissors)[0]
    .split("\n")
    .filter((l) => !l.startsWith(ch))
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

try {
  // A stale marker (editor killed before commit-msg ran) is cleared by the next prepare-commit-msg.
  const deferred = marker !== null && existsSync(marker) ? readFileSync(marker, "utf8") : null;
  if (marker !== null && deferred !== null) rmSync(marker, { force: true });
  if (afterEdit && deferred === null) process.exit(0);
  const body = readFileSync(file, "utf8");
  const ch = commentChar(body);
  // A commit.template is shown in the editor; git aborts when it is left untouched, so defer it too.
  if (!afterEdit && (!content(body, ch) || source === "template")) {
    if (marker !== null) writeFileSync(marker, body);
    process.exit(0);
  }
  // Left empty or unchanged in the editor: git aborts the commit, so add nothing.
  if (afterEdit && (!content(body, ch) || content(body, ch) === content(deferred, ch))) process.exit(0);
  const lines = [];
  // An amend already carries the trailer. Avoid even loading the board in that case.
  if (!/^Octobots-(?:Mission|Campaign):/m.test(body)) {
    try {
      const root = git(["rev-parse", "--show-toplevel"]);
      try {
        branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      } catch {
        /* Detached HEAD has no branch identity. */
      }
      // The CLI loads the whole board (about a second); a loaded machine needs more than a few seconds.
      const limit = Number(process.env.OCTOBOTS_ATTRIBUTE_TIMEOUT_MS);
      const timeout = Number.isFinite(limit) && limit > 0 ? limit : 30000;
      const result = JSON.parse(
        execFileSync(process.execPath, [join(root, ".octobots/tokenomics/attribute.mjs"), "--branch", branch, "--project-dir", root], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout,
        }),
      );
      if (result.kind === "mission" && result.campaign && result.mission) lines.push(`Octobots-Mission: ${result.campaign}/${result.mission}`);
      else if (result.kind === "campaign" && result.campaign) lines.push(`Octobots-Campaign: ${result.campaign}`);
      else warn("unattributed");
    } catch {
      warn("attribution unavailable");
    }
  }
  const codex = [];
  const model = process.env.OCTOBOTS_CODEX_MODEL?.replace(/[\r\n]/g, " ").trim();
  if (model && !/^Co-Authored-By: Codex \(/im.test(body)) codex.push(`Co-Authored-By: Codex (${model}) <noreply@openai.com>`);
  // doNothing matches on the trailer key only, so it would drop the Codex line beside any other
  // Co-Authored-By. addIfDifferent matches key and value; the pre-check above keeps amends idempotent.
  for (const [policy, list] of [
    ["doNothing", lines],
    ["addIfDifferent", codex],
  ]) {
    for (const line of list) {
      execFileSync("git", ["interpret-trailers", "--in-place", "--if-exists", policy, "--trailer", line, file], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 2000,
      });
    }
  }
} catch {
  warn("could not update commit message");
}
// The hook must never refuse a commit, including on I/O/CLI failures.
process.exitCode = 0;
