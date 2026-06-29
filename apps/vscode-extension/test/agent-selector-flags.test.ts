import { describe, expect, it } from "vitest";
import { resolveAgentSelectorFlags, AGENT_SELECTOR_DEFAULTS } from "../src/host/agent-selector-flags.js";

describe("resolveAgentSelectorFlags", () => {
  const ids = ["claude-acp", "github-copilot-cli", "codex-acp"];

  it("applies per-provider defaults when no override is set", () => {
    expect(resolveAgentSelectorFlags(ids, () => undefined)).toEqual({
      "claude-acp": true,
      "github-copilot-cli": false,
      "codex-acp": false,
    });
  });

  it("honors an explicit override over the default", () => {
    const flags = resolveAgentSelectorFlags(ids, (id) => (id === "codex-acp" ? true : undefined));
    expect(flags["codex-acp"]).toBe(true);
    expect(flags["claude-acp"]).toBe(true);
  });

  it("respects an explicit false override on a true-default provider", () => {
    expect(resolveAgentSelectorFlags(["claude-acp"], () => false)["claude-acp"]).toBe(false);
  });

  it("defaults an unknown provider to true (shown)", () => {
    expect(resolveAgentSelectorFlags(["some-custom-agent"], () => undefined)["some-custom-agent"]).toBe(true);
  });

  it("exposes the defaults map", () => {
    expect(AGENT_SELECTOR_DEFAULTS["codex-acp"]).toBe(false);
    expect(AGENT_SELECTOR_DEFAULTS["claude-acp"]).toBe(true);
  });
});
