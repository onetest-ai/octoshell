import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const pkg = JSON.parse(read("../package.json")) as { activationEvents?: string[] };

/** Every `export const X_VIEW_TYPE = "…"` declared in the host sources, as name -> view type. */
function viewTypeConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of ["../src/host/entity-panel-manager.ts", "../src/host/panel-serializers.ts", "../src/host/tokenomics-panel.ts"]) {
    for (const m of read(rel).matchAll(/export const (\w+_VIEW_TYPE) = "([^"]+)"/g)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** The view types extension.ts registers a WebviewPanelSerializer for. */
function serializedViewTypes(): string[] {
  const consts = viewTypeConstants();
  const src = read("../src/extension.ts");
  return [...src.matchAll(/registerWebviewPanelSerializer\(\s*(\w+)/g)].map((m) => {
    const vt = consts.get(m[1]!);
    if (!vt) throw new Error(`unresolved view type constant ${m[1]}`);
    return vt;
  });
}

// VS Code restores a persisted webview tab by firing `onWebviewPanel:<viewType>`, and only activates
// extensions that DECLARE that event (it is not one of the implicit activation events). Without it, a
// restored tab stays blank until something else happens to activate the extension, so the legacy
// workflow serializer would never get the chance to close the stale tab.
describe("restored webview panels activate the extension", () => {
  it("registers a serializer for the retired octoshell.workflow view type", () => {
    expect(serializedViewTypes()).toContain("octoshell.workflow");
  });

  it("declares onWebviewPanel:<viewType> for every view type it restores", () => {
    const declared = pkg.activationEvents ?? [];
    const missing = serializedViewTypes().filter((vt) => !declared.includes(`onWebviewPanel:${vt}`));
    expect(missing).toEqual([]);
  });
});
