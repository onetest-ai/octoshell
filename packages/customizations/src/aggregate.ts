import { claudeCodeReader } from "./claude-code.js";
import { copilotReader } from "./copilot.js";
import type { CustomizationItem, ProviderReader, ReaderContext } from "./types.js";

const READERS: ProviderReader[] = [claudeCodeReader, copilotReader];

/** Run every enabled provider's reader; resilient — one reader throwing doesn't sink the rest. */
export function readCustomizations(ctx: ReaderContext, enabledProviderIds: string[]): CustomizationItem[] {
  const enabled = new Set(enabledProviderIds);
  const out: CustomizationItem[] = [];
  for (const r of READERS) {
    if (!enabled.has(r.id)) continue;
    try {
      out.push(...r.read(ctx));
    } catch {
      // best-effort: a broken reader contributes nothing
    }
  }
  return out;
}
