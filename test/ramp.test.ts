import { describe, expect, it } from "vitest";

import type { RampStage } from "../src/config.js";
import { selectStage } from "../src/ramp.js";

const stages: RampStage[] = [
  { name: "warmup", minAccountDays: 0, minKarma: 0, posting: false, dailyCap: 0, minGapMinutes: 360, maxGapMinutes: 600, lurkProbability: 0.85, upvoteProbability: 0.45 },
  { name: "cautious", minAccountDays: 21, minKarma: 100, posting: true, dailyCap: 1, minGapMinutes: 300, maxGapMinutes: 540, lurkProbability: 0.75, upvoteProbability: 0.4 },
  { name: "steady", minAccountDays: 45, minKarma: 500, posting: true, dailyCap: 2, minGapMinutes: 240, maxGapMinutes: 420, lurkProbability: 0.6, upvoteProbability: 0.35 },
  { name: "active", minAccountDays: 90, minKarma: 2000, posting: true, dailyCap: 3, minGapMinutes: 180, maxGapMinutes: 360, lurkProbability: 0.5, upvoteProbability: 0.3 },
];

describe("selectStage", () => {
  it("keeps a brand-new account in warmup (draft-only)", () => {
    const stage = selectStage(stages, 3, 5);
    expect(stage.name).toBe("warmup");
    expect(stage.posting).toBe(false);
  });

  it("requires BOTH age and karma to advance", () => {
    expect(selectStage(stages, 60, 50).name).toBe("warmup"); // old but low karma
    expect(selectStage(stages, 5, 5000).name).toBe("warmup"); // high karma but too new
  });

  it("advances to cautious once age and karma both qualify", () => {
    const stage = selectStage(stages, 30, 150);
    expect(stage.name).toBe("cautious");
    expect(stage.dailyCap).toBe(1);
  });

  it("picks the most advanced qualifying stage", () => {
    expect(selectStage(stages, 100, 3000).name).toBe("active");
    expect(selectStage(stages, 50, 600).name).toBe("steady");
  });

  it("never exceeds what the account qualifies for", () => {
    // 80 days, 600 karma → qualifies for steady (45d/500k) but not active (90d/2000k)
    expect(selectStage(stages, 80, 600).name).toBe("steady");
  });
});
