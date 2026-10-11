import { describe, expect, it } from "vitest";
import { applyEditorSaveToHouses, type EditorNotes } from "./editor";
import type { QuickJudgments } from "./types";
import { UNKNOWN_JUDGMENTS } from "./types";

interface Row {
  id: string;
  judgments: QuickJudgments;
  address: string;
}

function row(id: string, judgments: Partial<QuickJudgments> = {}): Row {
  return { id, address: `${id} street`, judgments: { ...UNKNOWN_JUDGMENTS, ...judgments } };
}

function confirmedNotes(judgments: Partial<QuickJudgments> = {}): EditorNotes {
  return {
    remarks: { value: "some remarks", savedAt: "2026-07-19T00:00:00Z" },
    pros: null,
    cons: null,
    judgments: { ...UNKNOWN_JUDGMENTS, ...judgments },
  };
}

describe("applyEditorSaveToHouses (immediate post-save row update)", () => {
  it("applies the server-confirmed judgments to exactly the saved house", () => {
    const houses = [row("a"), row("b"), row("c")];
    const updated = applyEditorSaveToHouses(houses, "b", confirmedNotes({ drumSpace: "yes", rentalIncome: "no" }));

    expect(updated).not.toBe(houses);
    expect(updated[1].judgments).toEqual({ bedroomSizeOk: "unknown", rentalIncome: "no", drumSpace: "yes" });
    // Untouched rows keep their exact identity so memoized children skip re-render.
    expect(updated[0]).toBe(houses[0]);
    expect(updated[2]).toBe(houses[2]);
  });

  it("returns the input array unchanged for an unknown property id", () => {
    const houses = [row("a")];
    expect(applyEditorSaveToHouses(houses, "nope", confirmedNotes({ drumSpace: "yes" }))).toBe(houses);
  });

  it("returns the input array unchanged when the confirmed judgments equal the current ones", () => {
    const houses = [row("a", { drumSpace: "yes" })];
    expect(applyEditorSaveToHouses(houses, "a", confirmedNotes({ drumSpace: "yes" }))).toBe(houses);
  });

  it("does not mutate the original rows (failed saves keep old state trivially)", () => {
    const houses = [row("a")];
    const before = JSON.parse(JSON.stringify(houses));
    applyEditorSaveToHouses(houses, "a", confirmedNotes({ bedroomSizeOk: "no" }));
    expect(houses).toEqual(before);
  });
});
