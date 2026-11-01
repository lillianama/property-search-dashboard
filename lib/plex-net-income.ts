import type { PitiBreakdown } from "./piti";
import { rentalSubtotal, type PlexUnitSummary } from "./plex-units";

/** Compare only complete current whole-property totals from the selected snapshot. */
export function plexNetIncome(summary: PlexUnitSummary | undefined, piti: PitiBreakdown | null) {
  const units = summary?.units ?? [];
  const completeScope = units.length > 0 && summary?.recordedUnitCount?.count === units.length;
  const expected = rentalSubtotal(units, "expectedMonthlyRent");
  const actual = rentalSubtotal(units, "actualMonthlyRent");
  // Numeric actualRent is the existing listing-reported contract, not verified collection.
  // Occupancy must support every row; never invent zero rent for a vacant unit.
  const compatibleActual = units.every(unit => unit.occupancy === "occupied" &&
    !/projected|projection|pro[ -]?forma|historical|unknown|unsupported|no supported|unallocated|whole[ -]building|whole[ -]property/i.test(unit.actualRentBasis ?? ""));
  const actualRent = completeScope && compatibleActual && actual.count === units.length ? actual.amount : null;
  const estimatedRent = completeScope && expected.count === units.length ? expected.amount : null;
  const basis: "actual" | "estimated" | null = actualRent !== null &&
    (estimatedRent === null || actualRent <= estimatedRent) ? "actual" : estimatedRent !== null ? "estimated" : null;
  const rent = basis === "actual" ? actualRent : basis === "estimated" ? estimatedRent : null;
  return {
    actualRent, estimatedRent, basis, rent,
    amount: rent !== null && piti?.taxIncluded ? rent - piti.monthlyTotal : null,
    reason: rent === null ? "Whole-building actual and estimated rent incomplete or noncomparable" :
      !piti?.taxIncluded ? "PITI incomplete or unavailable" : null,
  };
}
