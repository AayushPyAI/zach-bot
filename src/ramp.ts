import { RampStage } from "./config.js";

/**
 * Pure stage selection for the account-maturity ramp. Picks the most-advanced
 * stage the account qualifies for, requiring BOTH the age and karma thresholds.
 * Falls back to the most conservative stage if none qualify (shouldn't happen
 * when a 0/0 warmup stage exists). Side-effect free and unit-tested.
 */
export function selectStage(stages: RampStage[], ageDays: number, karma: number): RampStage {
  const eligible = stages.filter((s) => ageDays >= s.minAccountDays && karma >= s.minKarma);
  const pool = eligible.length > 0 ? eligible : stages;
  // "Most advanced" = highest thresholds; tie-break by higher daily cap.
  return pool.reduce((best, s) => {
    const bestScore = best.minAccountDays + best.minKarma;
    const sScore = s.minAccountDays + s.minKarma;
    if (sScore > bestScore) return s;
    if (sScore === bestScore && s.dailyCap < best.dailyCap) return s; // prefer the safer of equals
    return best;
  });
}

/** The single most conservative stage, used when account stats can't be read. */
export function safestStage(stages: RampStage[]): RampStage {
  return stages.reduce((safest, s) =>
    s.minAccountDays + s.minKarma < safest.minAccountDays + safest.minKarma ? s : safest,
  );
}
