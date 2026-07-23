import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { launchSdlcBundleInstall } from "../src/host/sdlc-bundles-command.js";
import { FALLBACK_BUNDLES } from "../src/host/sdlc-bundles.js";

/** A terminal whose sendText/show are spies, returned from a stubbed createTerminal. */
function spyTerminal(): { sendText: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> } {
  return { sendText: vi.fn(), show: vi.fn() };
}

afterEach(() => vi.restoreAllMocks());

describe("launchSdlcBundleInstall — the mission's end-to-end behaviour", () => {
  it("with no workspace folder: shows an error and opens no terminal", async () => {
    const err = vi.spyOn(vscode.window, "showErrorMessage");
    const term = vi.spyOn(vscode.window, "createTerminal");
    const pick = vi.spyOn(vscode.window, "showQuickPick");

    await launchSdlcBundleInstall(undefined, false, { fetchCatalog: async () => FALLBACK_BUNDLES });

    expect(err).toHaveBeenCalledOnce();
    expect(pick).not.toHaveBeenCalled();
    expect(term).not.toHaveBeenCalled();
  });

  it("install path: launches `init --bundle <id>` with NO --update", async () => {
    const t = spyTerminal();
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ id: "manual-qa" } as never);

    await launchSdlcBundleInstall("/repo", false, { fetchCatalog: async () => FALLBACK_BUNDLES });

    expect(t.sendText).toHaveBeenCalledWith("npx github:arozumenko/sdlc-skills init --bundle manual-qa");
    expect(t.show).toHaveBeenCalledOnce();
  });

  it("update path: the same bundle launches with --update appended", async () => {
    const t = spyTerminal();
    vi.spyOn(vscode.window, "createTerminal").mockReturnValue(t as unknown as vscode.Terminal);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue({ id: "manual-qa" } as never);

    await launchSdlcBundleInstall("/repo", true, { fetchCatalog: async () => FALLBACK_BUNDLES });

    expect(t.sendText).toHaveBeenCalledWith(
      "npx github:arozumenko/sdlc-skills init --bundle manual-qa --update",
    );
  });

  it("offline/failed catalog: the QuickPick still lists the three fallback bundles", async () => {
    const pick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined as never);
    // Simulate the catalog fetch degrading to the fallback list (what fetchBundleCatalog returns offline).
    await launchSdlcBundleInstall("/repo", false, { fetchCatalog: async () => FALLBACK_BUNDLES });

    expect(pick).toHaveBeenCalledOnce();
    const items = pick.mock.calls[0]![0] as Array<{ id: string; label: string }>;
    expect(items.map((i) => i.id)).toEqual(["feature-development", "manual-qa", "test-automation"]);
  });

  it("cancelled QuickPick: opens no terminal", async () => {
    const term = vi.spyOn(vscode.window, "createTerminal");
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined as never);

    await launchSdlcBundleInstall("/repo", false, { fetchCatalog: async () => FALLBACK_BUNDLES });

    expect(term).not.toHaveBeenCalled();
  });
});
