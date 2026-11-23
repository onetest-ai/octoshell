import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTokenomics } from "../src/host/octobots-tokenomics.js";
import { mkdtempClean } from "./fixtures/tmpdir.js";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "octobots-pack");

// The scripts a person runs. Before the fix, `run.mjs --help` ran a full collection and rewrote
// the ledgers (reported by coach-android on pack v60).
const SCRIPTS = [
  "run.mjs",
  "collect.mjs",
  "collect-codex.mjs",
  "rollup.mjs",
  "render.mjs",
  "verify.mjs",
  "update-prices.mjs",
  "backfill-worklog-sha.mjs",
  "selftest.mjs",
];

/** Every file under `dir` with its size and modification time, so any write shows up. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.push(`${p} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe("tokenomics scripts: --help", () => {
  for (const script of SCRIPTS) {
    for (const flag of ["--help", "-h"]) {
      it(`${script} ${flag} prints usage, exits 0 and writes nothing`, () => {
        const repo = mkdtempClean("tok-help-");
        installTokenomics(PACK, repo);
        const tok = join(repo, ".octobots", "tokenomics");
        const before = snapshot(repo);
        const r = spawnSync(process.execPath, [join(tok, script), flag], {
          cwd: repo,
          encoding: "utf8",
          timeout: 20_000,
          // An empty transcript root: if the guard is missing, collection finds nothing to read
          // but still writes its ledgers, which the snapshot catches.
          env: { ...process.env, HOME: repo, CLAUDE_CONFIG_DIR: join(repo, "no-claude"), CODEX_HOME: join(repo, "no-codex") },
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(new RegExp(`^Usage: node \\.octobots/tokenomics/${script.replace(".", "\\.")}`));
        expect(snapshot(repo)).toEqual(before);
      });
    }
  }
});
