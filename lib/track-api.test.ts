import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("./dashboard", () => ({ buildDashboardResponse: vi.fn(async () => ({})) }));
vi.mock("./rejected", () => ({ buildRejectedHousesResponse: vi.fn(async () => ({})) }));
vi.mock("./market-dashboard", () => ({ buildMarketResponse: vi.fn(async () => ({})) }));
vi.mock("./queries", () => ({ fetchEditorNoteRows: vi.fn(async () => null), fetchEditorJudgmentRows: vi.fn(), fetchPropertyLocation: vi.fn(async () => null) }));
vi.mock("./editor-writes", () => ({ executeEditorSave: vi.fn(async () => ({ ok: false, error: "not-found" })) }));
vi.mock("./funnel-writes", () => ({ executeFunnelMove: vi.fn(async () => ({ ok: false, error: "not-found" })) }));
import { buildDashboardResponse } from "./dashboard";
import { buildRejectedHousesResponse } from "./rejected";
import { buildMarketResponse } from "./market-dashboard";
import { fetchEditorNoteRows, fetchPropertyLocation } from "./queries";
import { executeEditorSave } from "./editor-writes";
import { executeFunnelMove } from "./funnel-writes";
import { GET as dashboard } from "../app/api/dashboard/route";
import { GET as rejected } from "../app/api/rejected/route";
import { GET as market } from "../app/api/market/route";
import { GET as editor, POST as save } from "../app/api/editor/[id]/route";
import { POST as move } from "../app/api/funnel/move/route";
import { GET as image } from "../app/api/street-view/[id]/route";
import { GET as metadata } from "../app/api/street-view/[id]/metadata/route";
const id = "aaaaaaaa-1111-4222-8333-444444444444";
const params = { params: Promise.resolve({ id }) };
function request(track: string, body?: unknown) {
  return new NextRequest(`https://dashboard.test/api?track=${track}&maxPrice=600000`, {
    method: body ? "POST" : "GET",
    headers: { origin: "https://dashboard.test", host: "dashboard.test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => vi.clearAllMocks());

describe("track propagation at every API boundary", () => {
  it.each(["house", "plex"] as const)("scopes dashboard, archive, market, editor and mutations to %s", async track => {
    await dashboard(request(track));
    expect(buildDashboardResponse).toHaveBeenCalledWith(expect.objectContaining({ maxPrice: 600000 }), track, "search");
    await rejected(request(track));
    expect(buildRejectedHousesResponse).toHaveBeenCalledWith(track);
    await market(request(track));
    expect(buildMarketResponse).toHaveBeenCalledWith(track);
    expect((await editor(request(track), params))?.status).toBe(404);
    expect(fetchEditorNoteRows).toHaveBeenCalledWith(id, track);
    expect((await save(request(track, { remarks: "note" }), params))?.status).toBe(404);
    expect(executeEditorSave).toHaveBeenCalledWith(id, expect.any(Object), track);
    expect((await move(request(track, { propertyId: id, action: "watchlist" }))).status).toBe(404);
    expect(executeFunnelMove).toHaveBeenCalledWith(expect.objectContaining({ propertyId: id }), track);
  });

  it("checks both Street View endpoints against the active track before contacting Google", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect((await image(request("plex"), params))?.status).toBe(404);
      expect((await metadata(request("plex"), params))?.status).toBe(404);
      expect(fetchPropertyLocation).toHaveBeenCalledWith(id, "plex");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

it.each(["house", "plex"] as const)("routes Pending and Sold database refreshes within %s", async track => {
  for (const view of ["pending", "sold"]) {
    await dashboard(new NextRequest(`https://dashboard.test/api/dashboard?track=${track}&lifecycle=${view}`));
    expect(buildDashboardResponse).toHaveBeenLastCalledWith(expect.any(Object), track, view);
  }
  await dashboard(new NextRequest(`https://dashboard.test/api/dashboard?track=${track}&lifecycle=invalid`));
  expect(buildDashboardResponse).toHaveBeenLastCalledWith(expect.any(Object), track, "search");
});
