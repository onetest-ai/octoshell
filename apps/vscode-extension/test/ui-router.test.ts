import { describe, it, expect, vi } from "vitest";
import { routeUiMessage, type UiActions } from "../src/protocol/ui-messages.js";

describe("routeUiMessage", () => {
  it("dispatches a valid message to the matching action", () => {
    const openMission = vi.fn();
    const actions: UiActions = { openMission };
    const handled = routeUiMessage({ type: "openMission", id: "m1" }, actions);
    expect(handled).toBe(true);
    expect(openMission).toHaveBeenCalledWith({ type: "openMission", id: "m1" });
  });

  it("returns true but no-ops when a valid type has no registered handler", () => {
    const handled = routeUiMessage({ type: "openBug", id: "bug1" }, {});
    expect(handled).toBe(true);
  });

  it("returns false for a non-UI message (lets rpc/handshake fall through)", () => {
    expect(routeUiMessage({ type: "rpc", id: 1, method: "x" }, {})).toBe(false);
    expect(routeUiMessage({ type: "webview-ready" }, {})).toBe(false);
    expect(routeUiMessage(null, {})).toBe(false);
  });

  it("returns false for a malformed UI message (missing required field) — never dispatches", () => {
    const openMission = vi.fn();
    const handled = routeUiMessage({ type: "openMission" }, { openMission });
    expect(handled).toBe(false);
    expect(openMission).not.toHaveBeenCalled();
  });

  it("routes bug UI messages (openBug, deleteBug, newBugInMission)", () => {
    const openBug = vi.fn();
    const deleteBug = vi.fn();
    const newBugInMission = vi.fn();
    expect(routeUiMessage({ type: "openBug", id: "bug1" }, { openBug })).toBe(true);
    expect(openBug).toHaveBeenCalledWith({ type: "openBug", id: "bug1" });
    expect(routeUiMessage({ type: "deleteBug", bugId: "bug1" }, { deleteBug })).toBe(true);
    expect(deleteBug).toHaveBeenCalledWith({ type: "deleteBug", bugId: "bug1" });
    expect(routeUiMessage({ type: "newBugInMission", id: "m1" }, { newBugInMission })).toBe(true);
    expect(newBugInMission).toHaveBeenCalledWith({ type: "newBugInMission", id: "m1" });
  });
});
