// T1.3: the test-case panel (view), driven through the real dispatcher and a real BoardHost over cp -R copies of
// real boards (campaign octoshell-0-1-1 rules 2, 10, 11). Expected values are READ FROM THE FILES, never pinned.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestCaseView } from "../src/webview/test-case-view.js";
import { realRpc, type RealRpc } from "./fixtures/real-rpc.js";
import { trackedBoardCopies } from "./fixtures/real-board.js";
import {
  DDP, TC4, LEGACY_UWB_TC003, UWB_M5_TC001, UWB_TC006_CELL, coversOf, derive, field, lastRunOf, put, runScript, setFrontmatter,
  soloBoardCopy, unquote,
} from "./fixtures/tc-panel-fixtures.js";

afterEach(cleanup);

const today = (): string => new Date().toISOString().slice(0, 10);

interface Handlers { onOpenMission: ReturnType<typeof vi.fn>; onOpenTestFile: ReturnType<typeof vi.fn>; onOpenTestEvidence: ReturnType<typeof vi.fn> }

function show(r: RealRpc, path: string): Handlers & ReturnType<typeof render> {
  const h: Handlers = { onOpenMission: vi.fn(), onOpenTestFile: vi.fn(), onOpenTestEvidence: vi.fn() };
  const view = render(<TestCaseView path={path} rpc={r.rpc} {...h} />);
  return Object.assign(view, h);
}

const statusSelect = async (): Promise<HTMLSelectElement> => (await screen.findByRole("combobox", { name: "Status" })) as HTMLSelectElement;
const optionTexts = (sel: HTMLSelectElement): string[] => [...sel.options].map((o) => o.textContent ?? "");
const criteria = (): HTMLElement[] => screen.queryAllByTestId("tc-criterion");
const ownText = (el: HTMLElement | null): string => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function m6of(r: RealRpc) {
  const camp = r.board.listCampaigns().find((c) => c.folderPath === DDP)!;
  return r.board.listMissions(camp.id).find((m) => m.title.startsWith("M6"))!;
}

describe("test-case panel over the real TC-004 (values read from its frontmatter)", () => {
  it("shows the header, Status row, criteria, rendered body, hint and Open source file", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    const text = readFileSync(join(octo, TC4), "utf8");
    const status = field(text, "status")!;
    const run = lastRunOf(text)!;
    const m6 = m6of(r);
    const ac3 = r.board.testCoverage(m6.id).acs[2]!;
    const view = show(r, TC4);

    const sel = await statusSelect();
    expect(sel.value).toBe(status);
    // the Status row matches mission/task/bug: visible uppercase label, the same select classes
    const label = screen.getByText("Status", { selector: "label" });
    expect(label.className).toContain("uppercase");
    expect(label.getAttribute("for")).toBe(sel.id);
    expect(sel.className).toBe("bg-input text-fg-input border border-border rounded-sm px-2 py-1");
    expect(sel.disabled).toBe(false);
    expect(optionTexts(sel)).toEqual(["draft", "ready", "pass", "fail", "blocked"]);

    const header = screen.getByTestId("tc-header");
    expect(within(header).getByText("TC-004")).toBeTruthy();
    expect(within(header).getByText(unquote(field(text, "title"))!)).toBeTruthy();
    expect(within(header).getByText(status)).toBeTruthy(); // the status word
    const icon = { pass: "codicon-pass", fail: "codicon-error", blocked: "codicon-circle-slash", ready: "codicon-circle-large-outline", draft: "codicon-edit" }[status]!;
    expect(header.querySelector(`.${icon}`)).not.toBeNull(); // and its distinct codicon
    expect(ownText(screen.getByTestId("tc-kind"))).toContain(field(text, "kind")!);

    const lastRun = screen.getByTestId("tc-last-run");
    expect(lastRun.textContent).toContain(run.date);
    const evLink = within(lastRun).getByRole("link");
    fireEvent.click(evLink);
    expect(view.onOpenTestEvidence).toHaveBeenCalledWith(TC4);

    const rows = criteria();
    expect(rows).toHaveLength(coversOf(text).length);
    expect(rows[0]!.textContent).toContain("M6-AC3");
    expect(rows[0]!.textContent).toContain(ac3.text);
    fireEvent.click(within(rows[0]!).getByRole("link", { name: "M6-AC3" }));
    expect(view.onOpenMission).toHaveBeenCalledWith(m6.id);

    const body = screen.getByTestId("tc-body");
    const stepsRows = (text.match(/^\| \d+ \|/gm) ?? []).length;
    expect(stepsRows).toBeGreaterThan(0);
    expect(body.querySelectorAll("table").length).toBe(1);
    expect(body.querySelectorAll("tbody tr").length).toBe(stepsRows);
    expect(within(body).getByRole("heading", { name: "Objective" })).toBeTruthy();
    expect(within(body).getByRole("heading", { name: "Expected Final State" })).toBeTruthy();
    expect(within(body).getByRole("heading", { name: "Preconditions" })).toBeTruthy();
    expect(body.textContent).not.toMatch(/covers:|last_run:/);

    expect(screen.getByText(/pass, fail or blocked pick records today's date and replaces any earlier evidence link/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open source file" }));
    expect(view.onOpenTestFile).toHaveBeenCalledWith(TC4);
    expect(screen.queryByRole("status")).toBeNull(); // nothing to say yet
  });

  it("a pick sends {path, status, base} equal to what the panel rendered; after it: the new status, today's date, `no evidence`, no link, no notice; the dropdown is disabled in flight", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    const text = readFileSync(join(octo, TC4), "utf8");
    const target = field(text, "status") === "pass" ? "fail" : "pass";
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const real = r.rpc.call;
    const sent: unknown[] = [];
    (r.rpc as { call: unknown }).call = async (m: string, a: unknown) => {
      if (m === "tests:setStatus") { sent.push(a); await gate; }
      return (real as (m: string, a: unknown) => Promise<unknown>)(m, a);
    };
    show(r, TC4);
    const sel = await statusSelect();
    fireEvent.change(sel, { target: { value: target } });
    await waitFor(() => expect(sel.disabled).toBe(true));
    expect(sent).toEqual([{ path: TC4, status: target, base: { status: field(text, "status"), lastRun: lastRunOf(text) } }]);
    release();
    await waitFor(() => expect(sel.disabled).toBe(false));
    await waitFor(() => expect(sel.value).toBe(target));
    const header = screen.getByTestId("tc-header");
    expect(within(header).getByText(target)).toBeTruthy();
    const lastRun = screen.getByTestId("tc-last-run");
    expect(lastRun.textContent).toContain(today());
    expect(lastRun.textContent).toContain("no evidence");
    expect(within(lastRun).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    // and the file is what the host wrote for the pick
    expect(field(readFileSync(join(octo, TC4), "utf8"), "status")).toBe(target);
  });

  it("an agent's newer status makes the pick stale: nothing written, the panel shows the agent's status and a role=status notice that survives a spine event until the next pick", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    const abs = join(octo, TC4);
    runScript(abs, "ready"); // the state the panel will show
    r.board.reconcile();
    show(r, TC4);
    const sel = await statusSelect();
    await waitFor(() => expect(sel.value).toBe("ready"));
    // an agent, outside the extension, records a failing run with evidence
    runScript(abs, "fail", "--evidence", `.octobots/${DDP}/tests/m6/runs/RUN-2026-10-06-001.md`, "--date", "2026-10-06");
    const agentBytes = readFileSync(abs, "utf8");
    expect(field(agentBytes, "status")).toBe("fail");

    fireEvent.change(sel, { target: { value: "pass" } });
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/status changed outside the panel and was not saved/i);
    expect(readFileSync(abs, "utf8")).toBe(agentBytes); // byte for byte
    await waitFor(() => expect(sel.value).toBe("fail"));
    expect(screen.getByTestId("tc-last-run").textContent).toContain("2026-10-06");
    expect(within(screen.getByTestId("tc-last-run")).getByRole("link")).toBeTruthy();

    // an external refresh does not clear it
    runScript(abs, "blocked", "--date", "2026-10-07");
    r.board.reconcile();
    act(() => r.emit({ projectId: "workspace", testPath: TC4 }));
    await waitFor(() => expect(sel.value).toBe("blocked"));
    expect(screen.getByRole("status").textContent).toMatch(/not saved/i);

    // the next pick clears it (and, on success, shows no notice at all)
    fireEvent.change(sel, { target: { value: "ready" } });
    await waitFor(() => expect(sel.value).toBe("ready"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("a non-stale refusal shows the writer's message inline as role=status, writes nothing and notifies nothing", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    const abs = join(octo, TC4);
    const folder = join(octo, DDP, "tests", "m6");
    show(r, TC4);
    const sel = await statusSelect();
    const before = readFileSync(abs, "utf8");
    chmodSync(folder, 0o555); // the temp file cannot be created: a real write error
    try {
      fireEvent.change(sel, { target: { value: field(before, "status") === "pass" ? "fail" : "pass" } });
      const notice = await screen.findByRole("status");
      expect(notice.textContent!.length).toBeGreaterThan(0);
      expect(notice.textContent).not.toMatch(/changed outside the panel/);
    } finally {
      chmodSync(folder, 0o755);
    }
    expect(readFileSync(abs, "utf8")).toBe(before);
    await waitFor(() => expect(sel.disabled).toBe(false));
    expect(sel.value).toBe(field(before, "status"));
  });
});

describe("test-case panel: degenerate and legacy records", () => {
  it("a legacy TC (uwb m1 TC-003 shape): unknown is the current, unselectable option; the dropdown is enabled; kind none; never run; the --migrate note stays after a pick", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = put(octo, "m1", "TC-003_set-ranging-mode-persists.md", LEGACY_UWB_TC003.replace("[M1-AC2, M1-AC5]", "[M1-AC2, M1-AC5, M1-AC99]"));
    const r = realRpc(octo);
    const m1 = r.board.listMissions(r.board.listCampaigns().find((c) => c.folderPath === DDP)!.id).find((m) => m.title.startsWith("M1"))!;
    const cov = r.board.testCoverage(m1.id);
    show(r, rel);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(false);
    expect(sel.value).toBe("unknown");
    const unknown = [...sel.options].find((o) => o.value === "unknown")!;
    expect(unknown.disabled).toBe(true);
    expect(optionTexts(sel)).toEqual(["unknown", "draft", "ready", "pass", "fail", "blocked"]);
    expect(ownText(screen.getByTestId("tc-kind"))).toContain("none");
    expect(screen.getByTestId("tc-last-run").textContent).toContain("never run");
    expect(screen.getByTestId("tc-legacy-note").textContent).toBe("legacy test case: kind and mission not recorded; set-test-status.js <file> --migrate adds them");

    const rows = criteria();
    expect(rows.map((x) => within(x).getByTestId("tc-criterion-id").textContent)).toEqual(["M1-AC2", "M1-AC5", "M1-AC99"]);
    expect(rows[0]!.textContent).toContain(cov.acs.find((a) => a.ac === "M1-AC2")!.text);
    expect(rows[1]!.textContent).toContain(cov.acs.find((a) => a.ac === "M1-AC5")!.text);
    expect(within(rows[0]!).getByRole("link", { name: "M1-AC2" })).toBeTruthy();
    expect(rows[2]!.textContent).toContain("not a criterion of M1");
    expect(rows[2]!.querySelector(".codicon-warning")).not.toBeNull();
    expect(rows[2]!.className + rows[2]!.innerHTML).toContain("text-status-warning");
    expect(within(rows[2]!).queryByRole("link")).toBeNull();

    fireEvent.change(sel, { target: { value: "ready" } });
    await waitFor(() => expect(sel.value).toBe("ready"));
    const after = readFileSync(join(octo, rel), "utf8");
    expect(field(after, "status")).toBe("ready");
    expect(field(after, "kind")).toBeUndefined();
    expect(field(after, "mission")).toBeUndefined();
    expect(screen.getByTestId("tc-legacy-note")).toBeTruthy(); // kind and mission are still absent
  });

  it("an evidence file that does not exist shows the date and the path as plain text marked `not found`", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-090_missing-evidence.md", (t) => t.replace(/evidence: [^,}]+/, "evidence: .octobots/nope/RUN-404.md"));
    show(realRpc(octo), rel);
    const lastRun = await screen.findByTestId("tc-last-run");
    expect(lastRun.textContent).toContain(".octobots/nope/RUN-404.md");
    expect(lastRun.textContent).toContain("not found");
    expect(within(lastRun).queryByRole("link")).toBeNull();
  });

  it("covers [] says `none listed`; a TC that never ran says `never run`", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-094_none.md", (t) => setFrontmatter(setFrontmatter(t, "last_run", null), "covers", "covers: []"));
    show(realRpc(octo), rel);
    await statusSelect();
    expect(criteria()).toHaveLength(0);
    expect(screen.getByText("none listed")).toBeTruthy();
    expect(screen.getByTestId("tc-last-run").textContent).toContain("never run");
  });

  it("unparseable frontmatter: id from the filename, title from the H1, unknown, none, `none listed`, the text after the block, and a disabled dropdown whose aria-describedby names the reason", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = put(octo, "m1", "TC-003_broken.md", LEGACY_UWB_TC003.replace("title: Set", "title: [Set").replace("[M1-AC2, M1-AC5]", "[M1-AC2"));
    show(realRpc(octo), rel);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(true);
    expect(sel.value).toBe("unknown");
    const header = screen.getByTestId("tc-header");
    expect(within(header).getByText("TC-003")).toBeTruthy();
    expect(header.textContent).toContain("TC-003: Set ranging Mode and Persist".replace("TC-003: ", ""));
    expect(ownText(screen.getByTestId("tc-kind"))).toContain("none");
    expect(screen.getByText("none listed")).toBeTruthy();
    expect(screen.getByTestId("tc-body").textContent).toContain("Set ranging Mode and Persist");
    expect(screen.getByTestId("tc-body").textContent).not.toContain("priority: critical");
    const reasonId = sel.getAttribute("aria-describedby")!;
    expect(reasonId).toBeTruthy();
    const reason = document.getElementById(reasonId)!;
    expect(reason.textContent).toMatch(/frontmatter/i);
  });

  it("no frontmatter: the whole file as plain text, a disabled dropdown and the --migrate hint", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = put(octo, "m1", "TC-004_nofm.md", "# TC-004: bare\n\n- requirements: M1-AC1\n");
    show(realRpc(octo), rel);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(true);
    const body = screen.getByTestId("tc-body");
    expect(body.textContent).toBe("# TC-004: bare\n\n- requirements: M1-AC1\n"); // plain text, not rendered
    expect(body.querySelector("h1,h3,ul")).toBeNull();
    expect(document.getElementById(sel.getAttribute("aria-describedby")!)!.textContent).toContain("set-test-status.js <file> --migrate");
  });

  it("over 4 MiB: `too large to show; Open source file`, a disabled dropdown, and the button still works", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-095_huge.md", (t) => t + "x".repeat(4 * 1024 * 1024 + 1));
    const view = show(realRpc(octo), rel);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(true);
    expect(screen.getByText("too large to show; Open source file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open source file" }));
    expect(view.onOpenTestFile).toHaveBeenCalledWith(rel);
    expect(document.getElementById(sel.getAttribute("aria-describedby")!)).not.toBeNull();
  });

  it("a symlinked TC inside the board reads but is never writable: disabled with its reason", async () => {
    const octo = trackedBoardCopies()[0]!;
    symlinkSync(join(octo, TC4), join(octo, DDP, "tests", "m6", "TC-096_link.md"));
    show(realRpc(octo), `${DDP}/tests/m6/TC-096_link.md`);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(true);
    expect(document.getElementById(sel.getAttribute("aria-describedby")!)!.textContent).toMatch(/symlink/i);
  });

  it("a tests folder with no matching mission (m9): `mission M9 not found` once and no criterion links", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-001_orphan.md", (t) => t.replace(/^mission:.*$/m, "mission: M9"), "m9");
    show(realRpc(octo), rel);
    await statusSelect();
    expect(screen.getAllByText("mission M9 not found")).toHaveLength(1);
    expect(screen.queryAllByRole("link", { name: /AC/ })).toHaveLength(0);
    expect(screen.getByTestId("tc-last-run")).toBeTruthy();
  });

  it("a TC of a cancelled mission renders normally: dropdown enabled, criterion links open the mission", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    const m1 = r.board.listMissions(r.board.listCampaigns().find((c) => c.folderPath === DDP)!.id).find((m) => m.title.startsWith("M1"))!;
    // M1 of this repo's campaign is cancelled by editing its status on the copy (the real uwb m5 is cancelled in solo)
    const yaml = join(octo, m1.folderPath, "mission.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^status:.*$/m, "status: cancelled"));
    r.board.reconcile();
    expect(r.board.getMission(m1.id)!.status).toBe("cancelled");
    const rel = put(octo, "m1", "TC-001_emulator.md", UWB_M5_TC001.replace("M5-AC1", "M1-AC1"));
    const view = show(r, rel);
    const sel = await statusSelect();
    expect(sel.disabled).toBe(false);
    fireEvent.click(within(criteria()[0]!).getByRole("link", { name: "M1-AC1" }));
    expect(view.onOpenMission).toHaveBeenCalledWith(m1.id);
  });

  it("the file deleted, then a spine event: `This test case no longer exists` and no dropdown", async () => {
    const octo = trackedBoardCopies()[0]!;
    const r = realRpc(octo);
    show(r, TC4);
    await statusSelect();
    rmSync(join(octo, TC4));
    r.board.reconcile();
    act(() => r.emit({ projectId: "workspace", testPath: TC4 }));
    expect(await screen.findByText("This test case no longer exists")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("a path the guard rejects shows the no-longer-exists state, not an error", async () => {
    const r = realRpc();
    show(r, "../secret.md");
    expect(await screen.findByText("This test case no longer exists")).toBeTruthy();
  });
});

describe("test-case panel: sanitized rendering", () => {
  it("renders `<id of first SCHEDULED match …>` literally and creates no script or img element for hostile bodies", async () => {
    const octo = trackedBoardCopies()[0]!;
    const rel = derive(octo, "TC-097_hostile.md", (t) =>
      t + `\n| 7 | ${UWB_TC006_CELL} | ok |\n\n<script>window.pwned = 1</script>\n\n<img src=x onerror="window.pwned = 2">\n` +
      `\n[click](javascript:window.pwned=3) [shout](JAVASCRIPT:window.pwned=4) <a href="javascript:window.pwned=5">raw</a>\n`);
    show(realRpc(octo), rel);
    const body = await screen.findByTestId("tc-body");
    expect(body.textContent).toContain("<id of first SCHEDULED match");
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("iframe,object,embed")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    // rehype-sanitize DROPS embedded HTML; without it react-markdown would show it as escaped text. Neither the markup
    // nor a javascript: URL survives (review finding: the assertions above passed with the sanitizer removed).
    expect(body.textContent).not.toMatch(/<script|onerror|window\.pwned/i);
    expect(body.innerHTML).not.toMatch(/javascript:/i);
    for (const a of body.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
  });
});

describe("test-case panel over solo's real uwb TCs (when OCTOBOTS_BOARD_COPIES names solo)", () => {
  it("TC-003 (legacy), TC-006 (the sanitizer record) and the cancelled-mission TC (m5) read from the real files", async () => {
    const solo = soloBoardCopy();
    if (!solo) return; // the derived cases above cover the shapes; name solo's board copy to run these
    const r = realRpc(solo);
    const uwb = "campaigns/uwb-ranging-ingest-vendor-v01/tests";
    const tc003 = r.board.listTests(r.board.listCampaigns().find((c) => c.folderPath.endsWith("uwb-ranging-ingest-vendor-v01"))!.id, "m1").find((t) => t.id === "TC-003")!;
    const text = readFileSync(join(solo, tc003.path), "utf8");
    show(r, tc003.path);
    const sel = await statusSelect();
    expect(sel.value).toBe("unknown");
    expect(sel.disabled).toBe(false);
    expect(criteria().map((x) => within(x).getByTestId("tc-criterion-id").textContent)).toEqual(coversOf(text));
    expect(screen.getByTestId("tc-legacy-note")).toBeTruthy();
    cleanup();

    const tc006 = r.board.listTests(r.board.listCampaigns().find((c) => c.folderPath.endsWith("uwb-ranging-ingest-vendor-v01"))!.id, "m1").find((t) => t.id === "TC-006")!;
    show(r, tc006.path);
    expect((await screen.findByTestId("tc-body")).textContent).toContain("<id of first SCHEDULED match");
    cleanup();

    const m5 = r.board.listTests(r.board.listCampaigns().find((c) => c.folderPath.endsWith("uwb-ranging-ingest-vendor-v01"))!.id, "m5")[0]!;
    expect(m5.path.startsWith(uwb.replace(/\/tests$/, ""))).toBe(true);
    show(r, m5.path);
    const sel5 = await statusSelect();
    expect(sel5.disabled).toBe(false);
    expect(criteria().length).toBeGreaterThan(0);
  });
});
