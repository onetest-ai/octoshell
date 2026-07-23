import { describe, it, expect } from "vitest";
import { findMetaSpan, parseWorkflowMeta, serializeMeta } from "../src/workflow-meta.js";

const GOOD = `export const meta = {
  name: 'build-tasks',
  description: 'Drive each task to a merged PR',
  phases: [
    { title: 'Plan', steps: [{ id: 's1', agent: 'planner', label: 'Decompose' }] },
    { title: 'Build', steps: [
      { id: 's2', agent: 'impl', label: 'Build', parallel: 'b' },
      { id: 's3', agent: 'test', label: 'Tests', parallel: 'b', backend: 'codex' },
    ] },
    { title: 'Review', detail: 'gate', steps: [{ id: 's4', agent: 'rev', label: 'Review', dependsOn: ['s2', 's3'] }] },
  ],
}

phase('Build')
await agent('go')
`;

describe("findMetaSpan", () => {
  it("locates the literal and its bounds", () => {
    const span = findMetaSpan(GOOD)!;
    expect(span).not.toBeNull();
    expect(GOOD[span.start]).toBe("{");
    expect(GOOD[span.end - 1]).toBe("}");
    expect(span.literal.startsWith("{")).toBe(true);
    expect(span.literal.endsWith("}")).toBe(true);
  });

  it("ignores braces inside strings", () => {
    const src = `export const meta = { name: 'a}b', description: '{', phases: [] }\nphase('x')`;
    const span = findMetaSpan(src)!;
    expect(span.literal).toBe(`{ name: 'a}b', description: '{', phases: [] }`);
  });

  it("ignores braces inside comments", () => {
    const src = `export const meta = {\n  // a } here\n  /* and { here */\n  name: 'a', phases: []\n}\n`;
    expect(findMetaSpan(src)!.literal.endsWith("}")).toBe(true);
    expect(parseWorkflowMeta(src).name).toBe("a");
  });

  it("returns null when there is no meta export", () => {
    expect(findMetaSpan("const x = 1\n")).toBeNull();
  });
});

describe("parseWorkflowMeta", () => {
  it("coerces phases and steps", () => {
    const meta = parseWorkflowMeta(GOOD);
    expect(meta.name).toBe("build-tasks");
    expect(meta.description).toBe("Drive each task to a merged PR");
    expect(meta.phases.map((p) => p.title)).toEqual(["Plan", "Build", "Review"]);
    expect(meta.phases[1]!.steps.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(meta.phases[1]!.steps[0]!.parallel).toBe("b");
    expect(meta.phases[1]!.steps[1]!.backend).toBe("codex");
    expect(meta.phases[2]!.detail).toBe("gate");
    expect(meta.phases[2]!.steps[0]!.dependsOn).toEqual(["s2", "s3"]);
  });

  it("ignores unknown keys instead of rejecting", () => {
    const src = `export const meta = { name: 'a', whenToUse: 'x', phases: [{ title: 'P', model: 'opus', steps: [] }] }`;
    const meta = parseWorkflowMeta(src);
    expect(meta.phases[0]!.title).toBe("P");
  });

  it("defaults missing phases to an empty list", () => {
    expect(parseWorkflowMeta(`export const meta = { name: 'a' }`).phases).toEqual([]);
  });

  it("throws when meta is absent", () => {
    expect(() => parseWorkflowMeta("const x = 1")).toThrow(/no `export const meta`/);
  });

  it("throws rather than executing a non-literal meta", () => {
    const src = `export const meta = { name: readFileSync('/etc/passwd'), phases: [] }`;
    expect(() => parseWorkflowMeta(src)).toThrow();
  });

  it("throws when meta.name is missing", () => {
    expect(() => parseWorkflowMeta(`export const meta = { phases: [] }`)).toThrow(/meta\.name/);
  });

  it("throws when a step has no agent", () => {
    const src = `export const meta = { name: 'a', phases: [{ title: 'P', steps: [{ id: 's1', label: 'x' }] }] }`;
    expect(() => parseWorkflowMeta(src)).toThrow(/agent/);
  });
});

describe("serializeMeta", () => {
  it("round-trips through parseWorkflowMeta", () => {
    const meta = parseWorkflowMeta(GOOD);
    const round = parseWorkflowMeta(`export const meta = ${serializeMeta(meta)}`);
    expect(round).toEqual(meta);
  });

  it("emits an empty step list compactly", () => {
    const meta = { name: "a", description: "", phases: [{ title: "P", steps: [] }] };
    expect(serializeMeta(meta)).toContain("steps: []");
  });
});
