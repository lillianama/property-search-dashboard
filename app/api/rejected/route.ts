import { NextRequest } from "next/server";
import { parseTrack } from "../../../lib/track";
import { buildRejectedHousesResponse } from "../../../lib/rejected";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const data = await buildRejectedHousesResponse(parseTrack(new URL(request.url).searchParams.get("track")));
    return Response.json(data);
  } catch (err) {
    // buildRejectedHousesResponse already swallows DB-unavailability
    // internally; this is a last-resort guard so an unexpected bug never
    // leaks details.
    console.error("[api/rejected] unexpected failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to load rejected houses" }, { status: 500 });
  }
}
