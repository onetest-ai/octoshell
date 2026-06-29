// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TeamSection } from "../src/webview/team-section.js";

const TEAM_WEB = {
  id: "team-web",
  title: "Web",
  backend: "claude",
  roster: ["scout"],
  orchestrator: "scout",
  ready: { ready: true as const },
};
const TEAM_IOS = {
  id: "team-ios",
  title: "iOS",
  backend: "claude",
  roster: ["scout"],
  ready: { ready: false as const, reason: "uninstalled-roles" as const, missing: ["scout"] },
};

function fakeRpc(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "teams:list": [TEAM_WEB, TEAM_IOS],
    "team:getBinding": null,
    "campaign:setTeam": { ok: true },
    "mission:setTeam": { ok: true },
    "team:assignments": [],
    "team:assign": { ok: true },
    "team:resolve": { teamId: null, source: null },
    ...overrides,
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args });
      return data[method];
    }),
    onSpineEvent: () => () => {},
  };
}

/** Rpc where team:getBinding dispatches by scope argument. */
function fakeRpcWithScopedBinding(
  campaignBinding: unknown,
  missionBinding: unknown,
  extraOverrides: Record<string, unknown> = {},
) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const data: Record<string, unknown> = {
    "teams:list": [TEAM_WEB, TEAM_IOS],
    "campaign:setTeam": { ok: true },
    "mission:setTeam": { ok: true },
    "team:assignments": [],
    "team:assign": { ok: true },
    "team:resolve": { teamId: null, source: null },
    ...extraOverrides,
  };
  return {
    calls,
    call: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args });
      if (method === "team:getBinding") {
        const a = args as { scope?: string };
        return a.scope === "campaign" ? campaignBinding : missionBinding;
      }
      return data[method];
    }),
    onSpineEvent: () => () => {},
  };
}

describe("TeamSection (campaign scope)", () => {
  it("renders 3 selectors: Campaign team, Mission team, Bug team", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    expect(await screen.findByLabelText("Campaign team")).toBeTruthy();
    expect(screen.getByLabelText("Mission team")).toBeTruthy();
    expect(screen.getByLabelText("Bug team")).toBeTruthy();
  });

  it("each selector lists the team titles", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    const select = (await screen.findByLabelText("Campaign team")) as HTMLSelectElement;
    expect(select.innerHTML).toContain("Web");
    expect(select.innerHTML).toContain("iOS");
  });

  it("changing Campaign team calls campaign:setTeam", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    const select = await screen.findByLabelText("Campaign team");
    fireEvent.change(select, { target: { value: "team-web" } });
    await waitFor(() =>
      expect(rpc.calls.find((c) => c.method === "campaign:setTeam")?.args).toMatchObject({
        campaignId: "camp1",
        teamId: "team-web",
      }),
    );
  });

  it("changing Mission team calls team:assign(campaign, mission)", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    const select = await screen.findByLabelText("Mission team");
    fireEvent.change(select, { target: { value: "team-web" } });
    await waitFor(() =>
      expect(rpc.calls.find((c) => c.method === "team:assign")?.args).toEqual({
        scope: "campaign",
        scopeId: "camp1",
        workType: "mission",
        teamId: "team-web",
      }),
    );
  });

  it("changing Bug team calls team:assign(campaign, bug)", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    const select = await screen.findByLabelText("Bug team");
    fireEvent.change(select, { target: { value: "team-web" } });
    await waitFor(() =>
      expect(
        rpc.calls.find((c) => c.method === "team:assign" && (c.args as { workType: string }).workType === "bug")?.args,
      ).toEqual({ scope: "campaign", scopeId: "camp1", workType: "bug", teamId: "team-web" }),
    );
  });

  it("no emoji glyphs anywhere", async () => {
    const rpc = fakeRpc();
    const { container } = render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    await screen.findByLabelText("Campaign team");
    expect(container.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("empty state: shows hint when teams:list returns empty array", async () => {
    const rpc = fakeRpc({ "teams:list": [] });
    render(<TeamSection scope="campaign" scopeId="camp1" rpc={rpc as never} />);
    await screen.findByText(/No teams installed/);
  });
});

describe("TeamSection (mission scope)", () => {
  it("Campaign team is read-only (no combobox) and shows the campaign team title", async () => {
    const rpc = fakeRpcWithScopedBinding(
      { scope: "campaign", scopeId: "c1", teamId: "team-web", entrypoint: null, members: [] },
      null,
    );
    const { container } = render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    await screen.findByLabelText("Mission team");
    // No combobox labelled "Campaign team" on the mission view.
    expect(screen.queryByRole("combobox", { name: "Campaign team" })).toBeNull();
    // The campaign team title shows in a read-only span (not an <option>).
    expect(container.querySelector("span.flex-1")?.textContent).toBe("Web");
  });

  it("changing Mission team calls mission:setTeam", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    const select = await screen.findByLabelText("Mission team");
    fireEvent.change(select, { target: { value: "team-web" } });
    await waitFor(() =>
      expect(rpc.calls.find((c) => c.method === "mission:setTeam")?.args).toMatchObject({
        missionId: "m1",
        teamId: "team-web",
      }),
    );
  });

  it("changing Bug team calls team:assign(mission, bug)", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    const select = await screen.findByLabelText("Bug team");
    fireEvent.change(select, { target: { value: "team-web" } });
    await waitFor(() =>
      expect(
        rpc.calls.find((c) => c.method === "team:assign" && (c.args as { workType: string }).workType === "bug")?.args,
      ).toEqual({ scope: "mission", scopeId: "m1", workType: "bug", teamId: "team-web" }),
    );
  });

  it("Mission team shows 'Default' placeholder (team:resolve removed; no inherited resolution)", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    const select = (await screen.findByLabelText("Mission team")) as HTMLSelectElement;
    const noneOption = select.querySelector('option[value=""]');
    expect(noneOption?.textContent).toBe("Default");
    // team:resolve is no longer called
    expect(rpc.calls.some((c) => c.method === "team:resolve")).toBe(false);
  });

  it("Bug team shows 'Default' placeholder (team:resolve removed; no inherited resolution)", async () => {
    const rpc = fakeRpc();
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    const select = (await screen.findByLabelText("Bug team")) as HTMLSelectElement;
    const noneOption = select.querySelector('option[value=""]');
    expect(noneOption?.textContent).toBe("Default");
    // team:resolve is no longer called
    expect(rpc.calls.some((c) => c.method === "team:resolve")).toBe(false);
  });

  it("empty state preserved on mission view", async () => {
    const rpc = fakeRpc({ "teams:list": [] });
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    await screen.findByText(/No teams installed/);
  });

  it("entities:changed spine event triggers a reload (teams:list call count increases)", async () => {
    let spineHandler: ((ev: unknown) => void) | null = null;
    const rpc = fakeRpc();
    rpc.onSpineEvent = (handler: (ev: unknown) => void) => {
      spineHandler = handler;
      return () => { spineHandler = null; };
    };
    render(<TeamSection scope="mission" scopeId="m1" campaignId="c1" rpc={rpc as never} />);
    await screen.findByLabelText("Mission team");
    const callsBefore = rpc.calls.filter((c) => c.method === "teams:list").length;
    spineHandler!({ kind: "entities:changed" });
    await waitFor(() => {
      const callsAfter = rpc.calls.filter((c) => c.method === "teams:list").length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });
});
