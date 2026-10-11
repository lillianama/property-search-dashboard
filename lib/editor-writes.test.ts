import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

// withWriteTransaction is replaced with a fake that hands executeEditorSave
// a scripted client, so these tests verify the exact statement sequence the
// write path issues — without a database.
vi.mock("./db", () => ({
  withWriteTransaction: vi.fn(),
  DatabaseUnavailableError: class DatabaseUnavailableError extends Error {},
}));

import { withWriteTransaction } from "./db";
import { executeEditorSave } from "./editor-writes";

const UUID = "eeeeeeee-1111-4222-8333-444444444444";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function fakeClient(options: {
  houseExists?: boolean;
  currentRows?: Array<{ field: string; value: string; saved_at: string | null }>;
  currentJudgmentRows?: Array<{ field: string; verdict: string }>;
}): { client: PoolClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("FROM property_records")) {
        return { rowCount: options.houseExists === false ? 0 : 1, rows: [] };
      }
      if (sql.includes("FROM property_editor_judgments")) {
        const rows = options.currentJudgmentRows ?? [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes("DISTINCT ON (field)")) {
        const rows = options.currentRows ?? [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes("INSERT INTO property_editor_notes")) {
        return { rowCount: 1, rows: [{ saved_at: "2026-07-18T16:00:00Z" }] };
      }
      return { rowCount: 1, rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, queries };
}

function useClient(client: PoolClient) {
  vi.mocked(withWriteTransaction).mockImplementation(async (fn) => fn(client));
}

beforeEach(() => {
  vi.mocked(withWriteTransaction).mockReset();
});

describe("executeEditorSave", () => {
  it("inserts one new revision per changed field and returns the persisted state", async () => {
    const { client, queries } = fakeClient({
      currentRows: [{ field: "remarks", value: "old remarks", saved_at: "2026-07-17T00:00:00Z" }],
    });
    useClient(client);

    const outcome = await executeEditorSave(UUID, {
      fields: { remarks: "new remarks", pros: "Big yard\nQuiet street" },
      judgments: {},
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changedFields).toEqual(["remarks", "pros"]);
    expect(outcome.notes.remarks).toEqual({ value: "new remarks", savedAt: "2026-07-18T16:00:00Z" });
    expect(outcome.notes.pros).toEqual({ value: "Big yard\nQuiet street", savedAt: "2026-07-18T16:00:00Z" });
    expect(outcome.notes.cons).toBeNull();

    const inserts = queries.filter((q) => q.sql.includes("INSERT INTO property_editor_notes"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toEqual([UUID, "remarks", "new remarks", "dashboard-editor"]);
    expect(inserts[1].params).toEqual([UUID, "pros", "Big yard\nQuiet street", "dashboard-editor"]);
  });

  it("NEVER issues UPDATE or DELETE statements — history is append-only", async () => {
    const { client, queries } = fakeClient({
      currentRows: [{ field: "remarks", value: "old", saved_at: null }],
    });
    useClient(client);

    await executeEditorSave(UUID, { fields: { remarks: "new", pros: "p", cons: "c" }, judgments: {} });

    // "FOR UPDATE" row locks are fine; UPDATE/DELETE statements are not.
    expect(queries.some((q) => /\bUPDATE\s+\w/i.test(q.sql))).toBe(false);
    expect(queries.some((q) => /\bDELETE\b/i.test(q.sql))).toBe(false);
  });

  it("skips unchanged fields entirely (clean no-op re-save)", async () => {
    const { client, queries } = fakeClient({
      currentRows: [
        { field: "remarks", value: "same remarks", saved_at: "2026-07-17T00:00:00Z" },
        { field: "pros", value: "same pros", saved_at: "2026-07-17T00:00:00Z" },
      ],
    });
    useClient(client);

    const outcome = await executeEditorSave(UUID, {
      fields: { remarks: "same remarks", pros: "same pros" },
      judgments: {},
    });

    expect(outcome).toMatchObject({ ok: true, changedFields: [] });
    expect(queries.some((q) => q.sql.includes("INSERT"))).toBe(false);
  });

  it("treats clearing a field to '' as a real revision, but not for never-edited fields", async () => {
    const { client, queries } = fakeClient({
      currentRows: [{ field: "remarks", value: "something", saved_at: null }],
    });
    useClient(client);

    const outcome = await executeEditorSave(UUID, { fields: { remarks: "", cons: "" }, judgments: {} });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // remarks had content → clearing it is recorded; cons was never edited
    // and clearing "nothing" writes nothing.
    expect(outcome.changedFields).toEqual(["remarks"]);
    const inserts = queries.filter((q) => q.sql.includes("INSERT INTO property_editor_notes"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[1]).toBe("remarks");
  });

  it("refuses unknown or non-house properties without writing", async () => {
    const { client, queries } = fakeClient({ houseExists: false });
    useClient(client);

    const outcome = await executeEditorSave(UUID, { fields: { remarks: "x" }, judgments: {} });

    expect(outcome).toEqual({ ok: false, error: "not-found" });
    expect(queries.some((q) => q.sql.includes("INSERT"))).toBe(false);
  });

  it("locks the property row so concurrent saves serialize", async () => {
    const { client, queries } = fakeClient({});
    useClient(client);

    await executeEditorSave(UUID, { fields: { remarks: "x" }, judgments: {} });

    const lock = queries.find((q) => q.sql.includes("FROM property_records"));
    expect(lock?.sql).toContain("FOR UPDATE");
    expect(lock?.params).toEqual([UUID, "house"]);
  });

  it("inserts append-only judgment revisions with the storage field names and echoes them back", async () => {
    const { client, queries } = fakeClient({});
    useClient(client);

    const outcome = await executeEditorSave(UUID, {
      fields: {},
      judgments: { bedroomSizeOk: "yes", drumSpace: "no" },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changedFields).toEqual(["bedroomSizeOk", "drumSpace"]);
    expect(outcome.notes.judgments).toEqual({
      bedroomSizeOk: "yes",
      rentalIncome: "unknown",
      drumSpace: "no",
    });

    const inserts = queries.filter((q) => q.sql.includes("INSERT INTO property_editor_judgments"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toEqual([UUID, "bedroom_size_ok", "yes", "dashboard-editor"]);
    expect(inserts[1].params).toEqual([UUID, "drum_space", "no", "dashboard-editor"]);
  });

  it("skips unchanged judgments, including implicit-unknown → explicit-unknown for never-judged fields", async () => {
    const { client, queries } = fakeClient({
      currentJudgmentRows: [{ field: "drum_space", verdict: "yes" }],
    });
    useClient(client);

    const outcome = await executeEditorSave(UUID, {
      fields: {},
      judgments: { drumSpace: "yes", rentalIncome: "unknown" },
    });

    expect(outcome).toMatchObject({ ok: true, changedFields: [] });
    expect(queries.some((q) => q.sql.includes("INSERT INTO property_editor_judgments"))).toBe(false);
  });

  it("records a genuine revert to unknown for a previously judged field", async () => {
    const { client, queries } = fakeClient({
      currentJudgmentRows: [{ field: "rental_income", verdict: "no" }],
    });
    useClient(client);

    const outcome = await executeEditorSave(UUID, { fields: {}, judgments: { rentalIncome: "unknown" } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changedFields).toEqual(["rentalIncome"]);
    const inserts = queries.filter((q) => q.sql.includes("INSERT INTO property_editor_judgments"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params?.[2]).toBe("unknown");
  });

  it("judgment writes never touch measured bedroom data (no property_bedroom_flags statements)", async () => {
    const { client, queries } = fakeClient({});
    useClient(client);

    await executeEditorSave(UUID, { fields: {}, judgments: { bedroomSizeOk: "no" } });

    expect(queries.some((q) => q.sql.includes("property_bedroom_flags"))).toBe(false);
    expect(queries.some((q) => /\bUPDATE\s+\w/i.test(q.sql))).toBe(false);
    expect(queries.some((q) => /\bDELETE\b/i.test(q.sql))).toBe(false);
  });

  it("propagates database failures so the API can report an honest error", async () => {
    const { client } = fakeClient({});
    vi.mocked(client.query).mockRejectedValueOnce(new Error("connection reset"));
    useClient(client);

    await expect(executeEditorSave(UUID, { fields: { remarks: "x" }, judgments: {} })).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("editor track guards", () => {
  it("refuses a foreign-track property before reading or appending revisions", async () => {
    const { client, queries } = fakeClient({ houseExists: false });
    vi.mocked(withWriteTransaction).mockImplementation(fn => fn(client));
    expect(await executeEditorSave(UUID, { fields: { remarks: "test" }, judgments: {} }, "plex")).toEqual({ ok: false, error: "not-found" });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("track = $2");
    expect(queries[0].params).toEqual([UUID, "plex"]);
  });

  it("appends Plexes notes and judgments behind the plex property guard", async () => {
    const { client, queries } = fakeClient({});
    vi.mocked(withWriteTransaction).mockImplementation(fn => fn(client));
    const result = await executeEditorSave(UUID, { fields: { remarks: "test" }, judgments: { drumSpace: "yes" } }, "plex");
    expect(result.ok).toBe(true);
    expect(queries[0].params).toEqual([UUID, "plex"]);
    expect(queries.filter(q => q.sql.includes("INSERT INTO")).map(q => q.params[0])).toEqual([UUID, UUID]);
  });
});
