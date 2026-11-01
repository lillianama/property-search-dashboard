import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryChart } from "../app/components/charts/HistoryChart";

afterEach(() => vi.useRealTimers());

it("renders the recent calendar, sold-price basis and explicit unknown prices", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  const html = renderToStaticMarkup(createElement(HistoryChart, { data: [
    { month: "2025-11", eventCount: 2, medianPrice: 450000 },
    { month: "2026-01", eventCount: 1, medianPrice: null },
  ] }));
  expect(html).toContain('aria-pressed="true">Last 12 months');
  expect(html).toContain("Feb 2025 – Jan 2026");
  expect(html).toContain("3 historical records");
  expect(html).toContain("Nov 2025: 2 · Median sold price: $450,000");
  expect(html).toContain("Dec 2025: 0 · Median sold price: Unknown");
  expect(html).toContain("Jan 2026: 1 · Median sold price: Unknown");
  expect(html).toContain("Monthly median recorded sale price. Missing sale prices leave gaps.");
});
