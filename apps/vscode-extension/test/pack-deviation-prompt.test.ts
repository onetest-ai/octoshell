import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  choiceForButton,
  decideLocalChanges,
  deviationPrompt,
  installCompletionMessage,
  shouldPromptOnActivation,
  type Deviation,
} from "../src/host/pack-deviations.js";
import type { PendingRecord } from "../src/host/pack-updates.js";

const dev = (skill: string, version: string, reason: Deviation["reason"], retired = false, sha256 = "a".repeat(64)): Deviation => ({
  skill, version, reason, retired, sha256,
});
const SOLO = [dev("mission-execution", "57-local", "label"), dev("mission-completion-gate", "57-local", "label")];

describe("deviationPrompt", () => {
  it("solo's two forks: the exact message, detail and buttons", () => {
    expect(deviationPrompt(SOLO, 57)).toEqual({
      message: "Octobots: 2 pack skill(s) in this workspace were changed locally.",
      detail: [
        "Installing the Octobots pack v57 would replace or delete these skills:",
        "• mission-execution: version 57-local (not a pack version)",
        "• mission-completion-gate: version 57-local (not a pack version)",
        "Reconcile: install everything else and stage these skills in .octobots/pack-updates/v57/; your next agent session merges them with the octobots-doctor skill.",
        "Overwrite: replace them with the pack's files.",
        "Keep mine: install everything else and leave these skills as they are.",
        "Cancel: install nothing.",
      ].join("\n"),
      buttons: ["Reconcile", "Overwrite", "Keep mine"],
    });
  });

  it("Reconcile is the first button, so it is the default", () => {
    expect(deviationPrompt(SOLO, 57).buttons[0]).toBe("Reconcile");
  });

  it.each([
    [dev("mission-planner", "56", "content"), "• mission-planner: version 56 (differs from the pack's v56 file)"],
    [dev("mission-planner", "52", "unknown-version"), "• mission-planner: version 52 (not a file the pack shipped)"],
    [dev("mission-planner", "57+local", "reconciled-older"), "• mission-planner: version 57+local (reconciled against an earlier pack file)"],
    [dev("workflow-designer", "56", "content", true), "• workflow-designer: version 56 (differs from the pack's v56 file; retired in v57, so Overwrite deletes it)"],
    [dev("workflow-designer", "56-local", "label", true), "• workflow-designer: version 56-local (not a pack version; retired in v57, so Overwrite deletes it)"],
  ])("line form for %j", (d, line) => {
    const p = deviationPrompt([d], 57);
    expect(p.message).toBe("Octobots: 1 pack skill(s) in this workspace were changed locally.");
    expect(p.detail.split("\n")[1]).toBe(line);
  });

  it("a missing version label reads as `missing`", () => {
    expect(deviationPrompt([dev("mission-planner", "missing", "label")], 57).detail).toContain("• mission-planner: version missing (not a pack version)");
  });

  it("names the pack version in the detail and the staging folder", () => {
    const d = deviationPrompt(SOLO, 58).detail;
    expect(d).toContain("pack v58 would replace");
    expect(d).toContain(".octobots/pack-updates/v58/");
  });
});

describe("choiceForButton", () => {
  it("maps each button to the installer's choice, and Cancel (undefined) to null", () => {
    expect(choiceForButton("Reconcile")).toBe("reconcile");
    expect(choiceForButton("Overwrite")).toBe("overwrite");
    expect(choiceForButton("Keep mine")).toBe("keep");
    expect(choiceForButton(undefined)).toBeNull();
  });
});

describe("decideLocalChanges", () => {
  const status = { deviations: SOLO };
  it("asks once with the prompt and maps the pick", async () => {
    const asked: Array<{ message: string; detail: string; buttons: string[] }> = [];
    const r = await decideLocalChanges(status, 57, async (message, detail, buttons) => { asked.push({ message, detail, buttons }); return "Keep mine"; });
    expect(r).toEqual({ cancelled: false, localChanges: "keep" });
    expect(asked).toEqual([deviationPrompt(SOLO, 57)]);
  });
  it("Cancel or Escape cancels", async () => {
    expect(await decideLocalChanges(status, 57, async () => undefined)).toEqual({ cancelled: true });
  });
  it("no deviations: no modal, and no explicit choice (the default install preserves what was kept)", async () => {
    let calls = 0;
    const r = await decideLocalChanges({ deviations: [] }, 57, async () => { calls++; return "Overwrite"; });
    expect(calls).toBe(0);
    expect(r).toEqual({ cancelled: false });
  });
});

describe("installCompletionMessage", () => {
  const base = { written: 120, hooksRegistered: true, tools: "skipped" as const, pending: [] as string[] };
  it("unchanged when nothing was staged", () => {
    expect(installCompletionMessage(base, 57)).toBe("Octobots: workflow pack installed (120 files) with session hooks.");
  });
  it("after Reconcile with the SessionStart hook registered", () => {
    expect(installCompletionMessage({ ...base, pending: ["mission-execution", "mission-completion-gate"] }, 57)).toBe(
      "Octobots: workflow pack installed (120 files) with session hooks. Staged mission-execution, mission-completion-gate for reconcile in .octobots/pack-updates/v57/. The next agent session will be asked to run the octobots-doctor skill.",
    );
  });
  it("adds that the hook is off when it is not registered", () => {
    expect(installCompletionMessage({ ...base, hooksRegistered: false, pending: ["mission-execution"] }, 57)).toBe(
      "Octobots: workflow pack installed (120 files). Staged mission-execution for reconcile in .octobots/pack-updates/v57/. The next agent session will be asked to run the octobots-doctor skill. The SessionStart hook is off, so ask your agent to run octobots-doctor.",
    );
  });
  it("keeps the tokenomics notes", () => {
    expect(installCompletionMessage({ ...base, hooksRegistered: false, tools: "installed" }, 57)).toBe("Octobots: workflow pack installed (120 files) with tokenomics CLI.");
    expect(installCompletionMessage({ ...base, hooksRegistered: false, tools: "failed" }, 57)).toBe(
      "Octobots: workflow pack installed (120 files). (the tokenomics CLI could not be downloaded — the npx fallback still works)",
    );
  });
});

describe("shouldPromptOnActivation", () => {
  const SHA = "a".repeat(64);
  const OTHER = "b".repeat(64);
  const st = (o: Partial<{ installed: boolean; upToDate: boolean; upToDateExceptLocal: boolean; deviations: Deviation[] }>) => ({
    installed: true, upToDate: false, upToDateExceptLocal: true, deviations: [] as Deviation[], ...o,
  });
  const entry = (skill: string, localSha256 = SHA) => ({
    skill, action: "reconcile" as const, localVersion: "57-local", localSha256, base: null, upstreamSha256: "c".repeat(64),
    retired: false, dir: `.octobots/pack-updates/v57/${skill}`,
  });
  const pendingRec = (o: Partial<PendingRecord>): PendingRecord => ({ packVersion: 57, skills: [], kept: [], ...o });
  const forkA = dev("mission-execution", "57-local", "label", false, SHA);

  it("false when everything is current", () => {
    expect(shouldPromptOnActivation(st({ upToDate: true }), null, 57)).toBe(false);
  });
  it("false when the only differences are newer skills", () => {
    expect(shouldPromptOnActivation(st({}), null, 57)).toBe(false);
  });
  it("true when the pack is not installed", () => {
    expect(shouldPromptOnActivation(st({ installed: false, upToDateExceptLocal: false }), null, 57)).toBe(true);
  });
  it("true when stale for a reason other than deviations", () => {
    expect(shouldPromptOnActivation(st({ upToDateExceptLocal: false, deviations: [forkA] }), pendingRec({ skills: [entry("mission-execution")] }), 57)).toBe(true);
  });
  it("false when the deviation is pending for this pack version with the same sha256", () => {
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), pendingRec({ skills: [entry("mission-execution")] }), 57)).toBe(false);
  });
  it("false when the deviation is kept for this pack version with the same sha256", () => {
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), pendingRec({ kept: [{ skill: "mission-execution", packVersion: 57, sha256: SHA }] }), 57)).toBe(false);
  });
  it("true for an unrecorded deviation, with or without a record", () => {
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), null, 57)).toBe(true);
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), pendingRec({}), 57)).toBe(true);
  });
  it("true for a new pack version", () => {
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), pendingRec({ packVersion: 57, skills: [entry("mission-execution")] }), 58)).toBe(true);
    expect(shouldPromptOnActivation(st({ deviations: [forkA] }), pendingRec({ kept: [{ skill: "mission-execution", packVersion: 57, sha256: SHA }] }), 58)).toBe(true);
  });
  it("true for a changed sha256", () => {
    expect(shouldPromptOnActivation(st({ deviations: [{ ...forkA, sha256: OTHER }] }), pendingRec({ skills: [entry("mission-execution")] }), 57)).toBe(true);
    expect(shouldPromptOnActivation(st({ deviations: [{ ...forkA, sha256: OTHER }] }), pendingRec({ kept: [{ skill: "mission-execution", packVersion: 57, sha256: SHA }] }), 57)).toBe(true);
  });
  it("true for a new deviation beside a recorded one", () => {
    const second = dev("mission-completion-gate", "57-local", "label", false, SHA);
    expect(shouldPromptOnActivation(st({ deviations: [forkA, second] }), pendingRec({ skills: [entry("mission-execution")] }), 57)).toBe(true);
  });
});

describe("the extension never starts an agent or copies a prompt", () => {
  const HOST = join(__dirname, "..", "src");
  const sources: Array<[string, string]> = [];
  const walk = (dir: string, rel = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== "webview") walk(join(dir, e.name), `${rel}${e.name}/`); }
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) sources.push([`${rel}${e.name}`, readFileSync(join(dir, e.name), "utf8")]);
    }
  };
  walk(HOST);
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it.each([
    ["clipboard", /clipboard/i],
    ["a chat command", /executeCommand\(\s*["'`][^"'`]*chat/i],
    ["a copilot/agent command", /executeCommand\(\s*["'`][^"'`]*(copilot|agent)/i],
  ])("src/ (outside the webview) has no %s", (_n, re) => {
    const hits = sources.filter(([, s]) => re.test(code(s))).map(([n]) => n);
    expect(hits).toEqual([]);
  });

  it("the install flow in extension.ts asks before the hooks and tools questions, then installs", () => {
    const ext = code(sources.find(([n]) => n === "extension.ts")![1]);
    const fn = ext.slice(ext.indexOf("async function installOctobotsPack"), ext.indexOf("export async function activate"));
    const ask = fn.indexOf("decideLocalChanges(");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(fn.indexOf("also install the session hooks"));
    expect(ask).toBeLessThan(fn.indexOf("install the tokenomics CLI"));
    expect(ask).toBeLessThan(fn.indexOf("installPack("));
    expect(fn).toMatch(/cancelled\)\s*return/);
    expect(ext).toMatch(/shouldPromptOnActivation\(/);
  });
});
