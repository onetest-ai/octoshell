// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { resolveBound } from "../src/webview/chat-entry.js";

describe("resolveBound", () => {
  it("maps campaign/mission/task binds unchanged", () => {
    expect(resolveBound({ type: "bind", kind: "campaign", id: "x" })).toEqual({ kind: "campaign", id: "x" });
    expect(resolveBound({ type: "bind", kind: "mission", id: "y" })).toEqual({ kind: "mission", id: "y" });
    expect(resolveBound({ type: "bind", kind: "task", id: "z" })).toEqual({ kind: "task", id: "z" });
  });
  it("maps a bug bind", () => {
    expect(resolveBound({ type: "bind", kind: "bug", id: "bug1" })).toEqual({ kind: "bug", id: "bug1" });
  });
  it("defaults unknown/missing kind to none", () => {
    expect(resolveBound(undefined)).toEqual({ kind: "none" });
    expect(resolveBound({ type: "bind" })).toEqual({ kind: "none" });
  });
});
