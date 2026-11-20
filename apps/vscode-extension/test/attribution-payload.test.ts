import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

it("verifies the generated attribution pack twin is current", () => {
  const r = spawnSync(process.execPath, [join(__dirname, "../scripts/attribution-payload.mjs"), "--verify"], {
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
});
