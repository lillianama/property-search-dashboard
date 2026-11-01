import type { PitiBreakdown } from "./piti";
import { rentalSubtotal, type PlexUnitSummary } from "./plex-units";

/** Whole-building projected rent only; never substitute actual rent or a partial subtotal. */
export function plexNetIncome(summary: PlexUnitSummary | undefined, piti: PitiBreakdown | null) {
  const units = summary?.units ?? [];
  const expected = rentalSubtotal(units, "expectedMonthlyRent");
  const complete = !!summary?.recordedUnitCount &&
    summary.recordedUnitCount.count === units.length && units.length > 0 &&
    expected.count === units.length;
  const rent = complete ? expected.amount : null;
  return {
    rent,
    amount: rent !== null && piti?.taxIncluded ? rent - piti.monthlyTotal : null,
    reason: rent === null ? "Whole-building estimated rent incomplete" :
      !piti?.taxIncluded ? "PITI incomplete or unavailable" : null,
  };
}
