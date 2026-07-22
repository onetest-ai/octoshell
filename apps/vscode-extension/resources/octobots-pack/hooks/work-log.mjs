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
//   * Self-gates on `.octobots/`, so it does nothing in a non-Octobots repo.
//   * Writes only; emits nothing on stdout and never influences the agent.
//   * Never fails the tool call. A work log is analytics; analytics must not
//     break the board.
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.env.OCTOBOTS_PROJECT_DIR ?? process.cwd();
if (!existsSync(join(projectDir, ".octobots"))) process.exit(0);

async function slurpStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Tokenize a shell command respecting single/double quotes. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Find a `set-status.js <board> <title> <state>` call in a (possibly chained) command. */
function parseSetStatus(command) {
  for (const seg of command.split(/&&|;|\|\|/)) {
    const toks = tokenize(seg.trim());
    const idx = toks.findIndex((t) => t.endsWith("set-status.js"));
    if (idx === -1) continue;
    const a = toks.slice(idx + 1).filter((t) => !t.startsWith("-"));
    if (a.length < 3) continue;
    return { title: a[a.length - 2], state: a[a.length - 1] };
  }
  return null;
}

let evt;
try {
  evt = JSON.parse(await slurpStdin());
} catch {
  process.exit(0);
}

if ((evt.tool_name ?? evt.toolName) !== "Bash") process.exit(0);
const command = (evt.tool_input ?? evt.toolInput ?? {}).command ?? "";
if (!command.includes("set-status.js")) process.exit(0);

const parsed = parseSetStatus(command);
if (!parsed) process.exit(0);

// Tasks (`T<m>.<n>`) and missions (`M<n>`). Task links are what branch
// inference gets wrong most often; mission links make the session -> mission
// join a recorded fact too, rather than depending on branch naming.
const taskId = parsed.title.match(/^(T\d+\.\d+)\b/)?.[1] ?? null;
const missionId = taskId ? null : (parsed.title.match(/^(M\d+)\b/)?.[1] ?? null);
if (!taskId && !missionId) process.exit(0);
if (!["active", "done"].includes(parsed.state)) process.exit(0);

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

const sessionId = evt.session_id ?? evt.sessionId ?? null;
if (!sessionId) process.exit(0);

try {
  const dir = join(projectDir, ".octobots", "tokenomics");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "worklog.jsonl"),
    JSON.stringify({
      session_id: sessionId,
      ...(taskId ? { task: taskId } : { mission: missionId }),
      state: parsed.state,
      branch,
      at: new Date().toISOString(),
    }) + "\n",
  );
} catch {
  // Never fail the tool call over analytics.
}

process.exit(0);
