/**
 * Read-only workflow diagram.
 *
 * Deterministic layered layout drawn as plain SVG — one horizontal band per phase, steps laid out
 * left-to-right inside their band, edges from every step of a phase to every step of the next
 * (plus explicit `dependsOn` edges). No layout library and no external dependency; colors come from
 * VS Code theme tokens so the diagram themes with the editor.
 */

import type { WorkflowPhase } from "@octoshell/board";

export interface DiagramNode { id: string; label: string; agent: string; x: number; y: number; w: number; h: number }
export interface DiagramEdge { from: string; to: string }
export interface DiagramBand { title: string; y: number; h: number }
export interface DiagramLayout {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  bands: DiagramBand[];
  width: number;
  height: number;
}

const NODE_W = 168;
const NODE_H = 52;
const GAP_X = 24;
const GAP_Y = 44;
const PAD = 16;
const BAND_LABEL_W = 96;
const TEXT_PAD = 10; // left inset of node text (matches the render x offset)

/**
 * SVG `<text>` has no CSS ellipsis, so a long label just overflows the card. Truncate it to what
 * fits a node of `nodeWidth` at roughly `charPx` per glyph (proportional-font estimate, deliberately
 * conservative — a little under-fill beats spilling past the card), appending an ellipsis. The full
 * text stays available via the node's `<title>` tooltip.
 */
export function fitLabel(text: string, nodeWidth = NODE_W, charPx = 6.6): string {
  const maxChars = Math.max(4, Math.floor((nodeWidth - TEXT_PAD * 2) / charPx));
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

/** Lay phases out top-to-bottom, steps left-to-right within their phase. */
export function layoutWorkflow(phases: WorkflowPhase[]): DiagramLayout {
  if (phases.length === 0) return { nodes: [], edges: [], bands: [], width: 0, height: 0 };

  const nodes: DiagramNode[] = [];
  const bands: DiagramBand[] = [];
  const edges: DiagramEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (from: string, to: string): void => {
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to });
  };

  const widest = Math.max(1, ...phases.map((p) => p.steps.length));
  const width = PAD * 2 + BAND_LABEL_W + widest * NODE_W + (widest - 1) * GAP_X;

  let y = PAD;
  phases.forEach((phase, pi) => {
    bands.push({ title: phase.title, y, h: NODE_H });
    phase.steps.forEach((step, si) => {
      nodes.push({
        id: step.id,
        label: step.label,
        agent: step.agent,
        x: PAD + BAND_LABEL_W + si * (NODE_W + GAP_X),
        y,
        w: NODE_W,
        h: NODE_H,
      });
    });

    // Implicit sequencing: every step of the previous phase feeds every step of this one.
    const prev = phases[pi - 1];
    if (prev) for (const p of prev.steps) for (const s of phase.steps) addEdge(p.id, s.id);

    y += NODE_H + GAP_Y;
  });

  // Explicit dependencies, added after the implicit ones so duplicates collapse.
  for (const phase of phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) addEdge(dep, step.id);
    }
  }

  return { nodes, edges, bands, width, height: y - GAP_Y + PAD };
}

export function WorkflowDiagram({ phases }: { phases: WorkflowPhase[] }): JSX.Element {
  const layout = layoutWorkflow(phases);
  if (layout.nodes.length === 0) {
    return <div className="text-sm text-fg-muted p-4">This workflow has no phases yet.</div>;
  }

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));

  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="Workflow diagram"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="text-fg-muted"
      >
        <defs>
          <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
          </marker>
        </defs>

        {layout.edges.map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const x1 = from.x + from.w / 2;
          const y1 = from.y + from.h;
          const x2 = to.x + to.w / 2;
          const y2 = to.y;
          const mid = (y1 + y2) / 2;
          return (
            <path
              key={`${e.from}->${e.to}`}
              d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.6}
              markerEnd="url(#wf-arrow)"
            />
          );
        })}

        {layout.bands.map((b) => (
          <text key={`${b.title}-${b.y}`} x={PAD} y={b.y + b.h / 2 + 4} className="fill-current" fontSize={11}>
            {b.title}
          </text>
        ))}

        {layout.nodes.map((n) => (
          <g key={n.id}>
            <title>{`${n.label} — ${n.agent}`}</title>
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={4}
              fill="var(--vscode-editorWidget-background)"
              stroke="var(--vscode-widget-border, var(--vscode-editorWidget-border))"
            />
            <text x={n.x + TEXT_PAD} y={n.y + 21} fontSize={12} fill="var(--vscode-foreground)">
              {fitLabel(n.label)}
            </text>
            <text x={n.x + TEXT_PAD} y={n.y + 39} fontSize={11} fill="var(--vscode-descriptionForeground)">
              {fitLabel(n.agent, NODE_W, 6)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
