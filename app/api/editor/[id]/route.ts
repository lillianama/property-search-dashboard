import { parseTrack } from "../../../../lib/track";
import { NextRequest } from "next/server";
import { DatabaseUnavailableError } from "../../../../lib/db";
import { parseEditorSaveRequest, selectCurrentJudgments, selectCurrentNotes } from "../../../../lib/editor";
import { executeEditorSave } from "../../../../lib/editor-writes";
import { isSameOriginRequest, isValidUuid } from "../../../../lib/funnel";
import { fetchEditorJudgmentRows, fetchEditorNoteRows } from "../../../../lib/queries";

export const dynamic = "force-dynamic";

// Editor notes are private judgments about specific houses; never let a
// shared cache hold them.
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Reads the current editor notes (Remarks / Pros / Cons) for one tracked
 * house. Returns ONLY those three non-sensitive editor fields — never
 * source listing remarks, raw payloads, or any other observation data.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidUuid(id)) {
    return Response.json({ error: "propertyId must be a UUID" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const rows = await fetchEditorNoteRows(id.toLowerCase(), parseTrack(new URL(request.url).searchParams.get("track")));
    if (rows === null) {
      return Response.json({ error: "unknown property" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const notes = selectCurrentNotes(rows);
    // Judgments are best-effort: a missing table (schema not applied yet)
    // degrades to all-unknown rather than losing the whole editor.
    try {
      const judgmentRows = await fetchEditorJudgmentRows(id.toLowerCase(), parseTrack(new URL(request.url).searchParams.get("track")));
      if (judgmentRows !== null) notes.judgments = selectCurrentJudgments(judgmentRows);
    } catch (err) {
      console.error("[api/editor] judgments read failure:", err instanceof Error ? err.message : err);
    }
    return Response.json({ notes }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json({ error: "database unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
    }
    console.error("[api/editor] read failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to load notes" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

/**
 * The property editor's narrow mutation endpoint: saves Remarks / Pros /
 * Cons for one tracked house. The body is strictly validated (only the
 * three known string fields, size-capped, normalized), the request must be
 * same-origin, and the write itself is one atomic transaction of
 * append-only parameterized INSERTs (lib/editor-writes.ts) — history is
 * never rewritten. There is deliberately no generic update surface here.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSameOriginRequest(request.headers.get("origin"), request.headers.get("host"))) {
    return Response.json({ error: "cross-origin requests are not allowed" }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return Response.json({ error: "propertyId must be a UUID" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be valid JSON" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const parsed = parseEditorSaveRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const outcome = await executeEditorSave(id.toLowerCase(), parsed.request, parseTrack(new URL(request.url).searchParams.get("track")));
    if (!outcome.ok) {
      return Response.json({ error: "unknown property" }, { status: 404, headers: NO_STORE_HEADERS });
    }
    return Response.json(
      { ok: true, changedFields: outcome.changedFields, notes: outcome.notes },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return Response.json({ error: "database unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
    }
    console.error("[api/editor] write failure:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to save notes" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
