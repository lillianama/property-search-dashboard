import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryChart } from "../app/components/charts/HistoryChart";

const period = vi.hoisted(() => ({ all: false }));
vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(period.all || initial) };
});
afterEach(() => { vi.useRealTimers(); period.all = false; });

it("renders the recent calendar, current cohort price basis and explicit unknown prices", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  const html = renderToStaticMarkup(createElement(HistoryChart, { data: [
    { month: "2025-11", eventCount: 2, medianPrice: 450000 },
    { month: "2026-01", eventCount: 1, medianPrice: null },
  ] }));
  expect(html).toContain('aria-pressed="true">Last 12 months');
  expect(html).toContain("Feb 2025 – Jan 2026");
  expect(html).toContain("3 properties added");
  expect(html).toContain("Nov 2025: 2 · Median known price: $450,000");
  expect(html).toContain("Dec 2025: 0 · Median known price: Unknown");
  expect(html).toContain("Jan 2026: 1 · Median known price: Unknown");
  expect(html).toContain("Current stored listing or sale prices, grouped by month added. Sale price preferred for sold properties. Unknown prices leave gaps.");
});

it("renders All history as monthly counts and current cohort medians with null gaps", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  period.all = true;
  const html = renderToStaticMarkup(createElement(HistoryChart, { data: [
    { month: "2024-11", eventCount: 2, medianPrice: 450000 },
    { month: "2026-01", eventCount: 1, medianPrice: null },
  ] }));
  expect(html).toContain('aria-pressed="true">All history');
  expect(html).toContain("Nov 2024: 2 · Median known price: $450,000");
  expect(html).toContain("Dec 2024: 0 · Median known price: Unknown");
  expect(html).toContain("Jan 2026: 1 · Median known price: Unknown");
  expect(html).toContain("Monthly counts");
});
