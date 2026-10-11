import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_LENGTH,
  normalizeFieldValue,
  parseEditorSaveRequest,
  selectCurrentJudgments,
  selectCurrentNotes,
  splitEntries,
  type EditorNoteRevisionRow,
  type JudgmentRevisionRow,
} from "./editor";

describe("normalizeFieldValue", () => {
  it("normalizes CRLF/CR to LF and strips trailing whitespace per line", () => {
    expect(normalizeFieldValue("line one \r\nline two\t\rline three")).toBe(
      "line one\nline two\nline three",
    );
  });

  it("drops leading/trailing blank lines but preserves internal ones", () => {
    expect(normalizeFieldValue("\n\nfirst\n\nsecond\n\n")).toBe("first\n\nsecond");
  });

  it("preserves entry order and content exactly", () => {
    const value = "Big yard\nQuiet street\nNear the bakery";
    expect(normalizeFieldValue(value)).toBe(value);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeFieldValue("  \n\t\n ")).toBe("");
  });
});

describe("splitEntries", () => {
  it("splits line-separated entries, skipping blanks", () => {
    expect(splitEntries("Big yard\n\n  Quiet street  \nNear the bakery")).toEqual([
      "Big yard",
      "Quiet street",
      "Near the bakery",
    ]);
  });

  it("returns content verbatim — HTML-ish text stays text", () => {
    expect(splitEntries("<script>alert(1)</script>\nfine")).toEqual([
      "<script>alert(1)</script>",
      "fine",
    ]);
  });
});

describe("parseEditorSaveRequest", () => {
  it("accepts any subset of the three fields and normalizes them", () => {
    const parsed = parseEditorSaveRequest({ remarks: "hello \r\nthere\n", pros: "one\ntwo" });
    expect(parsed).toEqual({
      ok: true,
      request: { fields: { remarks: "hello\nthere", pros: "one\ntwo" }, judgments: {} },
    });
  });

  it("accepts an explicit empty string as 'clear this field'", () => {
    const parsed = parseEditorSaveRequest({ cons: "" });
    expect(parsed).toEqual({ ok: true, request: { fields: { cons: "" }, judgments: {} } });
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, "text", 42, [1, 2]]) {
      expect(parseEditorSaveRequest(body).ok).toBe(false);
    }
  });

  it("rejects non-string field values", () => {
    expect(parseEditorSaveRequest({ remarks: 42 })).toEqual({
      ok: false,
      error: "remarks must be a string",
    });
    expect(parseEditorSaveRequest({ pros: ["a", "b"] }).ok).toBe(false);
  });

  it("rejects oversized fields", () => {
    const parsed = parseEditorSaveRequest({ remarks: "x".repeat(MAX_FIELD_LENGTH + 1) });
    expect(parsed).toEqual({
      ok: false,
      error: `remarks must be at most ${MAX_FIELD_LENGTH} characters`,
    });
  });

  it("rejects bodies with none of the known fields (unknown keys are ignored, not written)", () => {
    expect(parseEditorSaveRequest({}).ok).toBe(false);
    const parsed = parseEditorSaveRequest({ owner: "someone", sqlInjection: "drop table" });
    expect(parsed.ok).toBe(false);
  });

  it("never lets unknown keys through alongside valid ones", () => {
    const parsed = parseEditorSaveRequest({ remarks: "ok", verdict: "reject", extra: 1 });
    expect(parsed).toEqual({ ok: true, request: { fields: { remarks: "ok" }, judgments: {} } });
  });
});

describe("selectCurrentNotes", () => {
  const rev = (overrides: Partial<EditorNoteRevisionRow>): EditorNoteRevisionRow => ({
    field: "remarks",
    value: "v",
    savedAt: "2026-07-18T00:00:00Z",
    id: 1,
    ...overrides,
  });

  it("returns null for fields never edited", () => {
    expect(selectCurrentNotes([])).toEqual({
      remarks: null,
      pros: null,
      cons: null,
      judgments: { bedroomSizeOk: "unknown", rentalIncome: "unknown", drumSpace: "unknown" },
    });
  });

  it("picks the latest revision per field (history preserved, latest shown)", () => {
    const notes = selectCurrentNotes([
      rev({ id: 1, value: "first draft", savedAt: "2026-07-17T00:00:00Z" }),
      rev({ id: 2, value: "second draft", savedAt: "2026-07-18T00:00:00Z" }),
      rev({ id: 3, field: "pros", value: "Big yard", savedAt: "2026-07-17T12:00:00Z" }),
    ]);
    expect(notes.remarks).toEqual({ value: "second draft", savedAt: "2026-07-18T00:00:00Z" });
    expect(notes.pros).toEqual({ value: "Big yard", savedAt: "2026-07-17T12:00:00Z" });
    expect(notes.cons).toBeNull();
  });

  it("breaks identical timestamps by row id", () => {
    const notes = selectCurrentNotes([
      rev({ id: 5, value: "older insert" }),
      rev({ id: 9, value: "newer insert" }),
    ]);
    expect(notes.remarks?.value).toBe("newer insert");
  });

  it("ignores unknown field names from future schema changes", () => {
    const notes = selectCurrentNotes([rev({ field: "secret_field", value: "x" })]);
    expect(notes).toEqual({
      remarks: null,
      pros: null,
      cons: null,
      judgments: { bedroomSizeOk: "unknown", rentalIncome: "unknown", drumSpace: "unknown" },
    });
  });
});

describe("quick preference judgments", () => {
  const jrev = (overrides: Partial<JudgmentRevisionRow>): JudgmentRevisionRow => ({
    field: "drum_space",
    verdict: "yes",
    savedAt: "2026-07-18T00:00:00Z",
    id: 1,
    ...overrides,
  });

  it("parses valid tri-state judgments alongside note fields", () => {
    const parsed = parseEditorSaveRequest({ remarks: "ok", bedroomSizeOk: "yes", drumSpace: "no" });
    expect(parsed).toEqual({
      ok: true,
      request: { fields: { remarks: "ok" }, judgments: { bedroomSizeOk: "yes", drumSpace: "no" } },
    });
  });

  it("accepts a judgments-only body and an explicit 'unknown' verdict", () => {
    const parsed = parseEditorSaveRequest({ rentalIncome: "unknown" });
    expect(parsed).toEqual({ ok: true, request: { fields: {}, judgments: { rentalIncome: "unknown" } } });
  });

  it("rejects anything outside yes/no/unknown — never coerces", () => {
    for (const bad of ["maybe", "", true, false, 1, null, "YES"]) {
      expect(parseEditorSaveRequest({ drumSpace: bad }).ok).toBe(false);
    }
  });

  it("defaults every field to unknown when there are no revisions", () => {
    expect(selectCurrentJudgments([])).toEqual({
      bedroomSizeOk: "unknown",
      rentalIncome: "unknown",
      drumSpace: "unknown",
    });
  });

  it("picks the latest revision per field, breaking timestamp ties by id", () => {
    const judgments = selectCurrentJudgments([
      jrev({ id: 1, verdict: "no", savedAt: "2026-07-17T00:00:00Z" }),
      jrev({ id: 2, verdict: "yes", savedAt: "2026-07-18T00:00:00Z" }),
      jrev({ id: 3, field: "bedroom_size_ok", verdict: "no" }),
      jrev({ id: 4, field: "bedroom_size_ok", verdict: "yes" }),
    ]);
    expect(judgments.drumSpace).toBe("yes");
    expect(judgments.bedroomSizeOk).toBe("yes");
    expect(judgments.rentalIncome).toBe("unknown");
  });

  it("ignores unknown fields and malformed verdicts (staying unknown, never no)", () => {
    const judgments = selectCurrentJudgments([
      jrev({ field: "secret", verdict: "yes" }),
      jrev({ field: "rental_income", verdict: "garbage" }),
    ]);
    expect(judgments).toEqual({
      bedroomSizeOk: "unknown",
      rentalIncome: "unknown",
      drumSpace: "unknown",
    });
  });
});
