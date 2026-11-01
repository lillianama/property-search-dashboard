export interface HistoryCount {
  month: string;
  eventCount: number;
  medianPrice?: number | null;
}

/** Addition months use database ingestion in the Los Angeles calendar. */
export function buildHistoryView(data: HistoryCount[], allHistory: boolean, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")!.value);
  const month = Number(parts.find((part) => part.type === "month")!.value);
  const current = year * 12 + month - 1;
  const valid = data.flatMap((point) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(point.month)) return [];
    const [y, m] = point.month.split("-").map(Number);
    const index = y * 12 + m - 1;
    return y >= 1 && index <= current && Number.isFinite(point.eventCount) && point.eventCount > 0
      ? [{ index, count: point.eventCount }] : [];
  });
  const annual = false;
  const start = allHistory ? valid.reduce((earliest, point) => Math.min(earliest, point.index), current) : current - 11;
  const end = current;
  const counts = new Map<number, number>();
  for (const point of valid) {
    const key = point.index;
    if (key >= start) counts.set(key, (counts.get(key) ?? 0) + point.count);
  }
  const prices = new Map(data.map(point => [point.month, point.medianPrice]));
  const buckets = Array.from({ length: end - start + 1 }, (_, i) => {
    const key = start + i;
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", month: "short", year: "numeric",
    }).format(new Date(Date.UTC(Math.floor(key / 12), key % 12, 1)));
    const price = prices.get(`${Math.floor(key / 12)}-${String(key % 12 + 1).padStart(2, "0")}`);
    return { label, count: counts.get(key) ?? 0, medianPrice: typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null };
  });
  const currentLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", month: "short", year: "numeric",
  }).format(now);
  return {
    buckets, annual,
    range: `${buckets[0].label} – ${annual ? currentLabel : buckets[buckets.length - 1].label}`,
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}
