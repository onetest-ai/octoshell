// M6 T6.4: the mission panel's Tests section and AC coverage view (mission AC4), over real board data.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MissionView } from "../src/webview/mission-view.js";
import { realRpc, type RealRpc } from "./fixtures/real-rpc.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";
import { TEST_STATUS_ORDER } from "../src/protocol/index.js";

afterEach(cleanup);

const CAMPAIGN = "direct-dispatch-process";
const noop = (): void => {};

function missionFor(r: RealRpc, token: string) {
  const camp = r.board.listCampaigns().find((c) => c.folderPath.endsWith(CAMPAIGN))!;
  const mission = r.board.listMissions(camp.id).find((m) => new RegExp(`^${token}\\b`, "i").test(m.title))!;
  return { camp, mission, dir: join(r.octo, camp.folderPath, "tests", token.toLowerCase()) };
}

function show(r: RealRpc, missionId: string, onOpenTestCase: (p: string) => void = noop) {
  return render(
    <MissionView id={missionId} rpc={r.rpc} onOpenTask={noop} onOpenBug={noop} onNewTask={noop} onDeleteTask={noop}
      onOpenDoc={noop} onAddLink={noop} onAttachFile={noop} onOpenFile={noop} onOpenTestCase={onOpenTestCase} />,
  );
}

const tcText = (id: string, status: string | null, covers: string): string =>
  ["---", `id: ${id}`, `title: case ${id}`, "mission: M6", `covers: [${covers}]`, "kind: unit", ...(status ? [`status: ${status}`] : []), "---", "", `# ${id}`, ""].join("\n");

describe("mission panel: Tests section", () => {
  it("lists the real mission's TCs, each with its status as text and an Open button", async () => {
    const r = realRpc();
    const { camp, mission, dir } = missionFor(r, "M6");
    // Mixed statuses, as the board has once QA writes results back (T6.5): the rows follow the status order, ids
    // in file order within a status. Comparing against raw listTests order only held while every TC was draft.
    const files = readdirSync(dir).filter((f) => /^TC-.*\.md$/.test(f)).sort();
    const mix = ["ready", "pass", "fail", "draft", "blocked", "pass"];
    files.forEach((f, i) => {
      const text = readFileSync(join(dir, f), "utf8");
      if (/^status:/m.test(text)) writeFileSync(join(dir, f), text.replace(/^status:.*$/m, `status: ${mix[i % mix.length]}`));
    });
    r.board.reconcile();
    const listed = r.board.listTests(camp.id, "M6");
    const expected = TEST_STATUS_ORDER.flatMap((s) => listed.filter((t) => t.status === s));
    expect(expected.length).toBeGreaterThan(5);
    expect(new Set(expected.map((t) => t.status)).size).toBeGreaterThan(2);
    show(r, mission.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    const rows = await within(section).findAllByTestId("tc-row");
    expect(rows).toHaveLength(expected.length);
    for (const [i, tc] of expected.entries()) {
      const row = rows[i]!;
      expect(row.getAttribute("data-status")).toBe(tc.status);
      expect(row.textContent).toContain(tc.id);
      expect(within(row).getByText(tc.status)).toBeTruthy(); // status as text, not colour alone
      expect(within(row).getByRole("button", { name: new RegExp(`Open ${tc.id}\\b`) })).toBeTruthy();
    }
  });

  it("orders TCs pass, fail, blocked, ready, draft, unknown like the sidebar", async () => {
    const r = realRpc();
    const { mission, dir } = missionFor(r, "M6");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const order = ["draft", null, "fail", "pass", "ready", "blocked"] as const;
    order.forEach((s, i) => writeFileSync(join(dir, `TC-00${i + 1}_x.md`), tcText(`TC-00${i + 1}`, s, "M6-AC1")));
    r.board.reconcile();
    show(r, mission.id);
    const rows = await screen.findAllByTestId("tc-row");
    expect(rows.map((x) => x.getAttribute("data-status"))).toEqual(["pass", "fail", "blocked", "ready", "draft", "unknown"]);
  });

  it("clicking a TC row opens its panel: reports its board-relative path through onOpenTestCase (decision 4), never openTestFile", async () => {
    const r = realRpc();
    const { camp, mission } = missionFor(r, "M6");
    const first = r.board.listTests(camp.id, "M6")[0]!;
    const onOpen = vi.fn();
    show(r, mission.id, onOpen);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`Open ${first.id}\\b`) }));
    expect(onOpen).toHaveBeenCalledWith(first.path);
    expect(first.path.startsWith("campaigns/")).toBe(true);
  });

  it("the mission panel's wiring in chat-entry posts openTestCase for a TC row and never openTestFile", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "webview", "chat-entry.tsx"), "utf8");
    const mission = /<MissionView[\s\S]*?\/>/.exec(src)?.[0] ?? "";
    expect(mission).toContain('onOpenTestCase={(path) => vscodeApi.postMessage({ type: "openTestCase", path })}');
    expect(mission).not.toContain("openTestFile");
  });

  it("a legacy `unknown` TC shows as unknown with no warning class (decision 12)", async () => {
    const r = realRpc();
    const { mission, dir } = missionFor(r, "M6");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TC-001_legacy.md"), "# TC-001: legacy\n\n- requirements: M6-AC1\n");
    r.board.reconcile();
    show(r, mission.id);
    const row = await screen.findByTestId("tc-row");
    expect(row.getAttribute("data-status")).toBe("unknown");
    expect(within(row).getByText("unknown")).toBeTruthy();
    expect(row.innerHTML).not.toMatch(/status-warning|status-error/);
  });
});

describe("mission panel: AC coverage", () => {
  it("maps every AC to its covering TC ids; uncovered ACs use the warning token and never an error class", async () => {
    const r = realRpc();
    const { mission, dir } = missionFor(r, "M6");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TC-001_a.md"), tcText("TC-001", "pass", "M6-AC1, M6-AC3"));
    r.board.reconcile();
    const cov = await r.rpc.call("tests:coverage", { missionId: mission.id });
    expect(cov.uncovered.length).toBeGreaterThan(0);
    show(r, mission.id);
    const list = await screen.findByRole("table", { name: /acceptance criteria coverage/i });
    const rows = within(list).getAllByTestId("ac-row");
    expect(rows).toHaveLength(cov.acs.length);
    for (const [i, ac] of cov.acs.entries()) {
      const row = rows[i]!;
      expect(row.getAttribute("data-covered")).toBe(String(ac.covered));
      if (ac.covered) {
        for (const tc of ac.tcs) expect(within(row).getByText(tc)).toBeTruthy();
        expect(row.innerHTML).not.toMatch(/status-warning/);
      } else {
        expect(row.className + row.innerHTML).toMatch(/text-status-warning/);
        expect(within(row).getByText("uncovered")).toBeTruthy(); // text, not colour alone
      }
      expect(row.className + row.innerHTML).not.toMatch(/status-error|text-red|bg-red|#[0-9a-f]{3,6}/i);
    }
  });

  it("a mission with no tests folder: empty state with the add-tests.js hint, and every AC listed uncovered", async () => {
    const r = realRpc();
    const { mission, dir } = missionFor(r, "M6");
    rmSync(dir, { recursive: true, force: true });
    r.board.reconcile();
    const cov = await r.rpc.call("tests:coverage", { missionId: mission.id });
    show(r, mission.id);
    const section = await screen.findByRole("region", { name: "Tests" });
    expect(within(section).getByText(/run add-tests\.js <mission-dir>/)).toBeTruthy();
    expect(screen.queryAllByTestId("tc-row")).toHaveLength(0);
    const rows = await screen.findAllByTestId("ac-row");
    expect(rows).toHaveLength(cov.acs.length);
    expect(cov.acs.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.getAttribute("data-covered") === "false")).toBe(true);
    expect(rows.every((x) => /text-status-warning/.test(x.innerHTML + x.className))).toBe(true);
  });

  it("solo's uwb campaign (legacy TCs): unknown status with no warning, m1 AC11 uncovered, m6 empty state", async () => {
    const named = (process.env.OCTOBOTS_BOARD_COPIES ?? "").split(":").filter(Boolean);
    if (named.length === 0) return; // the repo's own tracked board is covered above; set OCTOBOTS_BOARD_COPIES to run
    const r = realRpc(trackedBoardCopies().at(-1)!);
    const camp = r.board.listCampaigns().find((c) => c.folderPath.endsWith("uwb-ranging-ingest-vendor-v01"));
    if (!camp) return; // a named board that is not solo's
    const byToken = (t: string) => r.board.listMissions(camp.id).find((m) => new RegExp(`^${t}\\b`, "i").test(m.title))!;

    const m1 = byToken("M1");
    const view = show(r, m1.id);
    const rows = await screen.findAllByTestId("tc-row");
    expect(rows.length).toBe(r.board.listTests(camp.id, "M1").length);
    expect(rows.every((x) => x.getAttribute("data-status") === "unknown")).toBe(true);
    expect(rows.every((x) => !/status-warning|status-error/.test(x.innerHTML))).toBe(true);
    const ac11 = (await screen.findAllByTestId("ac-row")).find((x) => x.querySelector("th")?.textContent === "M1-AC11")!;
    expect(ac11.getAttribute("data-covered")).toBe("false");
    expect(ac11.innerHTML).toMatch(/text-status-warning/);
    view.unmount();

    show(r, byToken("M6").id);
    const section = await screen.findByRole("region", { name: "Tests" });
    expect(await within(section).findByText(/run add-tests\.js <mission-dir>/)).toBeTruthy();
    expect(screen.queryAllByTestId("tc-row")).toHaveLength(0);
  });
});

describe("mission panel: refresh", () => {
  it("shows a changed TC status after one spine event, with one fetch of each tests route", async () => {
    const r = realRpc();
    const { camp, mission, dir } = missionFor(r, "M6");
    const target = readdirSync(dir).filter((f) => /^TC-.*\.md$/.test(f)).sort()[0]!;
    const before = r.board.listTests(camp.id, "M6").find((t) => target.startsWith(t.id))!;
    show(r, mission.id);
    await screen.findAllByTestId("tc-row");
    const rowOf = (id: string) => screen.getAllByTestId("tc-row").find((x) => x.textContent?.includes(id))!;
    expect(rowOf(before.id).getAttribute("data-status")).toBe(before.status);

    const next = before.status === "pass" ? "fail" : "pass";
    const text = readFileSync(join(dir, target), "utf8").replace(/^status:.*$/m, `status: ${next}`);
    writeFileSync(join(dir, target), text);
    r.board.reconcile();
    const listBefore = r.calls.filter((c) => c === "tests:list").length;
    const covBefore = r.calls.filter((c) => c === "tests:coverage").length;
    r.emit({ projectId: "workspace", missionId: mission.id });
    await waitFor(() => expect(rowOf(before.id).getAttribute("data-status")).toBe(next));
    expect(r.calls.filter((c) => c === "tests:list").length - listBefore).toBe(1);
    expect(r.calls.filter((c) => c === "tests:coverage").length - covBefore).toBe(1);
  });

  it("a TC's covers edited on disk moves an AC from uncovered to covered after one spine event, one fetch each", async () => {
    const r = realRpc();
    const { mission, dir } = missionFor(r, "M6");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TC-001_a.md"), tcText("TC-001", "pass", "M6-AC1"));
    r.board.reconcile();
    show(r, mission.id);
    const acRow = async (ac: string) => (await screen.findAllByTestId("ac-row")).find((x) => x.querySelector("th")?.textContent === ac)!;
    expect((await acRow("M6-AC2")).getAttribute("data-covered")).toBe("false");
    expect((await acRow("M6-AC1")).textContent).toContain("TC-001");

    writeFileSync(join(dir, "TC-001_a.md"), tcText("TC-001", "pass", "M6-AC2"));
    r.board.reconcile();
    const list0 = r.calls.filter((c) => c === "tests:list").length;
    const cov0 = r.calls.filter((c) => c === "tests:coverage").length;
    r.emit({ projectId: "workspace", missionId: mission.id });
    await waitFor(async () => expect((await acRow("M6-AC2")).getAttribute("data-covered")).toBe("true"));
    expect((await acRow("M6-AC2")).textContent).toContain("TC-001");
    const ac1 = await acRow("M6-AC1");
    expect(ac1.getAttribute("data-covered")).toBe("false");
    expect(ac1.innerHTML).toMatch(/text-status-warning/);
    expect(r.calls.filter((c) => c === "tests:list").length - list0).toBe(1);
    expect(r.calls.filter((c) => c === "tests:coverage").length - cov0).toBe(1);
    // no fetch loop: nothing further is fetched once the view has settled
    const settled = r.calls.length;
    await new Promise((res) => setTimeout(res, 50));
    expect(r.calls.length).toBe(settled);
  });

  it("an AC added to the mission appears in the coverage view, uncovered, after one spine event", async () => {
    const r = realRpc();
    const { mission } = missionFor(r, "M6");
    show(r, mission.id);
    const before = await screen.findAllByTestId("ac-row");
    const got = (await r.rpc.call("mission:get", { missionId: mission.id }))!;
    r.board.updateBrief("mission", mission.id, { acceptanceCriteria: `${got.acceptanceCriteria.trimEnd()}\n- [ ] a criterion added on disk` });
    r.board.reconcile();
    const cov0 = r.calls.filter((c) => c === "tests:coverage").length;
    r.emit({ projectId: "workspace", missionId: mission.id });
    await waitFor(() => expect(screen.getAllByTestId("ac-row")).toHaveLength(before.length + 1));
    const added = screen.getAllByTestId("ac-row").at(-1)!;
    expect(added.textContent).toContain("a criterion added on disk");
    expect(added.getAttribute("data-covered")).toBe("false");
    expect(added.innerHTML).toMatch(/text-status-warning/);
    expect(r.calls.filter((c) => c === "tests:coverage").length - cov0).toBe(1);
  });
});
