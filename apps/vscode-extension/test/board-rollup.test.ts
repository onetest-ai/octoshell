import { describe, it, expect } from "vitest";
import { rollupCampaign } from "../src/host/board-rollup.js";

describe("rollupCampaign", () => {
  it("counts by bucket and derives rollupStatus", () => {
    const r = rollupCampaign(["draft", "active", "done", "failed", "cancelled", "active"]);
    expect(r.total).toBe(6);
    expect(r.active).toBe(2);
    expect(r.completed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.cancelled).toBe(1);
    expect(r.draft).toBe(1);
    expect(r.rollupStatus).toBe("active"); // any active → active
  });
  it("all done → completed; empty → draft", () => {
    expect(rollupCampaign(["done", "done"]).rollupStatus).toBe("completed");
    expect(rollupCampaign([]).rollupStatus).toBe("draft");
  });
  it("no active, some failed → failed; else cancelled-only → cancelled", () => {
    expect(rollupCampaign(["done", "failed"]).rollupStatus).toBe("failed");
    expect(rollupCampaign(["cancelled", "cancelled"]).rollupStatus).toBe("cancelled");
  });
});
