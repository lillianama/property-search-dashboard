import { parseTrack } from "../../../../lib/track";
import { NextRequest } from "next/server";
import { DatabaseUnavailableError } from "../../../../lib/db";
import { isSameOriginRequest, parseFunnelMoveRequest } from "../../../../lib/funnel";
import { executeFunnelMove } from "../../../../lib/funnel-writes";

export const dynamic = "force-dynamic";

/**
 * The single, narrow mutation endpoint in this app: moves one house between
 * My Search funnel buckets or into Rejected. The body is strictly validated
 * (UUID propertyId, allowlisted action, optional short reject note), the
 * request must be same-origin, and the write itself is one atomic
 * transaction over allowlisted parameterized statements (lib/funnel-writes).
 * There is deliberately no generic update or SQL surface here.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request.headers.get("origin"), request.headers.get("host"))) {
    return Response.json({ error: "cross-origin requests are not allowed" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  const parsed = parseFunnelMoveRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const outcome = await executeFunnelMove(parsed.request, parseTrack(new URL(request.url).searchParams.get("track")));
    if (!outcome.ok) {
      if (outcome.error === "stale-order") {
        // The requested neighbors no longer reflect the persisted order (a
        // concurrent move landed first). Nothing was written; the client
        // rolls back its optimistic placement and refreshes.
        return Response.json({ error: "stale order; reload and retry" }, { status: 409 });
      }
      return Response.json({ error: "unknown property" }, { status: 404 });
    }
    return Response.json({ ok: true, changed: outcome.changed });
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json({ error: "database unavailable" }, { status: 503 });
    }
    console.error("[api/funnel/move] write failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to apply move" }, { status: 500 });
  }
}
