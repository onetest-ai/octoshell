// Manual ACP verification for Copilot session-start hook firing. NOT a vitest test.
// Usage: node apps/vscode-extension/scripts/verify-copilot-hook.mjs
// Try also: GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1 node apps/vscode-extension/scripts/verify-copilot-hook.mjs
//
// Drives `copilot --acp --stdio`: initialize -> session/new -> session/prompt, where the
// prompt asks the model to echo the word after "driven by" from its Octobots primer. If the
// sessionStart hook fired and injected the primer as additionalContext, the model replies
// "Octobots"; otherwise "NONE".
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "copilot-verify-"));
mkdirSync(join(repo, ".octobots", "hooks"), { recursive: true });
copyFileSync(
  new URL("../resources/octobots-pack/hooks/primer.mjs", import.meta.url),
  join(repo, ".octobots", "hooks", "primer.mjs"),
);
writeFileSync(join(repo, ".octobots", "hooks", "package.json"), `{ "type": "module" }\n`);
mkdirSync(join(repo, ".github", "hooks"), { recursive: true });
writeFileSync(
  join(repo, ".github", "hooks", "hooks.json"),
  JSON.stringify({ sessionStart: [{ type: "command", command: "node .octobots/hooks/primer.mjs --backend copilot" }] }, null, 2),
);

const child = spawn("copilot", ["--acp", "--stdio"], { cwd: repo, stdio: ["pipe", "pipe", "inherit"] });
function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }

let sessionId = null;
let assistantText = "";
let promptSent = false;
let line = "";

child.stdout.on("data", (chunk) => {
  line += chunk.toString();
  const parts = line.split("\n");
  line = parts.pop() ?? "";
  for (const raw of parts) {
    if (!raw.trim()) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.id === 2 && msg.result?.sessionId) {
      sessionId = msg.result.sessionId;
      if (!promptSent) {
        promptSent = true;
        send({
          jsonrpc: "2.0", id: 3, method: "session/prompt",
          params: {
            sessionId,
            prompt: [{ type: "text", text: "Reply with ONLY the single word that follows 'driven by' in your Octobots primer/instructions. If you have no such primer, reply NONE." }],
          },
        });
      }
    }
    if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk") {
        const c = u.content;
        if (typeof c?.text === "string") assistantText += c.text;
        else if (Array.isArray(c)) for (const b of c) if (typeof b?.text === "string") assistantText += b.text;
      }
    }
    if (msg.id === 3 && msg.error) console.error("session/prompt error:", JSON.stringify(msg.error));
  }
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repo, mcpServers: [] } }), 1000);

setTimeout(() => {
  const fired = /octobots/i.test(assistantText);
  console.error(`\n\n=== assistant reply: ${JSON.stringify(assistantText.slice(0, 300))}`);
  console.error(`=== VERDICT: primer ${fired ? "REACHED" : "DID NOT REACH"} the model ===`);
  child.kill();
  process.exit(fired ? 0 : 1);
}, 25000);
