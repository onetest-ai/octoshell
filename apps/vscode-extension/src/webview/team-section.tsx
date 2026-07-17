import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "./rpc-client.js";
import type { RpcResultOf } from "../protocol/index.js";

type TeamList = RpcResultOf<"teams:list">;
type TeamAssignments = RpcResultOf<"team:assignments">;

interface Props {
  scope: "campaign" | "mission";
  scopeId: string;
  rpc: RpcClient;
  campaignId?: string;
}

export function TeamSection({ scope, scopeId, rpc, campaignId }: Props): JSX.Element {
  const [teams, setTeams] = useState<TeamList>([]);
  const [campaignTeamId, setCampaignTeamId] = useState<string | null>(null);
  const [missionTeamId, setMissionTeamId] = useState<string | null>(null);
  const [bugTeamId, setBugTeamId] = useState<string | null>(null);
  const [inheritedMission, setInheritedMission] = useState<string | null>(null);
  const [inheritedBug, setInheritedBug] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const campaignBindingPromise =
      scope === "mission" && campaignId
        ? rpc.call("team:getBinding", { scope: "campaign", scopeId: campaignId }).catch(() => null)
        : Promise.resolve(null);

    const [ts, binding, campaignBinding, assignments] = await Promise.all([
      rpc.call("teams:list", {}),
      rpc.call("team:getBinding", { scope, scopeId }),
      campaignBindingPromise,
      rpc.call("team:assignments", {}),
    ]);

    setTeams(ts ?? []);

    const find = (s: string, sid: string, wt: string) =>
      ((assignments ?? []) as TeamAssignments).find(
        (a) => a.scope === s && a.scopeId === sid && a.workType === wt,
      )?.teamId ?? null;

    if (scope === "campaign") {
      setCampaignTeamId(binding?.teamId ?? null);
      setMissionTeamId(find("campaign", scopeId, "mission"));
      setBugTeamId(find("campaign", scopeId, "bug"));
      setInheritedMission(null);
      setInheritedBug(null);
    } else {
      setCampaignTeamId(campaignBinding?.teamId ?? null);
      setMissionTeamId(binding?.teamId ?? null);
      setBugTeamId(find("mission", scopeId, "bug"));
      setInheritedMission(null);
      setInheritedBug(null);
    }

    setLoaded(true);
  }, [rpc, scope, scopeId, campaignId]);

  useEffect(() => {
    void load();
    const off = rpc.onSpineEvent((ev) => {
      const e = ev as { kind?: string; campaignId?: string; missionId?: string };
      if (e.kind === "entities:changed") { void load(); return; }
      const matchId = scope === "campaign" ? e.campaignId : e.missionId;
      if (matchId === scopeId) void load();
    });
    return off;
  }, [rpc, scope, scopeId, load]);

  const titleOf = useCallback(
    (id: string | null): string | null => (id ? teams.find((t) => t.id === id)?.title ?? id : null),
    [teams],
  );

  const handleCampaignTeamChange = useCallback(
    async (value: string) => {
      await rpc.call("campaign:setTeam", { campaignId: scopeId, teamId: value === "" ? null : value });
      await load();
    },
    [rpc, scopeId, load],
  );

  const handleMissionTeamChange = useCallback(
    async (value: string) => {
      const teamId = value === "" ? null : value;
      if (scope === "campaign") {
        await rpc.call("team:assign", { scope: "campaign", scopeId, workType: "mission", teamId });
      } else {
        await rpc.call("mission:setTeam", { missionId: scopeId, teamId });
      }
      await load();
    },
    [rpc, scope, scopeId, load],
  );

  const handleBugTeamChange = useCallback(
    async (value: string) => {
      await rpc.call("team:assign", { scope, scopeId, workType: "bug", teamId: value === "" ? null : value });
      await load();
    },
    [rpc, scope, scopeId, load],
  );

  if (!loaded) {
    return (
      <section>
        <h2 className="text-sm uppercase text-fg-muted mb-2">Team</h2>
        <div className="text-sm text-fg-muted">Loading…</div>
      </section>
    );
  }

  if (teams.length === 0) {
    return (
      <section>
        <h2 className="text-sm uppercase text-fg-muted mb-2">Team</h2>
        <div className="text-sm text-fg-muted">
          No teams installed — ask the <code>mission-planner</code> skill to create a team (see its Teams
          section in <code>.claude/skills/mission-planner/SKILL.md</code>).
        </div>
      </section>
    );
  }

  const selectClass = "flex-1 bg-input text-fg-input border border-border rounded px-2 py-1 text-sm";
  const labelClass = "w-28 shrink-0 text-fg-muted text-xs uppercase";
  const teamOptions = teams.map((t) => (
    <option key={t.id} value={t.id}>{t.title}</option>
  ));

  const missionInheritLabel = inheritedMission ? `Inherited: ${titleOf(inheritedMission)}` : "Default";
  const bugInheritLabel = inheritedBug ? `Inherited: ${titleOf(inheritedBug)}` : "Default";

  return (
    <section>
      <h2 className="text-sm uppercase text-fg-muted mb-2">Team</h2>

      <div className="space-y-2">
        {/* Campaign team */}
        <div className="flex items-center gap-2">
          <label className={labelClass}>Campaign team</label>
          {scope === "campaign" ? (
            <select
              aria-label="Campaign team"
              className={selectClass}
              value={campaignTeamId ?? ""}
              onChange={(e) => void handleCampaignTeamChange(e.target.value)}
            >
              <option value="">Default</option>
              {teamOptions}
            </select>
          ) : (
            <span className="flex-1 text-sm text-fg px-2 py-1">{titleOf(campaignTeamId) ?? "Default"}</span>
          )}
        </div>

        {/* Mission team */}
        <div className="flex items-center gap-2">
          <label className={labelClass}>Mission team</label>
          <select
            aria-label="Mission team"
            className={selectClass}
            value={missionTeamId ?? ""}
            onChange={(e) => void handleMissionTeamChange(e.target.value)}
          >
            <option value="">{scope === "campaign" ? "Default" : missionInheritLabel}</option>
            {teamOptions}
          </select>
        </div>

        {/* Bug team */}
        <div className="flex items-center gap-2">
          <label className={labelClass}>Bug team</label>
          <select
            aria-label="Bug team"
            className={selectClass}
            value={bugTeamId ?? ""}
            onChange={(e) => void handleBugTeamChange(e.target.value)}
          >
            <option value="">{scope === "campaign" ? "Default" : bugInheritLabel}</option>
            {teamOptions}
          </select>
        </div>
      </div>
    </section>
  );
}
