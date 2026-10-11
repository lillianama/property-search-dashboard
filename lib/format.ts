// Presentation-only formatting helpers. Pure and dependency-free so they are
// safe to import from client components without pulling in any server-only
// (database) code.

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, opts?: { fractionDigits?: number }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unknown";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: opts?.fractionDigits ?? 0,
  }).format(value);
}

/**
 * Build years are labels, not quantities: they must never pick up grouping
 * separators (1925, not 1,925). Dedicated formatter so no call site can
 * accidentally route a year through the grouped number formatter.
 */
export function formatYear(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unknown";
  return String(Math.trunc(value));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function formatMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short" }).format(date);
}

export function formatRelativeFreshness(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
