"use client";

import { useTrack } from "./TrackContext";
import { trackUrl } from "../../lib/track";

import { useEffect, useRef, useState } from "react";
import { formatCurrency, formatMonthLabel, formatNumber } from "../../lib/format";
import type { MarketResponse, MarketStaleness } from "../../lib/types";
import { DbUnavailableBanner, LoadErrorBanner } from "./StatusBanners";
import { MarketTrendChart } from "./charts/MarketTrendChart";

function StalenessBadge({ staleness }: { staleness: MarketStaleness }) {
  if (staleness === "fresh") return <span className="staleness-pill staleness-fresh">Current</span>;
  if (staleness === "stale") return <span className="staleness-pill staleness-stale">Stale — re-run ingest</span>;
  return <span className="staleness-pill staleness-missing">No data</span>;
}

function MarketEmptyBanner() {
  return (
    <div className="banner banner-info" role="status">
      <strong>No market data ingested yet.</strong> The Zillow Research tables are empty. Run the one-shot ingest
      job to load them: <code>docker compose run --rm market-ingest</code>, then reload this page.
    </div>
  );
}

function MarketStaleBanner() {
  return (
    <div className="banner banner-warning" role="alert">
      <strong>Market data is stale.</strong> The newest ingested month is more than two monthly Zillow cycles old.
      Re-run <code>docker compose run --rm market-ingest</code> to refresh it.
    </div>
  );
}

export function MarketView({
  refreshSeq,
  onLoadSettled,
}: {
  /** Bumped by the global Refresh button to trigger a database re-fetch. */
  refreshSeq: number;
  /** Reports every settled load so the app-level refresh feedback is honest. */
  onLoadSettled: (ok: boolean) => void;
}) {
  const track = useTrack();
  const [data, setData] = useState<MarketResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onLoadSettledRef = useRef(onLoadSettled);
  onLoadSettledRef.current = onLoadSettled;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(trackUrl("/api/market", track), { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
          throw new Error(`request failed with status ${res.status}`);
        }
        const json = (await res.json()) as MarketResponse;
        if (controller.signal.aborted) return;
        setData(json);
        onLoadSettledRef.current(true);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "unknown error");
        onLoadSettledRef.current(false);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refreshSeq, track]);

  if (track === "plex") return <section className="dashboard-section"><h1>Plex market</h1><p>Plex market data is not available. Existing market series cover single-family houses only.</p>{error && <LoadErrorBanner message={error} />}</section>;

  const anyStale =
    data !== null &&
    data.meta.dataAvailable &&
    (data.neighborhoods.staleness === "stale" || data.cityMetrics.some((m) => m.staleness === "stale"));

  return (
    <>
      <header className="dashboard-header">
        <p className="eyebrow">MARKET {"\u00b7"} ZILLOW RESEARCH</p>
        <h1>Market</h1>
        <p className="lede">
          Citywide single-family market context from official free Zillow Research monthly data: inventory, new
          listings, list and sale prices, plus neighborhood typical values. This is market-wide data, separate from
          the tracked-research log in My Search.
        </p>
      </header>

      {error && <LoadErrorBanner message={error} />}
      {!error && data && !data.meta.dbAvailable && <DbUnavailableBanner />}
      {!error && data && data.meta.dbAvailable && !data.meta.dataAvailable && <MarketEmptyBanner />}
      {!error && anyStale && <MarketStaleBanner />}

      {loading && !data && <p className="loading-note">Loading market data{"\u2026"}</p>}

      {data && data.meta.dbAvailable && data.meta.dataAvailable && (
        <>
          <section className="kpi-grid">
            {data.cityMetrics.map((series) => (
              <article key={series.metric} className="kpi-card">
                <p className="kpi-label">{series.label}</p>
                <p className="kpi-value">
                  {series.latest === null
                    ? "No data"
                    : series.unit === "usd"
                      ? formatCurrency(series.latest.value)
                      : formatNumber(series.latest.value)}
                </p>
                <p className="kpi-hint">
                  {series.latest ? `As of ${formatMonthLabel(series.latest.month)} \u00b7 ` : null}
                  <StalenessBadge staleness={series.staleness} />
                </p>
              </article>
            ))}
          </section>

          {data.cityMetrics.map((series) => (
            <section key={series.metric} className="dashboard-section">
              <h2>{series.label}</h2>
              <p className="section-note">{series.description}</p>
              <MarketTrendChart label={series.label} unit={series.unit} points={series.points} />
            </section>
          ))}

          <section className="dashboard-section">
            <h2>Neighborhood typical values (SFR ZHVI)</h2>
            <p className="section-note">
              Zillow Home Value Index for Portland, OR neighborhoods: the smoothed, seasonally adjusted{" "}
              <strong>typical value</strong> of mid-tier single-family homes. This is not an average price, not a
              list price, not a sale price, and not filtered to your preferences.
              {data.neighborhoods.latestMonth && (
                <> Latest month: {formatMonthLabel(data.neighborhoods.latestMonth)}. </>
              )}
              <StalenessBadge staleness={data.neighborhoods.staleness} />
            </p>
            {data.neighborhoods.rows.length === 0 ? (
              <p className="chart-empty">No neighborhood ZHVI data ingested yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="property-table">
                  <thead>
                    <tr>
                      <th>Neighborhood</th>
                      <th>Typical value</th>
                      <th>As of</th>
                      <th>1-year change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.neighborhoods.rows.map((row) => (
                      <tr key={row.regionId}>
                        <td>{row.name}</td>
                        <td>{formatCurrency(row.latestValue)}</td>
                        <td>{formatMonthLabel(row.latestMonth)}</td>
                        <td>
                          {row.yearChangePct === null ? (
                            "Unknown"
                          ) : (
                            <span className={row.yearChangePct >= 0 ? "delta-up" : "delta-down"}>
                              {row.yearChangePct >= 0 ? "+" : ""}
                              {row.yearChangePct.toFixed(1)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {data && data.meta.dbAvailable && data.preferenceMatch && (
        <section className="dashboard-section">
          <h2>Observed preference match (tracked properties only)</h2>
          <p className="section-note">{data.preferenceMatch.note}</p>
          <p className="kpi-value">
            {data.preferenceMatch.matching} / {data.preferenceMatch.total}
          </p>
        </section>
      )}

      {data && (
        <>
          <div className="banner banner-muted">
            <strong>Source &amp; methodology.</strong> {data.meta.sourceNote}
            {data.meta.lastIngest && (
              <>
                {" "}
                Last ingest: {data.meta.lastIngest.status}
                {data.meta.lastIngest.finishedAt &&
                  ` on ${new Date(data.meta.lastIngest.finishedAt).toLocaleString()}`}
                .
              </>
            )}
          </div>
          <p className="generated-at">Generated {new Date(data.meta.generatedAt).toLocaleString()}</p>
        </>
      )}
    </>
  );
}
