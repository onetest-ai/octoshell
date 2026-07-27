/**
 * A `<kind>.yaml` round-trip must never destroy content it does not understand.
 *
 * Both entity implementations — the app's `entity-schema.ts` and the pack's standalone
 * `entity-io.mjs` — parse a file into typed fields and then rewrite the WHOLE file from those
 * fields. Anything the typed model does not model is therefore deleted by the next unrelated edit.
 * That is exactly how a campaign's decision record was lost when a document was linked; `notes` was
 * only the instance, an unmodelled key is the class.
 *
 * Every case runs against BOTH implementations, which must agree — they are two copies of one
 * on-disk contract.
 */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEntity, dumpEntity, type EntityFields } from "../src/entity-schema.js";

const SCRIPTS = resolve(
  __dirname,
  "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts",
);
const pack = (await import(pathToFileURL(join(SCRIPTS, "entity-io.mjs")).href)) as {
  loadEntity: (text: string) => Record<string, unknown>;
  dumpEntity: (kind: string, fields: Record<string, unknown>) => string;
};
const { load: yamlLoad } = (await import(pathToFileURL(join(SCRIPTS, "vendor/js-yaml.mjs")).href)) as {
  load: (text: string) => Record<string, unknown>;
};

/** The two implementations of the same on-disk contract. */
const IMPLS: Array<[string, (kind: string, yaml: string) => Record<string, unknown>]> = [
  ["app entity-schema.ts", (kind, yaml) => yamlLoad(dumpEntity(kind as never, loadEntity(yaml)))],
  ["pack entity-io.mjs", (kind, yaml) => yamlLoad(pack.dumpEntity(kind, pack.loadEntity(yaml)))],
];

const TASK_HEAD = "name: T1.1 - X\nstatus: draft\ndescription: d\n";

describe.each(IMPLS)("%s preserves content it does not model", (_name, roundTrip) => {
  it("keeps unknown top-level keys", () => {
    const out = roundTrip(
      "task",
      `${TASK_HEAD}acceptance_criteria: []\nowner: alice\nestimate_hours: 8\nlinked_pr: 'https://example.com/pr/1'\n`,
    );
    expect(out.owner).toBe("alice");
    expect(out.estimate_hours).toBe(8);
    expect(out.linked_pr).toBe("https://example.com/pr/1");
    // …without disturbing the modelled keys.
    expect(out.name).toBe("T1.1 - X");
    expect(out.acceptance_criteria).toEqual([]);
  });

  it("keeps a structured unknown key verbatim", () => {
    const out = roundTrip(
      "task",
      `${TASK_HEAD}acceptance_criteria: []\nexec_sessions:\n  - id: s1\n    cost: 0.42\n  - id: s2\n    cost: 1.5\n`,
    );
    expect(out.exec_sessions).toEqual([
      { id: "s1", cost: 0.42 },
      { id: "s2", cost: 1.5 },
    ]);
  });

  it("keeps extra keys inside an acceptance criterion", () => {
    const out = roundTrip(
      "task",
      `${TASK_HEAD}acceptance_criteria:\n  - text: works\n    done: false\n    verified_by: qa-agent\n    evidence: run-1234\n`,
    );
    expect(out.acceptance_criteria).toEqual([
      { text: "works", done: false, verified_by: "qa-agent", evidence: "run-1234" },
    ]);
  });

  it("keeps extra keys inside a document link", () => {
    const out = roundTrip(
      "mission",
      "name: M1 - X\nstatus: draft\ndescription: d\nacceptance_criteria: []\ndocuments:\n  - label: Spec\n    target: docs/spec.md\n    added_by: planner\n",
    );
    expect(out.documents).toEqual([{ label: "Spec", target: "docs/spec.md", added_by: "planner" }]);
  });

  it("keeps a nested value inside tokenomics", () => {
    const out = roundTrip(
      "task",
      `${TASK_HEAD}acceptance_criteria: []\ntokenomics:\n  effort_days: 2\n  breakdown:\n    design: 1\n    build: 1\n`,
    );
    expect(out.tokenomics).toEqual({ effort_days: 2, breakdown: { design: 1, build: 1 } });
  });

  it("still keeps notes — the originally reported loss", () => {
    const out = roundTrip(
      "campaign",
      "name: C\nstatus: draft\ntarget: ''\ndescription: d\nacceptance_criteria: []\ndocuments: []\nnotes: |\n  ## Decision\n  no server\n",
    );
    expect(String(out.notes)).toContain("no server");
  });

  // A key the schema knows but this kind does not own (hand-edited, or landed there via an external
  // import). It is malformed, but malformed is not a licence to delete it — validate reports it.
  it("keeps documents on a task", () => {
    const out = roundTrip(
      "task",
      `${TASK_HEAD}acceptance_criteria: []\ndocuments:\n  - label: Spec\n    target: docs/spec.md\n`,
    );
    expect(out.documents).toEqual([{ label: "Spec", target: "docs/spec.md" }]);
  });

  it("keeps tokenomics on a campaign", () => {
    const out = roundTrip(
      "campaign",
      "name: C\nstatus: draft\ntarget: ''\ndescription: d\nacceptance_criteria: []\ndocuments: []\ntokenomics:\n  effort_days: 5\n",
    );
    expect(out.tokenomics).toEqual({ effort_days: 5 });
  });

  it("keeps role on a mission", () => {
    const out = roundTrip(
      "mission",
      "name: M1 - X\nstatus: draft\ndescription: d\nacceptance_criteria: []\ndocuments: []\nrole: python-dev\n",
    );
    expect(out.role).toBe("python-dev");
  });

  it("keeps acceptance_criteria on a bug", () => {
    const out = roundTrip(
      "bug",
      "name: B1\nstatus: draft\nseverity: major\ndescription: d\nacceptance_criteria:\n  - text: must not regress\n    done: false\n",
    );
    expect(out.acceptance_criteria).toEqual([{ text: "must not regress", done: false }]);
  });

  it("does not invent empty keys the kind does not own", () => {
    // An empty list carries nothing — preserving it would litter every task with `documents: []`.
    const out = roundTrip("task", `${TASK_HEAD}acceptance_criteria: []\ndocuments: []\n`);
    expect(out.documents).toBeUndefined();
  });

  it("survives repeated round-trips without erosion", () => {
    let yaml = `${TASK_HEAD}acceptance_criteria:\n  - text: works\n    done: false\n    evidence: run-1\ntokenomics:\n  effort_days: 2\nowner: alice\nnotes: keep me\n`;
    for (let i = 0; i < 5; i++) {
      const out = roundTrip("task", yaml);
      expect(out.owner).toBe("alice");
      expect(out.notes).toBe("keep me");
      expect(out.acceptance_criteria).toEqual([{ text: "works", done: false, evidence: "run-1" }]);
      expect(out.tokenomics).toEqual({ effort_days: 2 });
      yaml = JSON.stringify(out) === "{}" ? yaml : dumpEntityAgain(out);
    }
  });
});

/** Re-serialise a parsed object back to yaml so the next iteration re-reads it. */
function dumpEntityAgain(o: Record<string, unknown>): string {
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
}

describe("the two implementations agree byte-for-byte", () => {
  const cases: Array<[string, string]> = [
    ["task", `${TASK_HEAD}acceptance_criteria: []\nowner: alice\nnotes: n\n`],
    [
      "mission",
      "name: M1 - X\nstatus: draft\ndescription: d\nacceptance_criteria:\n  - text: a\n    done: true\n    evidence: e\ndocuments:\n  - label: L\n    target: t\n    added_by: p\ntokenomics:\n  effort_days: 1\n  breakdown:\n    a: 1\nextra_key: v\n",
    ],
    ["bug", "name: B1\nstatus: draft\nseverity: major\ndescription: d\nfound_in_build: '42'\n"],
    ["campaign", "name: C\nstatus: draft\ntarget: ''\ndescription: d\nacceptance_criteria: []\ndocuments: []\nsponsor: dana\n"],
  ];

  it.each(cases)("%s", (kind, yaml) => {
    const app = dumpEntity(kind as never, loadEntity(yaml));
    const packed = pack.dumpEntity(kind, pack.loadEntity(yaml) as unknown as EntityFields as never);
    expect(packed).toBe(app);
  });
});
