// Octobots work log — records which agent session did which task/mission.
//
// Installed into `<repo>/.octobots/hooks/` with the rest of the pack and
// registered as a PostToolUse(Bash) hook, so it works out of the box on every
// Octobots install with nothing to configure.
//
// When mission-planner's `set-status.js` flips a TASK or MISSION to `active` or
// `done`, this appends one line to `.octobots/tokenomics/worklog.jsonl`:
//
//   {"session_id":"…","task":"T11.4","state":"active","branch":"feat/…","at":"…"}
//
// WHY
// Attribution of cost and effort to a task otherwise has to be *inferred* from
// branch names (`feat/<campaign>-m3-t2` -> T3.2). That works only while every
// branch follows the convention and silently mis-attributes when it does not:
// a mission built on a single branch collapses into one bucket, and an
// off-convention branch is attributed to nothing at all.
//
// This records the link as a fact instead. It hooks the status transition the
// execution flow ALREADY performs, so there is no extra step for an agent to
// remember or skip — the link is captured as a side effect of normal board use,
// not by asking a model to log something.
//
// DESIGN RULES
//   * Inert unless it recognises a status flip — exits 0 on all other Bash calls.
//   * Logs a flip only when set-status.js reported a real transition AND the target's YAML shows the
//     requested status (status-flip.mjs). Needs the payload's tool_response; without it, logs nothing.
//   * Self-gates on `.octobots/`, so it does nothing in a non-Octobots repo.
//   * Writes only; emits nothing on stdout and never influences the agent.
//   * Never fails the tool call. A work log is analytics; analytics must not
//     break the board.
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { confirmedTransitions, parseSetStatusAll } from "./status-flip.mjs";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.env.OCTOBOTS_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(projectDir, ".octobots"))) process.exit(0);

async function slurpStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let evt;
try {
  evt = JSON.parse(await slurpStdin());
} catch {
  process.exit(0);
}
if (!evt || typeof evt !== "object") process.exit(0);

if ((evt.tool_name ?? evt.toolName) !== "Bash") process.exit(0);
const command = (evt.tool_input ?? evt.toolInput ?? {})?.command;
if (typeof command !== "string" || !command.includes("set-status.js")) process.exit(0);

const sessionId = evt.session_id ?? evt.sessionId ?? null;
if (!sessionId) process.exit(0);

// Tasks (`T<m>.<n>`) and missions (`M<n>`). Task links are what branch
// inference gets wrong most often; mission links make the session -> mission
// join a recorded fact too, rather than depending on branch naming. Every call
// in a chained command counts (`… "T1.3 - …" done && … "M1 - …" done`).
const candidates = [];
for (const call of parseSetStatusAll(command)) {
  const taskId = call.title.match(/^(T\d+\.\d+)\b/)?.[1] ?? null;
  const missionId = taskId ? null : (call.title.match(/^(M\d+)\b/)?.[1] ?? null);
  if (!taskId && !missionId) continue;
  if (!["active", "done"].includes(call.state)) continue;
  candidates.push({ ...call, taskId, missionId });
}
// Log only a flip that really happened: set-status.js printed a transition line (the status moved and
// the file was written) and the target's YAML holds the requested status. `… "M9 - no such mission"
// active; echo` exits 0 but writes nothing; re-running `done` prints `unchanged`; a refused start
// prints nothing. Logging any of those would attribute this session to work it never did.
const flips = (await confirmedTransitions(candidates, evt, projectDir)).map((c) =>
  c.taskId ? { task: c.taskId, state: c.state } : { mission: c.missionId, state: c.state },
);
if (flips.length === 0) process.exit(0);

let branch = null;
try {
  branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // Detached HEAD, or not a git repo — the session id alone still links the work.
}

try {
  const dir = join(projectDir, ".octobots", "tokenomics");
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  appendFileSync(
    join(dir, "worklog.jsonl"),
    flips.map((f) => JSON.stringify({ session_id: sessionId, ...f, branch, at }) + "\n").join(""),
  );
} catch {
  // Never fail the tool call over analytics.
}

process.exit(0);
