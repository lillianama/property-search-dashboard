import { expect, it, vi } from "vitest";
vi.mock("./market-queries", () => ({
  fetchCityMetricPoints: vi.fn(), fetchLastIngestRun: vi.fn(),
  fetchNeighborhoodZhviPoints: vi.fn(), fetchPreferenceMatchCounts: vi.fn(),
}));
import { buildMarketResponse } from "./market-dashboard";
import * as queries from "./market-queries";

it("does not expose single-family market series or house preference counts in Plexes", async () => {
  const result = await buildMarketResponse("plex");
  expect(result.cityMetrics).toEqual([]);
  expect(result.neighborhoods.rows).toEqual([]);
  expect(result.preferenceMatch).toBeNull();
  expect(result.meta.dataAvailable).toBe(false);
  expect(result.meta.sourceNote).toContain("Plex market data is not available");
  for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled();
});
