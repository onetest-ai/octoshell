import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rpcArgs } from "../src/protocol/rpc-contract.js";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const pkg = JSON.parse(read("../package.json")) as {
  description: string;
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
  };
};

// The install command keeps its id (users may have it bound to a key); it is the one command id
// that still contains the word.
const KEPT_ID = "octoshell.installOctobotsWorkflowSkill";

describe("manifest has no workflow surface", () => {
  it("declares no workflow command", () => {
    const hits = pkg.contributes.commands.filter((c) => /workflow/i.test(c.command) && c.command !== KEPT_ID);
    expect(hits).toEqual([]);
    expect(pkg.contributes.commands.filter((c) => /workflow/i.test(c.title))).toEqual([]);
  });

  it("declares no workflow menu entry or context value", () => {
    const entries = Object.values(pkg.contributes.menus).flat();
    expect(entries.filter((m) => /workflow/i.test(m.command) && m.command !== KEPT_ID)).toEqual([]);
    expect(entries.filter((m) => /workflow/i.test(m.when ?? ""))).toEqual([]);
  });

  it("keeps the install command id and retitles it", () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === KEPT_ID);
    expect(cmd?.title).toBe("Octobots: Install Octobots Pack");
    expect(pkg.description).toMatch(/Octobots pack/);
    expect(pkg.description).not.toMatch(/workflow pack/i);
  });

  it("the RPC contract has no workflow:* method and BindMessage.kind has no workflow", () => {
    expect(Object.keys(rpcArgs).filter((m) => m.startsWith("workflow:"))).toEqual([]);
    const events = read("../src/protocol/host-events.ts");
    const bind = /export type BindMessage = \{[^}]*?kind: ([^;]+);/.exec(events)?.[1] ?? "";
    expect(bind).toContain('"campaign"');
    expect(bind).not.toMatch(/workflow/i);
  });
});
