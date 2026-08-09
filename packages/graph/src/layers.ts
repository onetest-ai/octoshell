import type { ModuleEdge } from "./rollup.js";

/**
 * Rank modules by dependency depth: 0 = nothing depends on it (entry point).
 *
 * Requires a DIRECTED spine — co-change edges carry no direction, so with no
 * import edges this returns null and `map` omits ranks rather than guessing.
 * Cycles are contracted to one rank and are themselves worth reporting.
 */
export function layerRanks(
  modules: string[],
  imports: ModuleEdge[],
): Map<string, number> | null {
  if (imports.length === 0) return null;

  const out = new Map<string, string[]>(modules.map((m) => [m, []]));
  const inn = new Map<string, string[]>(modules.map((m) => [m, []]));
  for (const e of imports) {
    if (!out.has(e.from) || !inn.has(e.to)) continue;
    out.get(e.from)?.push(e.to);
    inn.get(e.to)?.push(e.from);
  }

  // Contract strongly connected components first (Kosaraju). Without this, a
  // naive Kahn sweep stalls at the first cycle and dumps the cycle AND
  // everything downstream of it into one flat rank — so a module three hops
  // past a cycle would rank identically to the cycle itself.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const to of (out.get(n) ?? []).slice().sort()) visit(to);
    order.push(n);
  };
  for (const m of [...modules].sort()) visit(m);

  const compOf = new Map<string, number>();
  let comps = 0;
  const assign = (n: string, id: number): void => {
    if (compOf.has(n)) return;
    compOf.set(n, id);
    for (const from of (inn.get(n) ?? []).slice().sort()) assign(from, id);
  };
  for (const n of [...order].reverse()) {
    if (!compOf.has(n)) assign(n, comps++);
  }

  // Kahn's algorithm over the condensation, which is a DAG by construction.
  const compIn = new Array<number>(comps).fill(0);
  const compOut: number[][] = Array.from({ length: comps }, () => []);
  const seenEdge = new Set<string>();
  for (const e of imports) {
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}->${b}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    compOut[a]?.push(b);
    compIn[b] = (compIn[b] ?? 0) + 1;
  }

  const compRank = new Array<number>(comps).fill(0);
  let frontier = compIn.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  let depth = 0;
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const c of frontier) {
      compRank[c] = depth;
      for (const to of compOut[c] ?? []) {
        compIn[to] = (compIn[to] ?? 0) - 1;
        if (compIn[to] === 0) next.push(to);
      }
    }
    frontier = [...new Set(next)].sort((a, b) => a - b);
    depth++;
  }

  const rank = new Map<string, number>();
  for (const m of modules) {
    const c = compOf.get(m);
    rank.set(m, c === undefined ? 0 : (compRank[c] ?? 0));
  }
  return rank;
}
