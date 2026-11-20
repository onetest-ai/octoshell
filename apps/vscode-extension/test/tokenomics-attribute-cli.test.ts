import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const pack = join(__dirname, "../resources/octobots-pack");

it.each(["missing board", "missing YAML parser"])("attribute exits nonzero with one stderr line for %s", (failure) => {
  const dir = mkdtempClean("attribute-failure-");
  // Run an installed copy away from the repo's node_modules so a missing parser is real.
  cpSync(join(pack, "tokenomics"), join(dir, "cli"), { recursive: true });
  if (failure === "missing YAML parser") {
    const campaign = join(dir, ".octobots/campaigns/demo");
    mkdirSync(join(campaign, "missions/m1"), { recursive: true });
    writeFileSync(join(campaign, "campaign.yaml"), "name: Demo\n");
    writeFileSync(join(campaign, "missions/m1/mission.yaml"), "name: M1 - Work\n");
  }
  const r = spawnSync(process.execPath, [join(dir, "cli/attribute.mjs"), "--branch", "main", "--project-dir", dir], {
    encoding: "utf8", cwd: pack,
  });
  expect.soft(r.status).not.toBe(0);
  expect.soft(r.stdout).toBe("");
  expect(r.stderr.trim().split("\n")).toHaveLength(1);
  expect(r.stderr).toMatch(/^attribute: /);
  expect(r.stderr).toMatch(failure === "missing board" ? /campaigns/ : /YAML parser/);
});
