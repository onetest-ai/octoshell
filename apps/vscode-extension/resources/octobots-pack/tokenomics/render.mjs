#!/usr/bin/env node
// Tokenomics renderer — Stage 3 (runs.json -> self-contained report.html).
//
// Reads ONLY `runs.json`, never the transcripts. That separation is the point:
// the report is reproducible from the committed artifact alone, works on any
// other factory's schema-conformant runs.json, and doubles as the analytics
// attachment a submission asks for (guide §9).
//
// Output is a single file with no external assets — no CDN, no fonts, no fetch.
//
// Usage: node .octobots/tokenomics/render.mjs [--project-dir DIR] [--quiet]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const pdIdx = args.indexOf("--project-dir");
const PROJECT_DIR = pdIdx !== -1 ? args[pdIdx + 1] : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const TOK_DIR = join(PROJECT_DIR, ".octobots", "tokenomics");

const runsFile = join(TOK_DIR, "runs.json");
if (!existsSync(runsFile)) {
  console.error(`tokenomics: ${runsFile} missing — run rollup.mjs first`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(runsFile, "utf8"));

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const usd = (n) => n === null || n === undefined ? "—" : `$${n.toFixed(2)}`;
const num = (n) => n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const mtok = (n) => `${(n / 1e6).toFixed(1)}M`;
const pct = (n) => n === null || n === undefined ? "—" : `${n}%`;

const runs = d.runs ?? [];
const totalCost = runs.reduce((n, r) => n + r.cost_api_equivalent_usd, 0);
const totalTurns = runs.reduce((n, r) => n + r.turns, 0);
const totalDisp = runs.reduce((n, r) => n + r.subagent_dispatches, 0);
const totalTokens = runs.reduce((n, r) => n + Object.values(r.tokens).reduce((a, b) => a + b, 0), 0);
const unattr = d.unattributed ?? { cost_api_equivalent_usd: 0, branches: [], turns: 0 };
const grandCost = totalCost + unattr.cost_api_equivalent_usd;
const maxCost = Math.max(1, ...runs.map((r) => r.cost_api_equivalent_usd));

// Weighted cache-read share and orchestrator share across the whole segment.
const wCache = totalCost ? Math.round(runs.reduce((n, r) => n + r.cache_read_share_pct * r.cost_api_equivalent_usd, 0) / totalCost) : 0;
const wOrch = totalCost ? Math.round(runs.reduce((n, r) => n + r.orchestrator_cost_pct * r.cost_api_equivalent_usd, 0) / totalCost) : 100;

// --- model split (categorical identity; slots 1-3 validate all-pairs) --------
// Exact per-model cost from the rollup. Apportioning a row's cost by token
// share would understate the expensive model — Opus costs ~2.5x Sonnet per
// token, so an equal token split is not an equal cost split.
const modelCost = {};
for (const r of runs) {
  for (const [m, c] of Object.entries(r.cost_by_model ?? {})) {
    modelCost[m] = (modelCost[m] ?? 0) + c;
  }
}
const models = Object.entries(modelCost).sort((a, b) => b[1] - a[1]);
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

// --- data-quality findings (icon + label, never color alone) -----------------
const findings = [];
const noSizing = runs.filter((r) => r.effort_days === null);
if (noSizing.length) {
  findings.push({
    level: "warning",
    title: `${noSizing.length} of ${runs.length} missions have no authored sizing`,
    body: `Effort is the rubric's sizing key and cannot be derived from transcripts. Add a <code>## Tokenomics</code> block (<code>effort_days</code>, <code>size_tshirt</code>) to: ${noSizing.map((r) => esc(r._octobots.mission_id + " " + r._octobots.campaign)).join(", ")}.`,
  });
}
const unattrPct = grandCost ? Math.round(100 * unattr.cost_api_equivalent_usd / grandCost) : 0;
if (unattrPct >= 10) {
  findings.push({
    level: unattrPct >= 25 ? "serious" : "warning",
    title: `${unattrPct}% of spend is not attributable to a mission`,
    body: `${usd(unattr.cost_api_equivalent_usd)} across ${unattr.branches.length} branches (${unattr.branches.map(esc).join(", ")}). This is planning on <code>main</code>, detached <code>HEAD</code>, and campaign-wide branches. It is reported, not dropped — but per-mission rows understate true cost by this much.`,
  });
}
const retro = runs.filter((r) => r._octobots.estimated_retrospectively);
if (retro.length) {
  findings.push({
    level: "warning",
    title: `${retro.length} of ${runs.length} missions were estimated retrospectively`,
    body: `Their effort was reconstructed from lane signals (churn, files, dispatches) after the work shipped, not recorded at planning time. That inverts the rubric — the lane is meant to <em>audit</em> an effort estimate, not produce one — so these sizes are weaker evidence than a planned estimate and the cost-per-size figures inherit that weakness. <code>mission-planner</code> now requires estimates up front, so this should not recur.`,
  });
}
const ghRows = runs.filter((r) => (r._octobots.diff_source ?? "").startsWith("gh-pr"));
if (ghRows.length) {
  findings.push({
    level: "good",
    title: `${ghRows.length} missions took diff stats from their merged PR`,
    body: `Their branches were deleted after merge, so <code>net_loc</code>/<code>files_changed</code> come from the GitHub PR totals. Those are <em>unfiltered</em> — unlike the local merge-base path they do not exclude lock/vendored/generated files, so a scaffold-heavy PR can read high.`,
  });
}

const ICON = { good: "✓", warning: "!", serious: "▲", critical: "✕" };

const headerRows = [
  ["Fabric", `${esc(d.factory_name)} (<code>${esc(d.factory_id)}</code>)`],
  ["Stop · owner", `<code>${esc(d.stop)}</code> · <code>${esc(d.owner_group)}</code>`],
  ["Work-item level", `<code>${esc(d.work_item_level)}</code> — one row per Octobots mission`],
  ["Factory type", `<code>${esc(d.factory_type)}</code>`],
  ["Agent / tool", `<code>${esc(d.agent_tool)}</code>`],
  ["Pipeline", esc(d.pipeline)],
  ["Method · scope", `<code>${esc(d.default_method)}</code> · includes subagents, retries, abandoned runs`],
  ["Techniques", (d.efficiency_techniques ?? []).map((t) => `<code>${esc(t)}</code>`).join(" · ")],
  ["Generated", `${esc(d.generated_at)} · schema <code>${esc(d.schema_version)}</code> · prices cached <code>${esc(d.pricing_fetched_at)}</code>`],
];

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory Tokenomics — ${esc(d.factory_name)}</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb; --plane: #f9f9f7;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --ring: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
    --good: #0ca30c; --warning: #fab219; --serious: #ec835a; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --ring: rgba(255,255,255,0.10);
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --baseline: #383835; --ring: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
  }

  .viz-root {
    background: var(--plane); color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5; padding: 32px 20px 64px; margin: 0;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 1.05rem; margin: 40px 0 12px; letter-spacing: -0.005em; }
  .sub { color: var(--text-secondary); margin: 0 0 28px; font-size: 0.9rem; }
  .card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 18px 20px; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; }
  .tile .v { font-size: 1.7rem; font-weight: 650; letter-spacing: -0.02em; }
  .tile .k { color: var(--text-secondary); font-size: 0.78rem; margin-top: 2px; }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--baseline); }
  td.l, th.l { text-align: left; }
  td.n { font-variant-numeric: tabular-nums; }
  tbody tr:hover { background: color-mix(in srgb, var(--series-1) 7%, transparent); }
  .dim { color: var(--muted); }
  .mission { font-weight: 600; }
  .cmp { color: var(--text-secondary); font-size: 0.78rem; }

  /* Magnitude bar: thin mark, 4px rounded data-end, anchored to a baseline. */
  .bar { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
  .bar .track { width: 110px; height: 8px; background: var(--grid); border-radius: 4px; overflow: hidden; }
  .bar .fill { height: 100%; background: var(--series-1); border-radius: 4px; }

  .stack { display: flex; height: 22px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--surface-1); }
  .stack span { display: block; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; font-size: 0.82rem; color: var(--text-secondary); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }

  .finding { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--grid); }
  .finding:last-child { border-bottom: 0; }
  .finding .ic { flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
                 font-size: 0.72rem; font-weight: 700; color: #fff; margin-top: 2px; }
  .finding .ic.good { background: var(--good); } .finding .ic.warning { background: var(--warning); color: #0b0b0b; }
  .finding .ic.serious { background: var(--serious); color: #0b0b0b; } .finding .ic.critical { background: var(--critical); }
  .finding .t { font-weight: 600; font-size: 0.9rem; }
  .finding .b { color: var(--text-secondary); font-size: 0.84rem; margin-top: 2px; }

  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
         background: color-mix(in srgb, var(--muted) 16%, transparent); padding: 1px 5px; border-radius: 4px; }
  .kv { width: 100%; font-size: 0.85rem; }
  .kv td { border-bottom: 1px solid var(--grid); padding: 7px 0; text-align: left; white-space: normal; }
  .kv td:first-child { color: var(--muted); width: 170px; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  footer { margin-top: 40px; color: var(--muted); font-size: 0.78rem; }

  details.mission { margin-bottom: 10px; padding: 0; }
  details.mission > summary { cursor: pointer; padding: 14px 18px; list-style: none;
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  details.mission > summary::-webkit-details-marker { display: none; }
  details.mission > summary::before { content: "\\25B8"; color: var(--muted); margin-right: 4px;
    display: inline-block; transition: transform .15s; }
  details.mission[open] > summary::before { transform: rotate(90deg); }
  details.mission > summary:hover { background: color-mix(in srgb, var(--series-1) 6%, transparent); }
  details.mission .sm { margin-left: auto; color: var(--text-secondary); font-size: 0.82rem;
    font-variant-numeric: tabular-nums; }
  details.mission .scroll { padding: 0 18px 14px; }
  /* Bound the task-name column and let it wrap. Left unbounded it pushes cost,
     lines and turns past the right edge, hiding the numbers the table exists
     for behind a horizontal scroll. */
  details.mission td:first-child { max-width: 30ch; white-space: normal; line-height: 1.35; }
  details.mission th:first-child { white-space: normal; }
  tr.unmeasured td { opacity: 0.55; }
  /* Growth vs deletion is polarity, so it takes the diverging pair (blue/red),
     never the categorical series. Both carry an explicit +/- sign so the
     meaning never rests on colour alone. */
  .add { color: var(--series-1); }
  .del { color: var(--critical); }
</style>

<div class="viz-root"><div class="wrap">

<h1>Factory Tokenomics — ${esc(d.factory_name)}</h1>
<p class="sub">Metered from Claude Code session transcripts. One row per Octobots mission.
Token counts are canonical; dollars are recomputed from them under the LiteLLM price
table cached <code>${esc(d.pricing_fetched_at)}</code>, and are API-equivalent, not billed.</p>

<div class="tiles">
  <div class="tile"><div class="v">${usd(grandCost)}</div><div class="k">Total metered cost</div></div>
  <div class="tile"><div class="v">${runs.length}</div><div class="k">Missions measured</div></div>
  <div class="tile"><div class="v">${mtok(totalTokens)}</div><div class="k">Tokens (attributed)</div></div>
  <div class="tile"><div class="v">${num(totalTurns)}</div><div class="k">Turns</div></div>
  <div class="tile"><div class="v">${totalDisp}</div><div class="k">Subagent dispatches</div></div>
  <div class="tile"><div class="v">${wCache}%</div><div class="k">Cache-read cost share</div></div>
</div>

<h2>Runs — one row per mission</h2>
<div class="card scroll">
<table>
  <thead><tr>
    <th class="l">Mission</th><th class="l">Campaign</th><th>Size</th><th>Effort d</th>
    <th class="l">Cost (API-equiv)</th><th class="l">Lines</th><th>Net LoC</th><th>Files</th>
    <th>Sessions</th><th>Turns</th><th>Disp.</th><th>Orch.</th><th>Cache</th>
    <th>Tokens</th><th class="l">Build / Iterate</th>
  </tr></thead>
  <tbody>
  ${runs.map((r) => {
    const o = r._octobots;
    const tok = Object.values(r.tokens).reduce((a, b) => a + b, 0);
    const w = Math.max(2, Math.round(100 * r.cost_api_equivalent_usd / maxCost));
    return `<tr>
      <td class="l"><span class="mission">${esc(o.mission_id)}</span> <span class="dim">${esc(o.mission_name)}</span></td>
      <td class="l cmp">${esc(o.campaign)}</td>
      <td class="n">${r.size_tshirt ?? '<span class="dim">—</span>'}</td>
      <td class="n">${r.effort_days ?? '<span class="dim">—</span>'}</td>
      <td><div class="bar" title="${usd(r.cost_api_equivalent_usd)} of ${usd(totalCost)} attributed">
        <span class="n">${usd(r.cost_api_equivalent_usd)}</span>
        <span class="track"><span class="fill" style="width:${w}%"></span></span>
      </div></td>
      <td class="l n">${r.lines_added === null ? '<span class="dim">—</span>'
        : `<span class="add">+${num(r.lines_added)}</span> <span class="del">−${num(r.lines_removed)}</span>`}</td>
      <td class="n">${num(r.net_loc)}</td>
      <td class="n">${num(r.files_changed)}</td>
      <td class="n">${r.sessions}</td>
      <td class="n">${num(r.turns)}</td>
      <td class="n">${r.subagent_dispatches}</td>
      <td class="n">${pct(r.orchestrator_cost_pct)}</td>
      <td class="n">${pct(r.cache_read_share_pct)}</td>
      <td class="n">${mtok(tok)}</td>
      <td class="l n">${usd(r.build_cost_usd)} / ${usd(r.iterate_cost_usd)}</td>
    </tr>`;
  }).join("\n  ")}
  </tbody>
</table>
</div>

<h2>Per-task breakdown</h2>
<p class="sub" style="margin:-4px 0 12px">Tasks within each mission, costliest first. <strong>Mission-level</strong> is work on the
mission branch itself — planning, integration, the completion gate — not attributable to one task.
<strong>How attributed</strong> shows whether the link was a recorded fact (<code>worklog</code>) or
inferred from the branch name.</p>
<p class="sub" style="margin:-18px 0 12px"><strong>Task lines do not sum to the mission's.</strong>
A mission spans several branches: each task PR is measured against the mission branch, while the
mission PR is the merged result — rebases, squashes, conflict resolution and review fixes land only
in the latter, and a line written in one task and rewritten in another counts twice across tasks but
once in the mission. Both are correct at their own level; reconciling them would mean inventing an
allocation. The mission-level row reports no churn of its own, since that <em>is</em> the mission
diff shown in the table above.</p>
${runs.map((r) => {
  const o = r._octobots;
  const tasks = o.tasks ?? [];
  const maxTask = Math.max(1, ...tasks.map((t) => t.cost_api_equivalent_usd));
  return `<details class="card mission">
  <summary>
    <span class="mission">${esc(o.mission_id)}</span>
    <span class="dim">${esc(o.mission_name)}</span>
    <span class="cmp">· ${esc(o.campaign)}</span>
    <span class="sm">${usd(r.cost_api_equivalent_usd)} · ${tasks.filter((t) => !t.unmeasured).length}/${tasks.length} tasks measured</span>
  </summary>
  <div class="scroll"><table>
    <thead><tr>
      <th class="l">Task</th><th class="l">Role</th><th>Size</th><th>Effort d</th>
      <th class="l">Cost</th><th>Share</th><th class="l">Lines</th><th>Turns</th><th>Disp.</th><th>Orch.</th>
      <th>Tokens</th><th class="l">How attributed</th>
    </tr></thead>
    <tbody>
    ${tasks.map((t) => {
      const tok = Object.values(t.tokens).reduce((a, b) => a + b, 0);
      const w = Math.max(2, Math.round(100 * t.cost_api_equivalent_usd / maxTask));
      return `<tr${t.unmeasured ? ' class="unmeasured"' : ""}>
        <td class="l">${t.id ? `<span class="mission">${esc(t.id)}</span>` : '<span class="dim">—</span>'}
          <span class="dim">${esc(t.name)}</span></td>
        <td class="l cmp">${t.role ? esc(t.role) : '<span class="dim">—</span>'}</td>
        <td class="n">${t.size_tshirt ?? '<span class="dim">—</span>'}</td>
        <td class="n">${t.effort_days ?? '<span class="dim">—</span>'}</td>
        <td><div class="bar" title="${usd(t.cost_api_equivalent_usd)} — ${t.cost_share_pct}% of ${esc(o.mission_id)}">
          <span class="n">${usd(t.cost_api_equivalent_usd)}</span>
          <span class="track"><span class="fill" style="width:${w}%"></span></span></div></td>
        <td class="n">${t.cost_share_pct}%</td>
        <td class="l n">${t.lines_added === null ? '<span class="dim">—</span>'
          : `<span class="add">+${num(t.lines_added)}</span> <span class="del">−${num(t.lines_removed)}</span>`}</td>
        <td class="n">${num(t.turns)}</td>
        <td class="n">${t.subagent_dispatches}</td>
        <td class="n">${t.cost_api_equivalent_usd > 0 ? pct(t.orchestrator_cost_pct) : "—"}</td>
        <td class="n">${tok ? mtok(tok) : "—"}</td>
        <td class="l cmp">${t.unmeasured ? '<span class="dim">no branch of its own</span>' : esc(t.attribution ?? "—")}</td>
      </tr>`;
    }).join("\n    ")}
    </tbody>
  </table></div>
</details>`;
}).join("\n")}

<h2>Cost by size</h2>
<p class="sub" style="margin:-4px 0 12px">The calibration this dataset exists for: measured cost against
authored effort. <strong>Cost is never a sizing input</strong> — sizes come from the rubric's Effort
bands, so this comparison stays non-circular.</p>
<div class="card scroll">
<table>
  <thead><tr><th class="l">Size</th><th>Missions</th><th class="l">Total cost</th><th class="l">Median</th>
  <th>Effort days</th><th class="l">$ / effort-day</th></tr></thead>
  <tbody>
  ${["XS", "S", "M", "L", "XL"].map((sz) => {
    const rs = runs.filter((r) => r.size_tshirt === sz);
    if (!rs.length) return "";
    const costs = rs.map((r) => r.cost_api_equivalent_usd).sort((a, b) => a - b);
    const total = costs.reduce((a, b) => a + b, 0);
    const median = costs[Math.floor(costs.length / 2)];
    const days = rs.reduce((n, r) => n + (r.effort_days ?? 0), 0);
    return `<tr>
      <td class="l"><span class="mission">${sz}</span></td>
      <td class="n">${rs.length}</td>
      <td class="l n">${usd(total)}</td>
      <td class="l n">${usd(median)}</td>
      <td class="n">${days}</td>
      <td class="l n">${days ? usd(total / days) : "—"}</td>
    </tr>`;
  }).join("\n  ")}
  </tbody>
</table>
</div>

<h2>Where the cost goes</h2>
<div class="card">
  <div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:8px">By model — cost share across all attributed missions</div>
  <div class="stack">
    ${models.map(([m, c], i) => `<span style="width:${(100 * c / (totalCost || 1)).toFixed(1)}%;background:${SERIES[i] ?? "var(--muted)"}" title="${esc(m)} — ${usd(c)}"></span>`).join("\n    ")}
  </div>
  <div class="legend">
    ${models.map(([m, c], i) => `<span><i style="background:${SERIES[i] ?? "var(--muted)"}"></i>${esc(m)} — <strong>${usd(c)}</strong> (${Math.round(100 * c / (totalCost || 1))}%)</span>`).join("\n    ")}
  </div>

  <div style="font-size:0.82rem;color:var(--text-secondary);margin:22px 0 8px">Orchestrator vs subagents — main-thread share of cost</div>
  <div class="stack">
    <span style="width:${wOrch}%;background:var(--series-1)" title="Orchestrator — ${wOrch}%"></span>
    <span style="width:${100 - wOrch}%;background:var(--series-2)" title="Subagents — ${100 - wOrch}%"></span>
  </div>
  <div class="legend">
    <span><i style="background:var(--series-1)"></i>Orchestrator (main thread) — <strong>${wOrch}%</strong></span>
    <span><i style="background:var(--series-2)"></i>Subagents — <strong>${100 - wOrch}%</strong> across ${totalDisp} dispatches</span>
  </div>
</div>

<h2>Data quality</h2>
<div class="card">
  ${findings.length ? findings.map((f) => `<div class="finding">
    <span class="ic ${f.level}" aria-hidden="true">${ICON[f.level]}</span>
    <div><div class="t">${f.level.toUpperCase()} — ${f.title}</div><div class="b">${f.body}</div></div>
  </div>`).join("\n  ") : '<div class="finding"><span class="ic good">✓</span><div><div class="t">GOOD — no gaps detected</div></div></div>'}
</div>

<h2>Segment header</h2>
<div class="card">
<table class="kv"><tbody>
  ${headerRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("\n  ")}
</tbody></table>
</div>

<footer>
  Generated by <code>.octobots/tokenomics/render.mjs</code> from <code>runs.json</code> — no transcript access required.
  Costs are API-equivalent (tokens × public list price), never billed amounts.
</footer>

</div></div>
`;

writeFileSync(join(TOK_DIR, "report.html"), html);
if (!quiet) console.error(`tokenomics: wrote ${join(TOK_DIR, "report.html")} (${runs.length} missions, ${usd(grandCost)})`);
