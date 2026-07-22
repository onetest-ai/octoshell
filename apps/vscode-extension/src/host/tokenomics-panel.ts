import { join } from "node:path";
import * as vscode from "vscode";
import { dispatch, type DispatchCtx } from "./rpc-dispatcher.js";
import { buildWebviewHtml } from "./webview-html.js";

export const TOKENOMICS_VIEW_TYPE = "octoshell.tokenomics";

/**
 * A single tokenomics tab for the workspace.
 *
 * Unlike the entity panels there is only ever one — the report covers the whole
 * board, so a second tab would show the same thing. Reopening reveals the
 * existing tab instead of stacking duplicates.
 */
export class TokenomicsPanel {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ctx: DispatchCtx,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const mediaPath = join(this.context.extensionPath, "media");
    const panel = vscode.window.createWebviewPanel(
      TOKENOMICS_VIEW_TYPE,
      "Tokenomics",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(mediaPath)],
      },
    );
    this.panel = panel;
    panel.webview.html = buildWebviewHtml(panel.webview, mediaPath);

    const sub = panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      const m = msg as { type?: string; id?: number; method?: string; args?: unknown };
      if (m?.type !== "rpc:call" || typeof m.id !== "number" || !m.method) return;
      try {
        const value = await dispatch(m.method, m.args, this.ctx);
        void panel.webview.postMessage({ type: "rpc:result", id: m.id, ok: true, value });
      } catch (err) {
        void panel.webview.postMessage({
          type: "rpc:result",
          id: m.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Tell the shared webview bundle which view to mount.
    void panel.webview.postMessage({ type: "bind", kind: "tokenomics" });

    panel.onDidDispose(() => {
      sub.dispose();
      this.panel = null;
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
