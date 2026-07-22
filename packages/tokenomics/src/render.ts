import type { MissionRun, Report, TaskRun, TokenTotals } from "./types.js";

/**
 * Render a report to a single self-contained HTML file.
 *
 * Deliberately takes ONLY a `Report` — no filesystem, no transcripts. The export
 * is therefore reproducible from the committed artifact alone, works on any
 * conformant report, and is the artefact a cost submission attaches.
 *
 * No external assets: no CDN, no fonts, no fetch. It has to open from a file://
 * path years from now, offline.
 */
export function renderReportHtml(report: Report, title = "Factory Tokenomics"): string {
  const runs = report.runs;
  const attributed = runs.reduce((n, r) => n + r.costUsd, 0);
  const total = attributed + report.unattributed.costUsd;
  const tokens = runs.reduce((n, r) => n + tokenTotal(r.tokens), 0);
  const turns = runs.reduce((n, r) => n + r.turns, 0);
  const dispatches = runs.reduce((n, r) => n + r.subagentDispatches, 0);
  const maxCost = Math.max(1, ...runs.map((r) => r.costUsd));

  // Weighted by cost, not a plain mean: a $1 mission must not swing the average
  // as hard as a $100 one.
  const wCache = attributed
    ? Math.round(runs.reduce((n, r) => n + r.cacheReadSharePct * r.costUsd, 0) / attributed)
    : 0;
  const wOrch = attributed
    ? Math.round(runs.reduce((n, r) => n + r.orchestratorCostPct * r.costUsd, 0) / attributed)
    : 100;

  const modelCost = new Map<string, number>();
  for (const r of runs) {
    for (const [m, c] of Object.entries(r.costByModel)) {
      modelCost.set(m, (modelCost.get(m) ?? 0) + c);
    }
  }
  const models = [...modelCost.entries()].sort((a, b) => b[1] - a[1]);

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<div class="viz"><div class="wrap">

<h1>${esc(title)}</h1>
<p class="sub">Metered from ${esc(report.agentTool)} transcripts. Token counts are canonical; dollars are
recomputed from them under the cached price table${report.pricesFetchedAt ? ` (${esc(report.pricesFetchedAt)})` : ""}
and are API-equivalent, not billed. Generated ${esc(report.generatedAt)}.</p>

<div class="tiles">
  ${tile(usd(total), "Total metered cost")}
  ${tile(String(runs.length), "Missions measured")}
  ${tile(mtok(tokens), "Tokens (attributed)")}
  ${tile(int(turns), "Turns")}
  ${tile(String(dispatches), "Subagent dispatches")}
  ${tile(`${wCache}%`, "Cache-read cost share")}
</div>

<h2>Runs — one row per mission</h2>
<div class="card scroll">
<table>
  <thead><tr>
    <th class="l">Mission</th><th class="l">Campaign</th><th>Size</th><th>Effort d</th>
    <th class="l">Cost</th><th>Orch.</th><th>Cache</th><th>Sessions</th><th>Turns</th><th>Disp.</th><th>Tokens</th>
  </tr></thead>
  <tbody>
  ${runs
    .map(
      (r) => `<tr>
      <td class="l"><span class="strong">${esc(r.missionTitle)}</span></td>
      <td class="l dim">${esc(shortCampaign(r.campaignId))}</td>
      <td class="n">${r.estimate.sizeTshirt ?? dash()}</td>
      <td class="n">${r.estimate.effortDays ?? dash()}</td>
      <td><div class="bar" title="${usd(r.costUsd)}">
        <span class="n">${usd(r.costUsd)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(2, Math.round((100 * r.costUsd) / maxCost))}%"></span></span>
      </div></td>
      <td class="n">${r.orchestratorCostPct}%</td>
      <td class="n">${r.cacheReadSharePct}%</td>
      <td class="n">${r.sessions}</td>
      <td class="n">${int(r.turns)}</td>
      <td class="n">${r.subagentDispatches}</td>
      <td class="n">${mtok(tokenTotal(r.tokens))}</td>
    </tr>`,
    )
    .join("\n  ")}
  </tbody>
</table>
</div>

<h2>Per-task breakdown</h2>
<p class="sub">Tasks within each mission, costliest first. <strong>Mission-level</strong> is work on the mission
branch itself — planning, integration, the gate — attributable to no single task. <strong>Attributed</strong>
shows whether the link was a recorded fact (<code>worklog</code>) or inferred from the branch name.</p>
${runs.map(missionDetails).join("\n")}

<h2>Cost by size</h2>
<p class="sub">Measured cost against authored effort. Sizes come from the rubric's Effort bands, so this
comparison stays non-circular — <strong>cost is never a sizing input</strong>.</p>
<div class="card scroll">
<table>
  <thead><tr><th class="l">Size</th><th>Missions</th><th class="l">Total</th><th class="l">Median</th><th>Effort days</th><th class="l">$ / effort-day</th></tr></thead>
  <tbody>
  ${["XS", "S", "M", "L", "XL"]
    .map((size) => {
      const rs = runs.filter((r) => r.estimate.sizeTshirt === size);
      if (!rs.length) return "";
      const costs = rs.map((r) => r.costUsd).sort((a, b) => a - b);
      const sum = costs.reduce((a, b) => a + b, 0);
      const days = rs.reduce((n, r) => n + (r.estimate.effortDays ?? 0), 0);
      return `<tr>
        <td class="l"><span class="strong">${size}</span></td>
        <td class="n">${rs.length}</td>
        <td class="l n">${usd(sum)}</td>
        <td class="l n">${usd(costs[Math.floor(costs.length / 2)] ?? 0)}</td>
        <td class="n">${days || dash()}</td>
        <td class="l n">${days ? usd(sum / days) : dash()}</td>
      </tr>`;
    })
    .join("\n  ")}
  </tbody>
</table>
</div>

<h2>Where the cost goes</h2>
<div class="card">
  <div class="lbl">By model — priced per model, never apportioned by token share</div>
  <div class="stack">
    ${models
      .map(
        ([m, c], i) =>
          `<span style="width:${pct(c, attributed)}%;background:${SERIES[i] ?? "var(--muted)"}" title="${esc(m)} — ${usd(c)}"></span>`,
      )
      .join("\n    ")}
  </div>
  <div class="legend">
    ${models
      .map(
        ([m, c], i) =>
          `<span><i style="background:${SERIES[i] ?? "var(--muted)"}"></i>${esc(m)} — <strong>${usd(c)}</strong> (${pct(c, attributed)}%)</span>`,
      )
      .join("\n    ")}
  </div>

  <div class="lbl" style="margin-top:22px">Orchestrator vs subagents — main-thread share of cost</div>
  <div class="stack">
    <span style="width:${wOrch}%;background:${SERIES[0]}"></span>
    <span style="width:${100 - wOrch}%;background:${SERIES[1]}"></span>
  </div>
  <div class="legend">
    <span><i style="background:${SERIES[0]}"></i>Orchestrator — <strong>${wOrch}%</strong></span>
    <span><i style="background:${SERIES[1]}"></i>Subagents — <strong>${100 - wOrch}%</strong> across ${dispatches} dispatches</span>
  </div>
</div>

<h2>Data quality</h2>
<div class="card">${findings(report, total).join("\n")}</div>

<footer>Costs are API-equivalent (tokens x public list price), never billed amounts.
Rendered from the report alone — no transcript access required.</footer>

</div></div>
`;
}

function missionDetails(r: MissionRun): string {
  const maxTask = Math.max(1, ...r.tasks.map((t) => t.costUsd));
  const measured = r.tasks.filter((t) => !t.unmeasured).length;
  return `<details class="card mission">
  <summary>
    <span class="strong">${esc(r.missionTitle)}</span>
    <span class="dim">${esc(shortCampaign(r.campaignId))}</span>
    <span class="sm">${usd(r.costUsd)} · ${measured}/${r.tasks.length} tasks measured</span>
  </summary>
  <div class="scroll"><table>
    <thead><tr>
      <th class="l">Task</th><th>Size</th><th>Effort d</th><th class="l">Cost</th>
      <th>Share</th><th>Turns</th><th>Disp.</th><th>Orch.</th><th>Tokens</th><th class="l">Attributed</th>
    </tr></thead>
    <tbody>
    ${r.tasks.map((t) => taskRow(t, maxTask)).join("\n    ")}
    </tbody>
  </table></div>
</details>`;
}

function taskRow(t: TaskRun, maxTask: number): string {
  const tok = tokenTotal(t.tokens);
  return `<tr${t.unmeasured ? ' class="unmeasured"' : ""}>
    <td class="l">${t.taskId ? `<span class="strong">${esc(t.taskId)}</span> ` : ""}<span class="dim">${esc(t.name)}</span></td>
    <td class="n">${t.estimate.sizeTshirt ?? dash()}</td>
    <td class="n">${t.estimate.effortDays ?? dash()}</td>
    <td><div class="bar"><span class="n">${usd(t.costUsd)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(2, Math.round((100 * t.costUsd) / maxTask))}%"></span></span></div></td>
    <td class="n">${t.costSharePct}%</td>
    <td class="n">${int(t.turns)}</td>
    <td class="n">${t.subagentDispatches}</td>
    <td class="n">${t.costUsd > 0 ? `${t.orchestratorCostPct}%` : dash()}</td>
    <td class="n">${tok ? mtok(tok) : dash()}</td>
    <td class="l dim">${t.unmeasured ? "not measured" : esc(t.attribution ?? "—")}</td>
  </tr>`;
}

/** Every finding carries an icon + label, so meaning never rests on colour alone. */
function findings(report: Report, total: number): string[] {
  const out: string[] = [];
  const noEstimate = report.runs.filter((r) => r.estimate.effortDays === null);
  if (noEstimate.length) {
    out.push(
      finding(
        "warning",
        `${noEstimate.length} of ${report.runs.length} missions have no authored effort`,
        "Effort is the rubric's sizing key and cannot be derived from transcripts. Add a <code>## Tokenomics</code> block at planning time.",
      ),
    );
  }
  const retro = report.runs.filter((r) => r.estimate.estimatedRetrospectively);
  if (retro.length) {
    out.push(
      finding(
        "warning",
        `${retro.length} missions were estimated retrospectively`,
        "Their effort was reconstructed after the work shipped, which inverts the rubric — the delivery signals are meant to <em>audit</em> an estimate, not produce one. The cost-per-size figures inherit that weakness.",
      ),
    );
  }
  const unattrPct = total > 0 ? Math.round((100 * report.unattributed.costUsd) / total) : 0;
  if (unattrPct >= 10) {
    out.push(
      finding(
        unattrPct >= 25 ? "serious" : "warning",
        `${unattrPct}% of spend is not attributable to a mission`,
        `${usd(report.unattributed.costUsd)} across ${report.unattributed.branches.length} branches (${report.unattributed.branches.map(esc).join(", ")}). Reported, never dropped — but per-mission rows understate true cost by this much.`,
      ),
    );
  }
  if (report.unpricedModels.length) {
    out.push(
      finding(
        "serious",
        `${report.unpricedModels.length} model(s) have no price entry`,
        `${report.unpricedModels.map(esc).join(", ")} — their cost reads as zero, so the total is understated. Refresh the price table.`,
      ),
    );
  }
  if (!out.length) out.push(finding("good", "No gaps detected", ""));
  return out;
}

function finding(level: "good" | "warning" | "serious", title: string, body: string): string {
  const icon = { good: "&#10003;", warning: "!", serious: "&#9650;" }[level];
  return `<div class="finding">
    <span class="ic ${level}" aria-hidden="true">${icon}</span>
    <div><div class="t">${level.toUpperCase()} — ${esc(title)}</div>${body ? `<div class="b">${body}</div>` : ""}</div>
  </div>`;
}

function tile(value: string, label: string): string {
  return `<div class="tile"><div class="v">${esc(value)}</div><div class="k">${esc(label)}</div></div>`;
}

function tokenTotal(t: TokenTotals): number {
  // cacheCreate5m/1h are a breakdown of cacheCreate, not additional tokens.
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

const shortCampaign = (id: string): string => id.replace(/^folder:campaigns\//, "").split("/")[0] ?? id;
const usd = (n: number): string => `$${n.toFixed(2)}`;
const int = (n: number): string => n.toLocaleString("en-US");
const mtok = (n: number): string => `${(n / 1e6).toFixed(1)}M`;
const pct = (n: number, of: number): number => (of > 0 ? Math.round((100 * n) / of) : 0);
const dash = (): string => '<span class="dim">—</span>';

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Categorical slots 1-3, validated colourblind-safe against both surfaces.
const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

const STYLE = `
.viz{color-scheme:light;--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
--grid:#e1e0d9;--ring:rgba(11,11,11,.1);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;
background:var(--plane);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
line-height:1.5;padding:32px 20px 64px;margin:0}
@media(prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz{color-scheme:dark;
--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--ring:rgba(255,255,255,.1);
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500}}
:root[data-theme="dark"] .viz{color-scheme:dark;--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;
--grid:#2c2c2a;--ring:rgba(255,255,255,.1);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:40px 0 12px}
.sub{color:var(--ink2);margin:0 0 20px;font-size:.9rem;max-width:78ch}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:18px 20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:14px 16px}
.tile .v{font-size:1.7rem;font-weight:650;letter-spacing:-.02em}
.tile .k{color:var(--ink2);font-size:.78rem;margin-top:2px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
td.l,th.l{text-align:left}
td.n{font-variant-numeric:tabular-nums}
tbody tr:hover{background:color-mix(in srgb,var(--s1) 7%,transparent)}
.dim{color:var(--muted)}.strong{font-weight:600}
.bar{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.bar .track{width:110px;height:8px;background:var(--grid);border-radius:4px;overflow:hidden}
.bar .fill{height:100%;background:var(--s1);border-radius:4px}
.stack{display:flex;height:22px;border-radius:4px;overflow:hidden;gap:2px}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px;font-size:.82rem;color:var(--ink2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
.lbl{font-size:.82rem;color:var(--ink2);margin-bottom:8px}
details.mission{margin-bottom:10px;padding:0}
details.mission>summary{cursor:pointer;padding:14px 18px;list-style:none;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
details.mission>summary::-webkit-details-marker{display:none}
details.mission>summary::before{content:"\\25B8";color:var(--muted);margin-right:4px;display:inline-block;transition:transform .15s}
details.mission[open]>summary::before{transform:rotate(90deg)}
details.mission .sm{margin-left:auto;color:var(--ink2);font-size:.82rem;font-variant-numeric:tabular-nums}
details.mission .scroll{padding:0 18px 14px}
details.mission td:first-child{max-width:30ch;white-space:normal;line-height:1.35}
tr.unmeasured td{opacity:.55}
.finding{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--grid)}
.finding:last-child{border-bottom:0}
.finding .ic{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:.72rem;font-weight:700;color:#fff;margin-top:2px}
.finding .ic.good{background:var(--good)}.finding .ic.warning{background:var(--warning);color:#0b0b0b}
.finding .ic.serious{background:var(--serious);color:#0b0b0b}
.finding .t{font-weight:600;font-size:.9rem}.finding .b{color:var(--ink2);font-size:.84rem;margin-top:2px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;background:color-mix(in srgb,var(--muted) 16%,transparent);padding:1px 5px;border-radius:4px}
footer{margin-top:40px;color:var(--muted);font-size:.78rem}
`;
