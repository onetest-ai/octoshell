/**
 * Read-only workflow diagram.
 *
 * Deterministic layered layout drawn as plain SVG — one horizontal band per phase, steps laid out
 * left-to-right inside their band, edges from every step of a phase to every step of the next
 * (plus explicit `dependsOn` edges). No layout library and no external dependency; colors come from
 * VS Code theme tokens so the diagram themes with the editor.
 */

import type { WorkflowPhase } from "@octoshell/board";

export interface DiagramNode {
  id: string;
  label: string;
  /**
   * null when the step's `agentType` is either absent or a computed expression the extractor
   * could not read as a literal — see `subtitleFor`'s doc comment for why those two cases cannot
   * be told apart here, and why that is fine.
   */
  agent: string | null;
  kind: "agent" | "workflow" | "command";
  repeat: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}
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
        agent: step.agent ?? null,
        kind: step.kind ?? "agent",
        repeat: step.repeat === true,
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

/**
 * The second line of a node: the agent that will run it, "workflow" for a composed sub-workflow,
 * or nothing at all when the step names no `agent`.
 *
 * That last case used to render "default subagent" — but since `validate` (packages/board) blocks
 * a board whose `agentType` is genuinely absent, a null `agent` reaching a shipped, validated board
 * can only mean the call named an `agentType` the extractor could not read (a computed expression
 * like `agentType: task.role`), which dispatches for real at run time. "Default subagent" was a
 * false statement about that step on the one surface a reviewer actually reads before a run is
 * kicked off — the same false-positive class fixed in `validate` one round earlier, just visible
 * here instead of in a CLI message. Silence is the honest reading: undefined, not a placeholder
 * string, so the caller renders no subtitle line rather than an empty one.
 */
export function subtitleFor(node: Pick<DiagramNode, "kind" | "agent">): string | undefined {
  if (node.kind === "workflow") return "workflow";
  if (!node.agent) return undefined;
  return node.kind === "command" ? `${node.agent} · command` : node.agent;
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

        {layout.nodes.map((n) => {
          const subtitle = subtitleFor(n);
          return (
            <g key={n.id}>
              <title>{`${n.label} — ${n.agent ?? "default subagent"}${n.repeat ? " (repeats per item)" : ""}`}</title>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={4}
                fill="var(--vscode-editorWidget-background)"
                stroke="var(--vscode-widget-border, var(--vscode-editorWidget-border))"
                strokeDasharray={n.kind === "workflow" ? "4 3" : undefined}
              />
              <text x={n.x + TEXT_PAD} y={n.y + 21} fontSize={12} fill="var(--vscode-foreground)">
                {fitLabel(n.label)}
              </text>
              {subtitle !== undefined && (
                <text x={n.x + TEXT_PAD} y={n.y + 39} fontSize={11} fill="var(--vscode-descriptionForeground)">
                  {fitLabel(subtitle, NODE_W, 6)}
                </text>
              )}
              {n.repeat && (
                <text
                  x={n.x + n.w - TEXT_PAD}
                  y={n.y + 39}
                  fontSize={10}
                  textAnchor="end"
                  fill="var(--vscode-descriptionForeground)"
                >
                  ×N
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
