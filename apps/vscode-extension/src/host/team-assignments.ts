/**
 * TeamAssignments — globalState-backed store for team-type assignments.
 *
 * Maps (scope, scopeId, workType) → teamId in VS Code's globalState.
 * Replaces the domain DB store for team-type assignments so no daemon/domain is needed
 * for board-only team configuration.
 */

import type { TeamTypeAssignment } from "../protocol/index.js";

type WorkType = "mission" | "bug" | "campaign";
type Scope = "project" | "campaign" | "mission";

/** Minimal interface so this class is testable without real VS Code. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const STORE_KEY = "octoshell.teamAssignments";

/** Key for the internal map. */
function entryKey(scope: Scope, scopeId: string, workType: WorkType): string {
  return `${scope}::${scopeId}::${workType}`;
}

export class TeamAssignments {
  private readonly memento: Memento;

  constructor(memento: Memento) {
    this.memento = memento;
  }

  private load(): Record<string, string | null> {
    return this.memento.get<Record<string, string | null>>(STORE_KEY) ?? {};
  }

  private async save(data: Record<string, string | null>): Promise<void> {
    await this.memento.update(STORE_KEY, data);
  }

  get(scope: Scope, scopeId: string, workType: WorkType): string | null {
    const data = this.load();
    const val = data[entryKey(scope, scopeId, workType)];
    return val !== undefined ? val : null;
  }

  async set(scope: Scope, scopeId: string, workType: WorkType, teamId: string | null): Promise<void> {
    const data = this.load();
    data[entryKey(scope, scopeId, workType)] = teamId;
    await this.save(data);
  }

  list(): TeamTypeAssignment[] {
    const data = this.load();
    const out: TeamTypeAssignment[] = [];
    for (const [key, teamId] of Object.entries(data)) {
      const parts = key.split("::");
      if (parts.length !== 3) continue;
      const [scope, scopeId, workType] = parts as [string, string, string];
      if (!isScope(scope) || !isWorkType(workType) || scopeId === undefined) continue;
      out.push({ scope, scopeId, workType, teamId: teamId ?? null });
    }
    return out;
  }
}

function isScope(v: string): v is Scope {
  return v === "project" || v === "campaign" || v === "mission";
}

function isWorkType(v: string): v is WorkType {
  return v === "mission" || v === "bug" || v === "campaign";
}
