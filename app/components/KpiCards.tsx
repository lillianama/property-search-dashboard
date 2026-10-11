import { formatCurrency, formatRelativeFreshness } from "../../lib/format";
import type { DashboardSummary } from "../../lib/types";

export function KpiCards({ summary }: { summary: DashboardSummary }) {
  const cards = [
    {
      label: "Known properties (filtered)",
      value: String(summary.knownHouses),
      hint: `${summary.unknownStatus} with unknown status`,
    },
    {
      label: "Active / pending",
      value: `${summary.active} / ${summary.pending}`,
      hint: `${summary.unverified} unverified · ${summary.inactive} inactive · ${summary.sold} sold`,
    },
    {
      label: "Median latest price",
      value: formatCurrency(summary.medianLatestPrice),
      hint: "Across properties with a known listed price",
    },
    {
      label: "Median recorded sale price",
      value: formatCurrency(summary.medianSalePrice),
      hint: "From logged sold events only",
    },
    {
      label: "Data freshness",
      value: formatRelativeFreshness(summary.dataFreshness),
      hint: "Most recent research update in this filtered set",
    },
  ];

  return (
    <section className="kpi-grid">
      {cards.map((card) => (
        <article key={card.label} className="kpi-card">
          <p className="kpi-label">{card.label}</p>
          <p className="kpi-value">{card.value}</p>
          <p className="kpi-hint">{card.hint}</p>
        </article>
      ))}
    </section>
  );
}
