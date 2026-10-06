import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rpcArgs } from "../src/protocol/rpc-contract.js";
import { handlerMethods } from "../src/host/rpc-dispatcher.js";

// The drift guard. This file is the reason the typed-protocol seam exists: it fails loudly the
// moment the dispatcher handler map, the shim, or the entity views diverge from the contract —
// the exact silent drift that previously let dead shim methods throw "unknown method" at runtime.

const contractMethods = Object.keys(rpcArgs).sort();

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("RPC contract drift guard", () => {
  it("every contract method has a dispatcher handler, and vice-versa", () => {
    expect([...handlerMethods].sort()).toEqual(contractMethods);
  });

  it("every method the shim calls exists in the contract (no runtime 'unknown method')", () => {
    const shim = read("../src/webview/octoshell-shim.ts");
    // The shim aliases `const c = rpc.call` and invokes `c("method", ...)`.
    const called = [...shim.matchAll(/\bc\("([a-zA-Z:]+)"/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    expect(called.filter((m) => !(m in rpcArgs))).toEqual([]);
  });

  it("every method the entity views call exists in the contract", () => {
    // sessions-panel.tsx is deliberately excluded: it calls rpc.call(method, …) with `method` as a
    // runtime prop (the three *:sessions methods), so a literal-method regex scan cannot apply.
    const files = [
      "../src/webview/campaign-view.tsx",
      "../src/webview/mission-view.tsx",
      "../src/webview/task-view.tsx",
      "../src/webview/bug-view.tsx",
      "../src/webview/test-case-view.tsx",
    ];
    const called = files.flatMap((f) =>
      [...read(f).matchAll(/rpc\.call\("([a-zA-Z:]+)"/g)].map((m) => m[1]),
    );
    expect(called.length).toBeGreaterThan(0);
    expect(called.filter((m) => !(m in rpcArgs))).toEqual([]);
  });
});

describe("tests:* RPC contract schemas (M6 T6.3)", () => {
  it("declares tests:list, tests:coverage and tests:summary, each with a handler", () => {
    for (const m of ["tests:list", "tests:coverage", "tests:summary"]) {
      expect(m in rpcArgs, m).toBe(true);
      expect(handlerMethods, m).toContain(m);
    }
  });

  it("tests:list takes a campaign id and an optional mission folder token", () => {
    const a = rpcArgs["tests:list"];
    expect(a.safeParse({ campaignId: "c1" }).success).toBe(true);
    for (const mission of ["m2", "M2", "2", "3b", "M10"]) expect(a.safeParse({ campaignId: "c1", mission }).success, mission).toBe(true);
    for (const mission of ["", "../x", "m2/..", "m", "mission", "m12345", "m2 ", 2]) expect(a.safeParse({ campaignId: "c1", mission }).success, String(mission)).toBe(false);
    for (const campaignId of ["", undefined, 7, "x".repeat(201)]) expect(a.safeParse({ campaignId }).success, String(campaignId)).toBe(false);
  });

  it("tests:coverage and tests:summary require a non-empty string id", () => {
    expect(rpcArgs["tests:coverage"].safeParse({ missionId: "m1" }).success).toBe(true);
    expect(rpcArgs["tests:coverage"].safeParse({ missionId: "" }).success).toBe(false);
    expect(rpcArgs["tests:coverage"].safeParse({}).success).toBe(false);
    expect(rpcArgs["tests:summary"].safeParse({ campaignId: "c1" }).success).toBe(true);
    expect(rpcArgs["tests:summary"].safeParse({ campaignId: 3 }).success).toBe(false);
  });
});

describe("tests:get and tests:setStatus schemas (T1.2)", () => {
  const base = { status: "ready", lastRun: null };
  const set = rpcArgs["tests:setStatus"];
  const path = "campaigns/c/tests/m1/TC-001_x.md";

  it("declares both, each with a handler", () => {
    for (const m of ["tests:get", "tests:setStatus"]) {
      expect(m in rpcArgs, m).toBe(true);
      expect(handlerMethods, m).toContain(m);
    }
  });

  it("tests:get requires a non-empty string path", () => {
    const a = rpcArgs["tests:get"];
    expect(a.safeParse({ path }).success).toBe(true);
    for (const p of ["", undefined, 7, null, "x".repeat(2001)]) expect(a.safeParse({ path: p }).success, String(p)).toBe(false);
    expect(a.safeParse({}).success).toBe(false);
  });

  it("tests:setStatus accepts every settable status and base.status unknown", () => {
    for (const status of ["draft", "ready", "pass", "fail", "blocked"]) expect(set.safeParse({ path, status, base }).success, status).toBe(true);
    for (const bs of ["draft", "ready", "pass", "fail", "blocked", "unknown"]) expect(set.safeParse({ path, status: "pass", base: { status: bs, lastRun: null } }).success, bs).toBe(true);
  });

  it("tests:setStatus rejects status unknown and any non-settable word", () => {
    for (const status of ["unknown", "passed", "PASS", "", "skipped", "done", 3, null, undefined]) expect(set.safeParse({ path, status, base }).success, String(status)).toBe(false);
    for (const bs of ["", "passed", "skipped", 3, undefined]) expect(set.safeParse({ path, status: "pass", base: { status: bs, lastRun: null } }).success, String(bs)).toBe(false);
  });

  it("tests:setStatus requires a path and a base, whose lastRun is null or {date, evidence?}", () => {
    expect(set.safeParse({ status: "pass", base }).success).toBe(false);
    expect(set.safeParse({ path: "", status: "pass", base }).success).toBe(false);
    expect(set.safeParse({ path, status: "pass" }).success).toBe(false);
    expect(set.safeParse({ path, status: "pass", base: { status: "ready" } }).success).toBe(false);
    expect(set.safeParse({ path, status: "pass", base: { status: "fail", lastRun: { date: "2026-10-06" } } }).success).toBe(true);
    expect(set.safeParse({ path, status: "pass", base: { status: "fail", lastRun: { date: "2026-10-06", evidence: ".octobots/r.md" } } }).success).toBe(true);
    expect(set.safeParse({ path, status: "pass", base: { status: "fail", lastRun: { evidence: "x" } } }).success).toBe(false);
    expect(set.safeParse({ path, status: "pass", base: { status: "fail", lastRun: "2026-10-06" } }).success).toBe(false);
  });

  it("never takes file text: an injected `text` or `content` key is stripped", () => {
    const parsed = set.parse({ path, status: "pass", base, text: "---\n---", content: "x" });
    expect(Object.keys(parsed).sort()).toEqual(["base", "path", "status"]);
  });
});
