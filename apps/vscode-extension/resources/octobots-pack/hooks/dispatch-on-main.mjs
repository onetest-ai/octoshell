// Warn-only PreToolUse Agent|Task analytics. Never print a decision or fail a dispatch.
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const evt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
            at: new Date().toISOString()
          }) + "\n"
        );
      }
    }
  }
} catch {
  /* Analytics must never block the tool, including malformed input and I/O failures. */
}
