import { it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as attribution from "../src/attribution.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const mission = { id: "M2b", campaign: "demo", missionKey: "2b", missionNum: 2, declaredBranches: [], tasks: [] };
function context(overlap = false) {
  const root = mkdtempSync(join(tmpdir(), "ledger-attr-")); dirs.push(root);
  const dir = join(root, ".agents/telemetry/delivery"); mkdirSync(dir, { recursive: true });
  const events = [
    { plan: "demo/run-1", level: "task", ref: "T2b.1", event: "created", at: "2026-01-01T00:00:00Z" },
    { plan: "demo/run-1", level: "task", ref: "T2b.1", event: "dispatched", at: "2026-01-02T00:00:00Z" },
    { plan: "demo/run-1", level: "mission", ref: "M2b", event: "completed", at: "2026-01-04T00:00:00Z" },
    ...(overlap ? [
      { plan: "demo/run-2", level: "mission", ref: "M3", event: "first_commit", at: "2026-01-02T00:00:00Z" },
      { plan: "demo/run-2", level: "mission", ref: "M3", event: "completed", at: "2026-01-04T00:00:00Z" },
    ] : []),
  ];
  writeFileSync(join(dir, "events-test.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\ncorrupt\n");
  const windows = attribution.loadLedgerWindows(root);
  return attribution.makeAttributionContext({ missions: [mission, { ...mission, id: "M3", missionKey: "3" }], campaigns: [{ slug: "demo", declaredBranches: [] }] }, new Map(), windows);
}
const segment = { branch: "main", sessionId: "s", source: "codex", startedAt: "2026-01-02T00:00:00Z", endedAt: "2026-01-04T00:00:00Z" };
it("preserves the existing Codex midpoint fallback as step 0", () => {
  expect(attribution.resolveSegmentAttribution(segment, context())).toEqual({ kind: "mission", mission, step: 0 });
});
it("keeps ambiguous windows unattributed", () => {
  expect(attribution.resolveSegmentAttribution(segment, context(true))).toEqual({ kind: "unattributed", step: 7 });
});
it.each([
  { ...segment, source: "claude" },
  { ...segment, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:00Z" },
  { ...segment, startedAt: null, endedAt: null },
])("does not attribute Claude, planning-only, or invalid timestamps: %s", (s) => {
  expect(attribution.resolveSegmentAttribution(s, context())).toEqual({ kind: "unattributed", step: 7 });
});
it("lets the seven-step branch table win before considering a ledger window", () => {
  expect(attribution.resolveSegmentAttribution({ ...segment, branch: "feat/demo-m3-t1" }, context())).toMatchObject({ kind: "mission", mission: { id: "M3" }, step: 2 });
});
