import { parseTrack } from "../../../../lib/track";
import { NextRequest } from "next/server";
import { fetchPropertyLocation } from "../../../../lib/queries";
import { resolveStreetView } from "../../../../lib/streetview-proxy";

export const dynamic = "force-dynamic";

// Google's terms disallow caching Street View bytes, and the imagery is tied
// to a private research dashboard anyway: never store, never share caches.
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Server-side Street View image proxy, keyed by property ID. The browser
 * never sees the GOOGLE_CLOUD_API_KEY or any Google URL: it requests
 * /api/street-view/<id> and gets image bytes (with Google's attribution
 * embedded by Google in the image itself) or a JSON error.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await resolveStreetView(id, "image", {
    apiKey: process.env.GOOGLE_CLOUD_API_KEY,
    fetchLocation: (propertyId) => fetchPropertyLocation(propertyId, parseTrack(new URL(request.url).searchParams.get("track"))),
  });

  switch (result.type) {
    case "image":
      return new Response(result.body, {
        status: 200,
        headers: { ...NO_STORE_HEADERS, "Content-Type": result.contentType },
      });
    case "not_found":
      return Response.json(
        { error: "no street view image for this property" },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    case "no_api_key":
      return Response.json(
        { error: "street view is not configured" },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    case "upstream_error":
      // reason stays server-side; it can mention upstream statuses but never
      // URLs or the API key.
      console.error("[street-view] image proxy failed:", result.reason);
      return Response.json(
        { error: "street view is currently unavailable" },
        { status: 502, headers: NO_STORE_HEADERS },
      );
  }
}
