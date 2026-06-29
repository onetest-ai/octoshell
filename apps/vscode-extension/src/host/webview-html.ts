import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

export function buildWebviewHtml(webview: vscode.Webview, mediaPath: string): string {
  const indexPath = join(mediaPath, "index.html");
  let html: string;
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    // The vite-emitted index.html only exists after a build (and at the real extension
    // media path). Under unit tests (synthetic extensionPath) it's absent — fall back to a
    // minimal shell so webview-host wiring can still be exercised.
    console.warn(
      `[octoshell] webview index.html not found — falling back to empty shell (run \`pnpm --filter @octoshell/vscode-extension build\`): ${indexPath}`,
    );
    html = "<!doctype html><html><head></head><body></body></html>";
  }
  const mediaUri = webview.asWebviewUri(vscode.Uri.file(mediaPath));
  // Vite emitted relative ("./assets/...") URLs; point them at the webview media root.
  html = html.replace(/(href|src)="\.\/?/g, `$1="${mediaUri.toString()}/`);
  // Strip crossorigin — webview-resource module scripts fail to load with it set.
  html = html.replace(/\s+crossorigin/g, "");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
  ].join("; ");
  html = html.replace(
    "<head>",
    `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  return html;
}
