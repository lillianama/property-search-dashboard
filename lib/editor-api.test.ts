// API-level tests for the /api/editor/[id] route: validation, same-origin
// enforcement, not-found, and database-unavailable behavior — with the data
// layer mocked so no database is needed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("./db", () => ({
  DatabaseUnavailableError: class DatabaseUnavailableError extends Error {},
}));
vi.mock("./queries", () => ({
  fetchEditorNoteRows: vi.fn(),
  fetchEditorJudgmentRows: vi.fn(),
}));
vi.mock("./editor-writes", () => ({
  executeEditorSave: vi.fn(),
}));

import { DatabaseUnavailableError } from "./db";
import { executeEditorSave } from "./editor-writes";
import { fetchEditorJudgmentRows, fetchEditorNoteRows } from "./queries";
import { GET, POST } from "../app/api/editor/[id]/route";

const UUID = "eeeeeeee-1111-4222-8333-444444444444";

function request(options: {
  method?: string;
  body?: unknown;
  origin?: string;
  host?: string;
}): NextRequest {
  const headers = new Headers();
  if (options.origin) headers.set("origin", options.origin);
  headers.set("host", options.host ?? "dashboard.example.com");
  return new Request(`https://dashboard.example.com/api/editor/${UUID}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  }) as unknown as NextRequest;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.mocked(fetchEditorNoteRows).mockReset();
  vi.mocked(fetchEditorJudgmentRows).mockReset();
  vi.mocked(fetchEditorJudgmentRows).mockResolvedValue([]);
  vi.mocked(executeEditorSave).mockReset();
});

describe("GET /api/editor/[id]", () => {
  it("rejects non-UUID ids", async () => {
    const res = await GET(request({}), params("1; DROP TABLE property_records"));
    expect(res.status).toBe(400);
  });

  it("404s for unknown properties", async () => {
    vi.mocked(fetchEditorNoteRows).mockResolvedValue(null);
    const res = await GET(request({}), params(UUID));
    expect(res.status).toBe(404);
  });

  it("returns only the editor fields and judgments, never anything else", async () => {
    vi.mocked(fetchEditorNoteRows).mockResolvedValue([
      { field: "remarks", value: "my remarks", savedAt: "2026-07-18T00:00:00Z", id: 1 },
    ]);
    vi.mocked(fetchEditorJudgmentRows).mockResolvedValue([
      { field: "drum_space", verdict: "yes", savedAt: "2026-07-18T00:00:00Z", id: 1 },
    ]);
    const res = await GET(request({}), params(UUID));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const json = (await res.json()) as { notes: Record<string, unknown> };
    expect(Object.keys(json.notes).sort()).toEqual(["cons", "judgments", "pros", "remarks"]);
    expect(json.notes.remarks).toEqual({ value: "my remarks", savedAt: "2026-07-18T00:00:00Z" });
    expect(json.notes.judgments).toEqual({
      bedroomSizeOk: "unknown",
      rentalIncome: "unknown",
      drumSpace: "yes",
    });
  });

  it("degrades judgments to all-unknown when the judgments table is missing", async () => {
    vi.mocked(fetchEditorNoteRows).mockResolvedValue([]);
    vi.mocked(fetchEditorJudgmentRows).mockRejectedValue(new Error("relation does not exist"));
    const res = await GET(request({}), params(UUID));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { notes: { judgments: Record<string, string> } };
    expect(json.notes.judgments).toEqual({
      bedroomSizeOk: "unknown",
      rentalIncome: "unknown",
      drumSpace: "unknown",
    });
  });

  it("returns 503 when the database is unavailable", async () => {
    vi.mocked(fetchEditorNoteRows).mockRejectedValue(new DatabaseUnavailableError("no pool"));
    const res = await GET(request({}), params(UUID));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/editor/[id]", () => {
  it("refuses cross-origin requests before doing anything", async () => {
    const res = await POST(
      request({ method: "POST", body: { remarks: "x" }, origin: "https://evil.example.net" }),
      params(UUID),
    );
    expect(res.status).toBe(403);
    expect(executeEditorSave).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies without writing", async () => {
    const res = await POST(
      request({ method: "POST", body: { remarks: 42 }, origin: "https://dashboard.example.com" }),
      params(UUID),
    );
    expect(res.status).toBe(400);
    expect(executeEditorSave).not.toHaveBeenCalled();
  });

  it("saves valid fields and echoes the persisted notes", async () => {
    vi.mocked(executeEditorSave).mockResolvedValue({
      ok: true,
      changedFields: ["remarks"],
      notes: {
        remarks: { value: "hello", savedAt: "2026-07-18T16:00:00Z" },
        pros: null,
        cons: null,
        judgments: { bedroomSizeOk: "unknown", rentalIncome: "unknown", drumSpace: "yes" },
      },
    });
    const res = await POST(
      request({
        method: "POST",
        body: { remarks: "hello", drumSpace: "yes" },
        origin: "https://dashboard.example.com",
      }),
      params(UUID),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; changedFields: string[] };
    expect(json.ok).toBe(true);
    expect(json.changedFields).toEqual(["remarks"]);
    expect(executeEditorSave).toHaveBeenCalledWith(UUID, {
      fields: { remarks: "hello" },
      judgments: { drumSpace: "yes" },
    }, "house");
  });

  it("rejects invalid judgment verdicts without writing", async () => {
    const res = await POST(
      request({ method: "POST", body: { drumSpace: "maybe" }, origin: "https://dashboard.example.com" }),
      params(UUID),
    );
    expect(res.status).toBe(400);
    expect(executeEditorSave).not.toHaveBeenCalled();
  });

  it("404s for unknown properties", async () => {
    vi.mocked(executeEditorSave).mockResolvedValue({ ok: false, error: "not-found" });
    const res = await POST(
      request({ method: "POST", body: { remarks: "x" }, origin: "https://dashboard.example.com" }),
      params(UUID),
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when the database is unavailable", async () => {
    vi.mocked(executeEditorSave).mockRejectedValue(new DatabaseUnavailableError("no pool"));
    const res = await POST(
      request({ method: "POST", body: { remarks: "x" }, origin: "https://dashboard.example.com" }),
      params(UUID),
    );
    expect(res.status).toBe(503);
  });
});
