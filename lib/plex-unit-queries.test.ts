import { expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
vi.mock("./db", () => ({ withReadOnlyClient: vi.fn() }));
import { withReadOnlyClient } from "./db";
import { fetchPlexUnitSummaries, PLEX_UNIT_SQL } from "./plex-unit-queries";

it("projects unit keys inside PostgreSQL and returns only typed allowlisted fields", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ property_id: "test", field: "unit_mix", source: "test-source", observed_at: "2026-01-01",
    value: [{ bedrooms: 2, actualRent: 1000, owner: "must not escape" }], raw: "must not escape" }] });
  vi.mocked(withReadOnlyClient).mockImplementation(fn => fn({ query } as unknown as PoolClient));
  const result = await fetchPlexUnitSummaries(["test"]);
  expect(query).toHaveBeenCalledWith(PLEX_UNIT_SQL, [["test"]]);
  expect(PLEX_UNIT_SQL).toContain("p.track = 'plex'");
  expect(PLEX_UNIT_SQL).toContain("jsonb_build_object");
  expect(PLEX_UNIT_SQL).not.toMatch(/\braw\b|payload|source_ref|SELECT\s+\*|THEN o.value\s*WHEN o.field = 'unit_mix'/);
  expect(JSON.stringify([...result.values()])).not.toMatch(/owner|must not escape|property_id|"value"/);
  query.mockClear();
  expect((await fetchPlexUnitSummaries([])).size).toBe(0);
  expect(query).not.toHaveBeenCalled();
});
