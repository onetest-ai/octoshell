import type * as vscode from "vscode";

/**
 * The view type of the retired workflow editor. VS Code persists open webview panels across
 * restarts and asks the extension to restore each one by view type; a type nobody registers is shown
 * to the user as an error ("no editor registered"). So the type stays registered, with a serializer
 * whose only job is to close the stale tab.
 */
export const LEGACY_WORKFLOW_VIEW_TYPE = "octoshell.workflow";

export const legacyWorkflowPanelSerializer: vscode.WebviewPanelSerializer = {
  async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    try {
      panel.dispose();
    } catch {
      // Already gone: nothing to close, and nothing worth telling the user.
    }
  },
};
