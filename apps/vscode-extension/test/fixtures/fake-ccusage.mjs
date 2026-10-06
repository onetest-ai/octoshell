#!/usr/bin/env node
// Test double for ccusage 20.0.18 (`session --json --offline`). It reproduces only the behaviours the
// verify.mjs tests depend on, each one measured against the real binary:
//   * CLAUDE_CONFIG_DIR is a comma-separated list; each entry is a dir holding `projects/` or the
//     `projects/` dir itself. Any other entry (or a missing one) is an error, exit 1.
//   * A symlinked PROJECT dir inside a root is NOT followed; a symlink named `projects` IS.
//   * Records dedupe on requestId across ALL roots, so a session in two roots counts once.
//   * Rows are keyed by PATH, not by the records' sessionId (emitted in `period`): `<slug>/<sid>.jsonl`
//     and `<slug>/<sid>/subagents/*.jsonl` -> `<sid>`; any deeper file -> the name of the dir holding it,
//     so a Workflow-tool agent at `<sid>/subagents/workflows/wf_<id>/a.jsonl` is its own `wf_<id>` row.
//   * Each row carries `modelBreakdowns` (per model: tokens + `cost`), like the real binary.
//     FAKE_CCUSAGE_ZERO_COST_MODELS=a,b makes those models cost $0 (ccusage's bundled price table
//     predates e.g. claude-opus-5-5, so the real binary reports $0 for it) - totalCost follows.
//   * FAKE_CCUSAGE_FAIL=1 exits 1 (a broken binary). FAKE_CCUSAGE_LOG appends {argv, CLAUDE_CONFIG_DIR, resolved}.
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_CCUSAGE_FAIL === "1") {
  console.error("fake ccusage: boom");
  process.exit(1);
}

const entries = (process.env.CLAUDE_CONFIG_DIR ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const projectsDirs = [];
for (const e of entries) {
  const p = basename(e) === "projects" ? e : join(e, "projects");
  if (existsSync(p) && statSync(p).isDirectory()) projectsDirs.push(p);
}
if (process.env.FAKE_CCUSAGE_LOG) {
  // `resolved` is captured now: the caller deletes its staged dirs as soon as this process exits.
  appendFileSync(process.env.FAKE_CCUSAGE_LOG, JSON.stringify({
    argv, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, resolved: projectsDirs.map((p) => realpathSync(p)),
  }) + "\n");
}
if (projectsDirs.length === 0) {
  console.error("No valid Claude data directories found");
  process.exit(1);
}

// Sonnet 4.5 list prices, USD per token.
const PRICE = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheCreate: 3.75e-6 };

function* jsonl(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* jsonl(full);
    else if (e.name.endsWith(".jsonl")) yield { file: full, name: e.name };
  }
}

const zeroCost = new Set((process.env.FAKE_CCUSAGE_ZERO_COST_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean));
const seen = new Set();
const sessions = new Map();
for (const projects of projectsDirs) {
  for (const slug of readdirSync(projects)) {
    const slugDir = join(projects, slug);
    if (lstatSync(slugDir).isSymbolicLink() || !lstatSync(slugDir).isDirectory()) continue;
    for (const { file } of jsonl(slugDir)) {
      const rel = file.slice(slugDir.length + 1).split("/");
      const parent = rel.length >= 2 ? rel[rel.length - 2] : null;
      const id = rel.length === 1 ? rel[0].replace(/\.jsonl$/, "") : parent === "subagents" ? rel[0] : parent;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== "assistant" || !d.message?.usage) continue;
        if (d.requestId) {
          if (seen.has(d.requestId)) continue;
          seen.add(d.requestId);
        }
        const s = sessions.get(id) ?? { agent: "claude", period: id, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 };
        const u = d.message.usage;
        s.inputTokens += u.input_tokens ?? 0;
        s.outputTokens += u.output_tokens ?? 0;
        s.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        s.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        const cost = zeroCost.has(d.message.model) ? 0 :
          (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output +
          (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheCreate;
        s.totalCost += cost;
        const mb = (s.modelBreakdowns ??= []).find((b) => b.modelName === d.message.model) ??
          (s.modelBreakdowns.push({ modelName: d.message.model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 }), s.modelBreakdowns.at(-1));
        mb.inputTokens += u.input_tokens ?? 0;
        mb.outputTokens += u.output_tokens ?? 0;
        mb.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        mb.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        mb.cost += cost;
        sessions.set(id, s);
      }
    }
  }
}
console.log(JSON.stringify({ session: [...sessions.values()], totals: {} }));
