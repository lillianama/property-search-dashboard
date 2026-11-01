import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { StatusDistributionChart } from "../app/components/charts/StatusDistributionChart";

it("renders decision precedence and counts as accessible chart text", () => {
  const html = renderToStaticMarkup(createElement(StatusDistributionChart, { data: [
    { status: "Rejected", count: 3 }, { status: "Active", count: 2 },
  ] }));
  expect(html).toContain('role="img"');
  expect(html).toContain("Tracked property breakdown. Each property counts once. Rejected: 3. Active: 2.");
  expect(html).toContain("Rejected = your saved decision");
  expect(html).toContain("other categories show current listing status");
  expect(html).toContain("View breakdown as text");
  expect(html).toContain("<li>Rejected: 3</li>");
});
