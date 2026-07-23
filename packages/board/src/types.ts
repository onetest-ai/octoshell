export interface Campaign {
  id: string;
  name: string;
  isDefault: boolean;
  description: string;
  acceptanceCriteria: string;
  target: string;
  status: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Mission {
  id: string;
  campaignId: string;
  title: string;
  status: string;
  description: string;
  acceptanceCriteria: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  missionId: string;
  name: string;
  status: string;
  description: string;
  acceptanceCriteria: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

export type BugSeverity = "blocker" | "critical" | "major" | "minor" | "trivial";

export interface Bug {
  id: string;
  campaignId: string | null;
  missionId: string | null;
  title: string;
  status: string;
  severity: BugSeverity;
  description: string;
  stepsToReproduce: string;
  expected: string;
  actual: string;
  rca: string;
  environment: string;
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

/** A bug is parented by exactly one of a campaign or a mission. */
export type BugParent = { campaignId: string } | { missionId: string };

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
