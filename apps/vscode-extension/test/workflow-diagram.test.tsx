import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { layoutWorkflow, WorkflowDiagram, fitLabel, subtitleFor } from "../src/webview/workflow-diagram.js";

// Step labels deliberately differ from phase titles so `getByText` stays unambiguous.
const PHASES = [
  { title: "Plan", steps: [{ id: "s1", agent: "planner", label: "Decompose" }] },
  { title: "Build", steps: [
    { id: "s2", agent: "impl", label: "Build task", parallel: "b" },
    { id: "s3", agent: "test", label: "Write tests", parallel: "b" },
  ] },
  { title: "Review", steps: [{ id: "s4", agent: "rev", label: "Code review", dependsOn: ["s2", "s3"] }] },
];

describe("layoutWorkflow", () => {
  it("places one band per phase, stacked downward", () => {
    const l = layoutWorkflow(PHASES);
    expect(l.bands.map((b) => b.title)).toEqual(["Plan", "Build", "Review"]);
    expect(l.bands[0]!.y).toBeLessThan(l.bands[1]!.y);
    expect(l.bands[1]!.y).toBeLessThan(l.bands[2]!.y);
  });

  it("lays parallel siblings out side by side on the same row", () => {
    const l = layoutWorkflow(PHASES);
    const s2 = l.nodes.find((n) => n.id === "s2")!;
    const s3 = l.nodes.find((n) => n.id === "s3")!;
    expect(s2.y).toBe(s3.y);
    expect(s2.x).not.toBe(s3.x);
  });

  it("draws explicit dependsOn edges and implicit phase-to-phase edges", () => {
    const l = layoutWorkflow(PHASES);
    expect(l.edges).toContainEqual({ from: "s2", to: "s4" });
    expect(l.edges).toContainEqual({ from: "s3", to: "s4" });
    expect(l.edges).toContainEqual({ from: "s1", to: "s2" });
    expect(l.edges).toContainEqual({ from: "s1", to: "s3" });
  });

  it("does not duplicate an edge that is both implicit and explicit", () => {
    const l = layoutWorkflow([
      { title: "A", steps: [{ id: "a", agent: "x", label: "A" }] },
      { title: "B", steps: [{ id: "b", agent: "y", label: "B", dependsOn: ["a"] }] },
    ]);
    expect(l.edges.filter((e) => e.from === "a" && e.to === "b")).toHaveLength(1);
  });

  it("sizes the canvas to fit every node", () => {
    const l = layoutWorkflow(PHASES);
    for (const n of l.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
    }
  });

  it("returns an empty layout for no phases", () => {
    const l = layoutWorkflow([]);
    expect(l.nodes).toEqual([]);
    expect(l.height).toBe(0);
  });

  it("carries kind and repeat onto the node", () => {
    const l = layoutWorkflow([
      { title: "Build", steps: [{ id: "b1", label: "build", agent: "js-dev", repeat: true }] },
      { title: "Ship", steps: [{ id: "s1", label: "testing", kind: "workflow" }] },
    ]);
    expect(l.nodes[0]).toMatchObject({ kind: "agent", repeat: true, agent: "js-dev" });
    expect(l.nodes[1]).toMatchObject({ kind: "workflow", repeat: false, agent: null });
  });
});

describe("WorkflowDiagram", () => {
  it("renders a label and an agent name per step", () => {
    render(<WorkflowDiagram phases={PHASES} />);
    expect(screen.getByText("Decompose")).toBeTruthy();
    expect(screen.getByText("planner")).toBeTruthy();
    expect(screen.getByText("Code review")).toBeTruthy();
  });

  it("renders each phase title", () => {
    render(<WorkflowDiagram phases={PHASES} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("Build")).toBeTruthy();
  });

  it("renders a placeholder when there are no phases", () => {
    render(<WorkflowDiagram phases={[]} />);
    expect(screen.getByText(/no phases/i)).toBeTruthy();
  });

  it("truncates an overlong step label into the card and shows the full text on hover", () => {
    const long = "Build role plumbing (Player model, migration, match_store, matches API, hydration)";
    render(
      <WorkflowDiagram
        phases={[{ title: "Build", steps: [{ id: "s1", agent: "python-dev", label: long }] }]}
      />,
    );
    // The rendered label is truncated with an ellipsis…
    const ellipsized = screen.getByText(/…$/);
    expect(ellipsized.textContent!.length).toBeLessThan(long.length);
    // …but the full label survives in the node <title> tooltip.
    expect(screen.getByText(`${long} — python-dev`)).toBeTruthy();
  });

  // CHANGED (fix round 2, 2026-08-15 workflow-generated-meta plan, task 14): this used to assert
  // "default subagent" rendered. Since validate now blocks a genuinely absent agentType, a step
  // reaching a shipped board with no `agent` can only mean a COMPUTED agentType (dispatches for
  // real; the extractor just cannot read it) — "default subagent" was a false statement on the
  // diagram itself. The node still renders (label intact); it simply carries no subtitle line.
  it("renders no subtitle line when the step names no agent, rather than the old false 'default subagent' claim", () => {
    render(<WorkflowDiagram phases={[{ title: "Build", steps: [{ id: "b1", label: "build" }] }]} />);
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.queryByText("default subagent")).toBeNull();
  });

  it("badges a repeating step", () => {
    render(
      <WorkflowDiagram
        phases={[{ title: "Build", steps: [{ id: "b1", label: "build", agent: "js-dev", repeat: true }] }]}
      />,
    );
    expect(screen.getByText("×N")).toBeTruthy();
  });
});

describe("fitLabel", () => {
  it("leaves a short label untouched", () => {
    expect(fitLabel("Build task")).toBe("Build task");
  });

  it("truncates a long label with a trailing ellipsis and never exceeds the budget", () => {
    const out = fitLabel("Build read-only Role column on the assignment page");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(Math.floor((168 - 20) / 6.6));
  });
});

describe("subtitleFor", () => {
  // CHANGED (fix round 2, 2026-08-15 workflow-generated-meta plan, task 14): the third assertion
  // used to expect the literal string "default subagent" for an agent-less node. That was a false
  // claim once a step with no `agent` in a validated board can only mean a computed `agentType`
  // (real dispatch, unreadable by the extractor) — so `subtitleFor` now omits the line instead.
  it("names the kind on the subtitle line when there is one to name", () => {
    expect(subtitleFor({ kind: "workflow", agent: null })).toBe("workflow");
    expect(subtitleFor({ kind: "command", agent: "project-manager" })).toBe("project-manager · command");
  });

  it("omits the subtitle for an agent-less node, but still names a workflow-kind node", () => {
    expect(subtitleFor({ kind: "agent", agent: null })).toBeUndefined();
    expect(subtitleFor({ kind: "workflow", agent: null })).toBe("workflow");
  });
});
