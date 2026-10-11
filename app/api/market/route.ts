import { NextRequest } from "next/server";
import { parseTrack } from "../../../lib/track";
import { buildMarketResponse } from "../../../lib/market-dashboard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const data = await buildMarketResponse(parseTrack(new URL(request.url).searchParams.get("track")));
    return Response.json(data);
  } catch (err) {
    // buildMarketResponse already swallows DB-unavailability internally;
    // this is a last-resort guard so an unexpected bug never leaks details.
    console.error("[api/market] unexpected failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to load market data" }, { status: 500 });
  }
}
