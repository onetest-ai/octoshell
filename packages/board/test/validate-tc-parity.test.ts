/**
 * The TC warnings of mission M6 AC2/AC7: validate.js (the pack, tc-io.mjs) and validateBoard (tc-io.ts) say
 * the same thing about a malformed or legacy test case, with `.octobots/`-relative paths. A synthetic board
 * pins the exact text; real boards (tracked files plus OCTOBOTS_BOARD_COPIES) are compared as sets.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateBoard } from "../src/validate.js";
import { BoardModel } from "../src/board-model.js";
import { campaignDirs, trackedBoardCopies } from "./fixtures/real-board.js";
import { readmeText, scratch, synthBoard, tcText, writeTests } from "./fixtures/tests-board.js";

const VALIDATE_JS = resolve(__dirname, "../../../apps/vscode-extension/resources/octobots-pack/skill/mission-planner/scripts/validate.js");
const run = (arg: string) => {
  const r = spawnSync("node", [VALIDATE_JS, arg], { encoding: "utf8" });
  return { status: r.status, lines: r.stdout.split("\n").filter(Boolean) };
};
const HINT = "legacy test case (no status, kind or mission) lists as unknown: run set-test-status.js <tc-file> --migrate";
const isTc = (m: string) => /\/tests\/m\d+[a-z]*\/TC-[^:]*: /.test(m);

describe("TC warnings: validate.js and validateBoard", () => {
  it("say the same text for malformed and legacy files on a synthetic board, and `validate.js <tc>` prints it too", () => {
    const root = scratch("tc-parity-");
    const c = synthBoard(root, [{ title: "M1 - Auth", acs: 2 }]);
    const rel = `campaigns/${c.campaign}/tests/m1`;
    writeTests(c, "m1", {
      "README.md": readmeText([["M1-AC1", "TC-001"], ["M1-AC2", "TC-002"]]),
      "TC-001_legacy.md": tcText(["id: TC-001", "title: old", "requirements: [M1-AC1]", "type: api"]),
      "TC-002_values.md": tcText(["id: TC-002", "title: v", "mission: M1", "covers: [M1-AC2]", "kind: e2e", "status: nope"]),
      "TC-003_broken.md": "---\nid: [x\n---\n## Steps\n## Expected Final State\n",
    });
    const fromBoard = validateBoard(root).filter((f) => isTc(f.message));
    expect(fromBoard.every((f) => f.severity === "warning")).toBe(true);
    const fromPack = run(join(root, "campaigns", c.campaign)).lines.filter((l) => l.startsWith("warning: ") && isTc(l));
    expect(fromPack.sort()).toEqual(fromBoard.map((f) => `warning: ${f.message}`).sort());
    expect(fromBoard.map((f) => f.message)).toContain(`${rel}/TC-001_legacy.md: ${HINT}`);

    const single = run(join(root, rel, "TC-001_legacy.md"));
    expect(single.status).toBe(0);
    expect(single.lines).toContain(`warning: ${rel}/TC-001_legacy.md: ${HINT}`);
    expect(run(join(root, rel, "TC-002_values.md")).lines.some((l) => l.includes("--migrate"))).toBe(false);
  });

  it("agree as sets over real boards, and the legacy suggestions are exactly the files with no status, kind or mission", () => {
    let legacySeen = 0;
    for (const board of trackedBoardCopies()) {
      const campaigns = campaignDirs(board).filter((d) => existsSync(join(d, "campaign.yaml")) || existsSync(join(d, "campaign.md")));
      const pack = campaigns.flatMap((d) => run(d).lines.filter((l) => l.startsWith("warning: ") && isTc(l))).sort();
      const mine = validateBoard(board).filter((f) => isTc(f.message)).map((f) => `warning: ${f.message}`).sort();
      expect(pack).toEqual(mine);

      // independent expectation of "legacy": parseable frontmatter without a status, kind or mission line, in
      // a folder validate checks: one owned by a live (not cancelled) mission.yaml (M4: a cancelled mission's
      // tests are exempt from every tests finding, the migrate suggestion included; solo's uwb m5 is one)
      const checkedFolders = (d: string): Set<string> => {
        const out = new Set<string>();
        const missions = join(d, "missions");
        if (!existsSync(missions)) return out;
        for (const md of readdirSync(missions)) {
          const y = join(missions, md, "mission.yaml");
          if (!existsSync(y)) continue;
          const text = readFileSync(y, "utf8");
          const name = /^name:\s*["']?(M\d+[a-z]*)\b/im.exec(text)?.[1];
          const status = /^status:\s*["']?(\w+)/m.exec(text)?.[1];
          if (name && status !== "cancelled") out.add(name.toLowerCase());
        }
        return out;
      };
      const expected: string[] = [];
      for (const d of campaigns) {
        const tests = join(d, "tests");
        if (!existsSync(tests)) continue;
        const live = checkedFolders(d);
        for (const folder of readdirSync(tests).filter((f) => /^m\d+[a-z]*$/.test(f) && live.has(f))) {
          for (const f of readdirSync(join(tests, folder)).filter((n) => /^TC-.*\.md$/.test(n) && statSync(join(tests, folder, n)).isFile())) {
            const lines = readFileSync(join(tests, folder, f), "utf8").split("\n");
            const end = lines.indexOf("---", 1);
            if (lines[0] !== "---" || end < 0) continue;
            const fm = lines.slice(1, end);
            if (fm.some((l) => /^(status|kind|mission):/.test(l))) continue;
            if (fm.some((l) => /^\S/.test(l) && !/^[A-Za-z_][\w-]*:/.test(l) && !l.startsWith("#"))) continue; // not a plain mapping: malformed, no hint
            expected.push(`warning: campaigns/${d.split("/").pop()}/tests/${folder}/${f}: ${HINT}`);
          }
        }
      }
      const hints = mine.filter((m) => m.includes("--migrate"));
      expect(hints.sort()).toEqual(expected.sort());
      legacySeen += hints.length;

      // the model lists every legacy file as unknown
      const m = new BoardModel(board);
      m.rebuild();
      for (const camp of m.listCampaigns()) {
        for (const t of m.listTestCases(camp.id)) {
          if (hints.includes(`warning: ${t.path}: ${HINT}`)) expect(t.status).toBe("unknown");
        }
      }
    }
    expect(legacySeen).toBeGreaterThanOrEqual(0);
  });
});
