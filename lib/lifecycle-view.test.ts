import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HouseRecord } from "./types";
import { LifecycleTable } from "../app/components/LifecycleTable";

vi.mock("../app/components/PropertyPhoto", () => ({ PropertyPhoto: () => null }));
const house = (displayStatus: HouseRecord["displayStatus"], soldPrice?: number): HouseRecord => ({
  id: displayStatus, address: `${displayStatus} Example St`, displayStatus, latestPrice: 999999,
  saleComparison: { soldPrice }, bedroomSizeFlag: "unknown", bedrooms: 3, yearBuilt: 1920,
} as HouseRecord);

describe("simple lifecycle views", () => {
  it("shows recorded sold price or Unknown, and keeps inactive/pending latest prices and detail entry points", () => {
    const html = renderToStaticMarkup(createElement(LifecycleTable, {
      properties: [house("Sold", 480000), house("Sold"), house("Inactive"), house("Pending")],
      highlightId: "Inactive", onEditNotes: () => {},
    }));
    expect(html).toContain("<td>$480,000</td>");
    expect(html).toContain("<td>Unknown</td>");
    expect(html.match(/<td>\$999,999<\/td>/g)).toHaveLength(2);
    expect(html).toContain("Recorded sold price: $480,000");
    expect(html).toContain('aria-label="Edit notes for Inactive Example St"');
    expect(html).toContain('class="funnel-row-editor-return"');
    expect(html).toContain("Inactive</span>");
    expect(html).not.toContain("Recorded sold price: $999,999");
  });
});
