import { describe, it, expect, vi, beforeEach } from "vitest";

const showErrorMessage = vi.fn();
const showWarningMessage = vi.fn();
const showInformationMessage = vi.fn();
vi.mock("vscode", () => ({
  window: { showErrorMessage, showWarningMessage, showInformationMessage },
}));

const { LEGACY_WORKFLOW_VIEW_TYPE, legacyWorkflowPanelSerializer } = await import("../src/host/panel-serializers.js");

function fakePanel(): { dispose: ReturnType<typeof vi.fn> } {
  return { dispose: vi.fn() };
}

describe("restored octoshell.workflow panel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the retired view type id", () => {
    expect(LEGACY_WORKFLOW_VIEW_TYPE).toBe("octoshell.workflow");
  });

  it("is disposed with no error notification, whatever state it carried", async () => {
    for (const state of [{ id: "folder:campaigns/a/workflows/w" }, undefined, null, "junk", {}]) {
      const panel = fakePanel();
      await expect(legacyWorkflowPanelSerializer.deserializeWebviewPanel(panel as never, state)).resolves.toBeUndefined();
      expect(panel.dispose).toHaveBeenCalledTimes(1);
    }
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not throw when the panel is already gone", async () => {
    const panel = { dispose: vi.fn(() => { throw new Error("disposed"); }) };
    await expect(legacyWorkflowPanelSerializer.deserializeWebviewPanel(panel as never, {})).resolves.toBeUndefined();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});
