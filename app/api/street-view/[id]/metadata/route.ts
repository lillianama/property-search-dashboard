import { parseTrack } from "../../../../../lib/track";
import { NextRequest } from "next/server";
import { fetchPropertyLocation } from "../../../../../lib/queries";
import { resolveStreetView } from "../../../../../lib/streetview-proxy";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
};

/**
 * Sanitized Street View availability check for one property, backed by
 * Google's free metadata endpoint. Returns only whether outdoor imagery
 * exists plus its capture date and copyright line, so the UI can label the
 * image truthfully ("Street View · Jun 2024") before requesting it. Never
 * exposes panorama IDs, Google URLs, or the API key.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await resolveStreetView(id, "metadata", {
    apiKey: process.env.GOOGLE_CLOUD_API_KEY,
    fetchLocation: (propertyId) => fetchPropertyLocation(propertyId, parseTrack(new URL(request.url).searchParams.get("track"))),
  });

  switch (result.type) {
    case "metadata":
      return Response.json(
        { available: true, imageryDate: result.imageryDate, copyright: result.copyright },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    case "not_found":
      return Response.json({ available: false }, { status: 404, headers: NO_STORE_HEADERS });
    case "no_api_key":
      return Response.json({ available: false }, { status: 503, headers: NO_STORE_HEADERS });
    case "upstream_error":
      console.error("[street-view] metadata check failed:", result.reason);
      return Response.json({ available: false }, { status: 502, headers: NO_STORE_HEADERS });
  }
}
