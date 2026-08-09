import type { Edge } from "./weights.js";

/** Weight given to synthetic bridge edges: enough to connect, too little to cluster. */
const BRIDGE_WEIGHT = 0.01;

/** Connected components, largest first. */
export function findComponents(edges: Edge[], nodes: number[]): number[][] {
  const adj = new Map<number, number[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }

  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop();
      if (n === undefined) continue;
      comp.push(n);
      for (const nb of adj.get(n) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp.sort((a, b) => a - b));
  }
  comps.sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
  return comps;
}

const dirOf = (p: string): string => p.split("/").slice(0, -1).join("/");

/** Histogram of directory prefixes across a component's files. */
function dirHistogram(comp: number[], files: string[]): Map<string, number> {
  const hist = new Map<string, number>();
  for (const n of comp) {
    const path = files[n];
    if (path === undefined) continue;
    const parts = dirOf(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      hist.set(prefix, (hist.get(prefix) ?? 0) + 1);
    }
  }
  return hist;
}

function similarity(a: Map<string, number>, b: Map<string, number>): number {
  let score = 0;
  for (const [k, v] of a) score += Math.min(v, b.get(k) ?? 0);
  return score;
}

/**
 * Connect isolated components via directory proximity.
 *
 * Louvain emits at least one community per connected component regardless of
 * resolution, so an unbridged co-change graph produces a long tail of junk
 * single-file "modules". Ported from wikis'
 * `graph_topology.bridge_disconnected_components`.
 */
export function bridgeComponents(edges: Edge[], files: string[]): Edge[] {
  const nodes = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const comps = findComponents(edges, nodes);
  if (comps.length <= 1) return edges;

  const hists = comps.map((c) => dirHistogram(c, files));
  const out = [...edges];

  for (let i = 1; i < comps.length; i++) {
    const comp = comps[i];
    const hist = hists[i];
    if (!comp || !hist) continue;

    let bestIdx = 0;
    let bestScore = -1;
    for (let j = 0; j < i; j++) {
      const other = hists[j];
      if (!other) continue;
      const score = similarity(hist, other);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    const target = comps[bestIdx];
    const from = comp[0];
    const to = target?.[0];
    if (from === undefined || to === undefined) continue;
    out.push({
      a: Math.min(from, to),
      b: Math.max(from, to),
      support: 0, // synthetic: no commit backs this edge
      npmi: BRIDGE_WEIGHT,
      confidence: 0,
    });
  }

  return out;
}
