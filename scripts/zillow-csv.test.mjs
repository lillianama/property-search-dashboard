import { describe, expect, it } from "vitest";
import { buildColumnIndex, metaField, parseCsvLine, rowToRecords } from "./zillow-csv.mjs";

describe("parseCsvLine", () => {
  it("splits unquoted fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsvLine('13373,"Portland-Vancouver-Hillsboro, OR-WA",OR')).toEqual([
      "13373",
      "Portland-Vancouver-Hillsboro, OR-WA",
      "OR",
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvLine('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
  });

  it("preserves empty fields", () => {
    expect(parseCsvLine("a,,c,")).toEqual(["a", "", "c", ""]);
  });
});

describe("buildColumnIndex", () => {
  it("separates metadata columns from date columns", () => {
    const { meta, dateColumns } = buildColumnIndex([
      "RegionID",
      "RegionName",
      "State",
      "2024-01-31",
      "2024-02-29",
    ]);
    expect(meta).toEqual({ RegionID: 0, RegionName: 1, State: 2 });
    expect(dateColumns).toEqual([
      { index: 3, month: "2024-01-31" },
      { index: 4, month: "2024-02-29" },
    ]);
  });
});

describe("rowToRecords", () => {
  const dateColumns = [
    { index: 2, month: "2024-01-31" },
    { index: 3, month: "2024-02-29" },
    { index: 4, month: "2024-03-31" },
  ];

  it("unpivots numeric cells and skips blanks", () => {
    expect(rowToRecords(["13373", "Portland", "1775.0", "", "1997.5"], dateColumns)).toEqual([
      { month: "2024-01-31", value: 1775 },
      { month: "2024-03-31", value: 1997.5 },
    ]);
  });

  it("skips non-numeric cells without throwing", () => {
    expect(rowToRecords(["13373", "Portland", "n/a", "12", undefined], dateColumns)).toEqual([
      { month: "2024-02-29", value: 12 },
    ]);
  });
});

describe("metaField", () => {
  it("reads named metadata cells", () => {
    const { meta } = buildColumnIndex(["RegionID", "City", "2024-01-31"]);
    expect(metaField(["1", "Portland", "5"], meta, "City")).toBe("Portland");
  });

  it("returns empty string for missing columns or cells", () => {
    const { meta } = buildColumnIndex(["RegionID"]);
    expect(metaField(["1"], meta, "City")).toBe("");
    expect(metaField([], meta, "RegionID")).toBe("");
  });
});
