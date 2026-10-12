import { parseLifecycleView } from "../../../lib/lifecycle";
import { parseTrack } from "../../../lib/track";
import { NextRequest } from "next/server";
import { buildDashboardResponse } from "../../../lib/dashboard";
import { parseHouseFilters } from "../../../lib/filters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseHouseFilters(request.nextUrl.searchParams);
  try {
    const data = await buildDashboardResponse(filters, parseTrack(new URL(request.url).searchParams.get("track")), parseLifecycleView(request.nextUrl.searchParams.get("lifecycle")));
    return Response.json(data);
  } catch (err) {
    // buildDashboardResponse already swallows DB-unavailability internally;
    // this is a last-resort guard so an unexpected bug never leaks details.
    console.error("[api/dashboard] unexpected failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to load dashboard data" }, { status: 500 });
  }
}
