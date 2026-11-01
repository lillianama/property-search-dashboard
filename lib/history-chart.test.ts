import { describe, expect, it } from "vitest";
import { buildHistoryView } from "./history-chart";

const now = new Date("2026-01-15T12:00:00Z");
const point = (month: string, eventCount = 1) => ({ month, eventCount });

describe("historical record calendar views", () => {
  it("anchors 12 consecutive months to today across year rollover, filling gaps", () => {
    const view = buildHistoryView([point("1985-01"), point("2025-02", 2), point("2026-01")], false, now);
    expect(view.buckets).toHaveLength(12);
    expect(view.buckets[0]).toEqual({ label: "Feb 2025", count: 2 });
    expect(view.buckets[1].count).toBe(0);
    expect(view.buckets[11]).toEqual({ label: "Jan 2026", count: 1 });
    expect(view.total).toBe(3);
  });
  it("preserves 1985 with consecutive yearly spacing and zero years", () => {
    const view = buildHistoryView([point("1985-03"), point("1985-12", 2), point("2026-01")], true, now);
    expect(view.buckets).toHaveLength(42);
    expect(view.buckets[0]).toEqual({ label: "1985", count: 3 });
    expect(view.buckets[1]).toEqual({ label: "1986", count: 0 });
    expect(view.total).toBe(4);
  });
  it("keeps an empty recent window anchored to today even with only old data", () => {
    for (const data of [[], [point("1985-01")]]) {
      const view = buildHistoryView(data, false, now);
      expect(view.buckets).toHaveLength(12);
      expect(view.total).toBe(0);
      expect(view.range).toBe("Feb 2025 – Jan 2026");
    }
    expect(buildHistoryView([], true, now).total).toBe(0);
  });
  it("excludes future months and invalid records in both views", () => {
    for (const all of [true, false]) {
      expect(buildHistoryView([point("2026-02"), point("2099-01"), point("2025-13"), point("bad")], all, now).total).toBe(0);
    }
  });
  it("uses Los Angeles month at the UTC month and year boundary", () => {
    const data = [point("2025-12"), point("2026-01", 9)];
    const before = buildHistoryView(data, false, new Date("2026-01-01T07:59:59Z"));
    expect(before.buckets[11].label).toBe("Dec 2025");
    expect(before.total).toBe(1);
    const after = buildHistoryView(data, false, new Date("2026-01-01T08:00:00Z"));
    expect(after.buckets[11].label).toBe("Jan 2026");
    expect(after.total).toBe(10);
  });
});
