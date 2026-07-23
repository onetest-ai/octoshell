import * as vscode from "vscode";
import { fetchBundleCatalog, bundleInstallCommand, type Bundle } from "./sdlc-bundles.js";

/**
 * Thin launcher behind the "Octobots: Install / Update SDLC Team Bundle" commands. Picks a bundle
 * (from the hybrid catalog, which degrades to the offline fallback list) and opens an integrated
 * terminal running the sdlc-skills installer, which owns the guided, interactive flow — Octobots
 * never captures output or verifies the result. `update` appends `--update`.
 *
 * `deps.fetchCatalog` is injectable so the command can be unit-tested without hitting the network.
 */
export async function launchSdlcBundleInstall(
  repoRoot: string | undefined,
  update: boolean,
  deps: { fetchCatalog?: () => Promise<Bundle[]> } = {},
): Promise<void> {
  if (!repoRoot) {
    void vscode.window.showErrorMessage("Octobots: open a workspace folder first.");
    return;
  }
  const bundles = await (deps.fetchCatalog ?? fetchBundleCatalog)();
  const pick = await vscode.window.showQuickPick(
    bundles.map((b) => ({ label: b.label, description: b.id, detail: b.description, id: b.id })),
    { placeHolder: update ? "Update which SDLC team bundle?" : "Install which SDLC team bundle?" },
  );
  if (!pick) return;
  const terminal = vscode.window.createTerminal({ cwd: repoRoot, name: "SDLC Bundle Install" });
  terminal.sendText(bundleInstallCommand(pick.id, { update }));
  terminal.show();
}
