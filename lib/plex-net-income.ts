import type { PitiBreakdown } from "./piti";
import { rentalSubtotal, type PlexUnitSummary } from "./plex-units";

/** Select supported rent per unit from the current snapshot, then total the building. */
export function plexNetIncome(summary: PlexUnitSummary | undefined, piti: PitiBreakdown | null) {
  const units = summary?.units ?? [];
  const completeScope = units.length > 0 && summary?.recordedUnitCount?.count === units.length;
  const expected = rentalSubtotal(units, "expectedMonthlyRent");
  const actual = rentalSubtotal(units, "actualMonthlyRent");
  // Numeric actualRent is the existing listing-reported contract, not verified collection.
  // Occupancy must support each actual; never invent zero rent for a vacant unit.
  const unitSelections = units.map(unit => {
    const actual = unit.occupancy === "occupied" &&
      !/projected|projection|pro[ -]?forma|historical|unknown|unsupported|no supported|unallocated|whole[ -]building|whole[ -]property/i.test(unit.actualRentBasis ?? "")
      ? unit.actualMonthlyRent : null;
    const estimated = unit.expectedMonthlyRent;
    const basis: "actual" | "estimated" | null = actual !== null &&
      (estimated === null || actual <= estimated) ? "actual" : estimated !== null ? "estimated" : null;
    return { actual, basis, rent: basis === "actual" ? actual : basis === "estimated" ? estimated : null };
  });
  const actualRent = completeScope && unitSelections.every(unit => unit.actual !== null) &&
    actual.count === units.length ? actual.amount : null;
  const estimatedRent = completeScope && expected.count === units.length ? expected.amount : null;
  const completeRent = completeScope && unitSelections.every(unit => unit.rent !== null);
  const basis = !completeRent ? null : unitSelections.every(unit => unit.basis === "actual") ? "actual" :
    unitSelections.every(unit => unit.basis === "estimated") ? "estimated" : "mixed";
  const rent = completeRent ? unitSelections.reduce((sum, unit) => sum + unit.rent!, 0) : null;
  return {
    actualRent, estimatedRent, basis, rent, unitSelections,
    amount: rent !== null && piti?.taxIncluded ? rent - piti.monthlyTotal : null,
    reason: rent === null ? "Unit rent incomplete or unsupported, or whole-building unit count incomplete" :
      !piti?.taxIncluded ? "PITI incomplete or unavailable" : null,
  };
}
