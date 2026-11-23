// Warn-only PreToolUse Agent|Task analytics. Never print a decision or fail a dispatch.
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// At most this much of the payload is ever held. An Agent dispatch with a very long prompt is
// larger; its record is then built from the payload's head (see headFields).
const LIMIT = 128 * 1024;

/**
 * session_id, tool_name and cwd read from the first LIMIT bytes of a payload that is larger. Claude
 * Code writes these top-level keys before `tool_input`, the part that grows. A key spelled inside a
 * JSON string is escaped (`\"tool_name\"`), so it never matches `"tool_name"`.
 */
function headFields(text) {
  const str = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; }
  };
  return { session_id: str("session_id"), tool_name: str("tool_name"), cwd: str("cwd"), truncated: true };
}

try {
  const chunks = [];
  let bytes = 0;
  let over = false;
  const deadline = setTimeout(() => process.exit(0), 500);
  try {
    for await (const chunk of process.stdin) {
      if (bytes + chunk.length > LIMIT) {
        chunks.push(chunk.subarray(0, LIMIT - bytes));
        over = true;
        break;
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(deadline);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const evt = over ? headFields(text) : JSON.parse(text);
  const tool = evt?.tool_name ?? evt?.toolName;
  const session = evt?.session_id ?? evt?.sessionId;
  if (["Agent", "Task"].includes(tool) && typeof session === "string" && session) {
    // The session can be in a feature worktree while the environment names the main checkout.
    const cwd =
      evt.cwd ??
      process.env.CLAUDE_PROJECT_DIR ??
      process.env.OCTOBOTS_PROJECT_DIR ??
      process.cwd();
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    }).trim();
    if (existsSync(join(root, ".octobots"))) {
      const branch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000
      }).trim();
      if (branch === "main") {
        const dir = join(root, ".octobots/tokenomics");
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, "diagnostics.jsonl"),
          JSON.stringify({
            kind: "dispatch-on-main",
            session_id: session,
            branch,
            tool_name: tool,
            ...(evt.truncated ? { truncated: true } : {}),
            at: new Date().toISOString()
          }) + "\n"
        );
      }
    }
  }
} catch {
  /* Analytics must never block the tool, including malformed input and I/O failures. */
}
