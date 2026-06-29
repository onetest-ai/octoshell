export type CustomizationKind = "agent" | "skill" | "instruction" | "hook" | "mcp";

export type FileFormat = "md" | "toml" | "json" | "text";

export interface CustomizationItem {
  id: string;
  kind: CustomizationKind;
  provider: string;
  scope: "project" | "user";
  name: string;
  description?: string;
  location?: string;
  file: { path: string; format: FileFormat };
  locator?: { key: string };
  editable: boolean;
  paths?: string;
}

export interface ReaderContext {
  projectDir: string;
  claudeConfigDir: string;
  homeDir: string;
  skipDirs: Set<string>;
  maxItems?: number;
}

export interface ProviderReader {
  readonly id: string;
  read(ctx: ReaderContext): CustomizationItem[];
}

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "out", ".turbo", ".next", "coverage",
]);

export const DEFAULT_MAX_ITEMS = 1000;
