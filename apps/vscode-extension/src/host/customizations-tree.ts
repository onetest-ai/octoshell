import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { CustomizationItem } from "@octoshell/customizations";

/** Narrow source the tree reads from — `BoardHost` satisfies it. */
export interface CustomizationsSource {
  listCustomizations(): CustomizationItem[];
}

type Node =
  | { kind: "group"; group: string }
  | { kind: "leaf"; name: string; filePath: string; group: string; provider: string };

export class CustomizationsTree implements vscode.TreeDataProvider<Node> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  /**
   * Cached scan results. `listCustomizations()` does a recursive workspace walk
   * (agents/skills/CLAUDE.md/settings live OUTSIDE `.octobots/`), so we walk at most
   * ONCE per refresh and reuse across the root + per-group `getChildren` calls.
   * `refresh()` invalidates it. The walk is NOT driven by board churn — only by an
   * explicit refresh (view becoming visible, or adding a customization).
   */
  private cache: CustomizationItem[] | null = null;
  constructor(
    private readonly board: CustomizationsSource,
    private readonly extensionPath: string,
  ) {}

  refresh(): void {
    this.cache = null;
    this._changed.fire();
  }

  private items(): CustomizationItem[] {
    if (this.cache === null) this.cache = this.board.listCustomizations();
    return this.cache;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.group, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "octoshell.group";
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.filePath);
    item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(node.filePath)] };
    item.contextValue = "octoshell.customization";
    const iconFile = join(this.extensionPath, "media", "providers", `${node.provider}.svg`);
    item.iconPath = existsSync(iconFile) ? vscode.Uri.file(iconFile) : new vscode.ThemeIcon("extensions");
    return item;
  }

  getChildren(node?: Node): Node[] {
    const items = this.items();
    if (!node) {
      const groups = [...new Set(items.map((i) => i.kind))];
      return groups.map((group) => ({ kind: "group", group }));
    }
    if (node.kind === "group") {
      return items
        .filter((i) => i.kind === node.group)
        .map((i) => ({ kind: "leaf", name: i.name, filePath: i.file.path, group: i.kind, provider: i.provider }));
    }
    return [];
  }
}
