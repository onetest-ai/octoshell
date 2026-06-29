// Minimal `vscode` stub so host modules that statically `import * as vscode from "vscode"`
// can be loaded under vitest (node env). Only the surface our unit tests need is stubbed;
// the real API is injected at runtime by the extension host. Pure planners (e.g.
// planSettingsSync) never touch this — it only exists to satisfy module resolution.
export const workspace = {
  getConfiguration() {
    return {
      get<T>(_key: string, defaultValue?: T): T {
        return defaultValue as T;
      },
    };
  },
};

export const Uri = {
  file(fsPath: string): { fsPath: string; toString(): string } {
    return { fsPath, toString: () => `file://${fsPath}` };
  },
};

// Minimal TreeDataProvider surface for tree unit tests.
export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
  description?: string;
  tooltip?: string;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  constructor(
    public readonly label: string,
    public readonly collapsibleState?: number,
  ) {}
}

export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: unknown) {}
}
