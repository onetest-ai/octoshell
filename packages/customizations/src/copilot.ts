import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { firstHeadingOrLine } from "./text.js";
import type { CustomizationItem, ProviderReader, ReaderContext } from "./types.js";

const PROVIDER = "github-copilot-cli";

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * GitHub Copilot CLI is sparser: project instructions only in v1.
 * MCP config path for Copilot CLI is not yet confirmed — left out rather than guessed
 * (spec: "ship instructions-only for Copilot in v1 and log the gap rather than guess").
 */
export const copilotReader: ProviderReader = {
  id: PROVIDER,
  read(ctx: ReaderContext): CustomizationItem[] {
    const items: CustomizationItem[] = [];
    const candidates = [
      { rel: ".github/copilot-instructions.md", abs: join(ctx.projectDir, ".github", "copilot-instructions.md") },
      { rel: "AGENTS.md", abs: join(ctx.projectDir, "AGENTS.md") },
    ];
    for (const c of candidates) {
      if (!existsSync(c.abs)) continue;
      items.push({
        id: `${PROVIDER}:instruction:project:${c.rel}:`,
        kind: "instruction", provider: PROVIDER, scope: "project",
        name: c.rel, description: firstHeadingOrLine(read(c.abs)),
        location: "", file: { path: c.abs, format: "md" }, editable: true,
      });
    }
    return items;
  },
};
