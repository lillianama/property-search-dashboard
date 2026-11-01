"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Chart as ChartJs } from "chart.js";
import { buildHistoryView } from "../../../lib/history-chart";
import { ensureChartRegistered } from "./registerChartJs";

export interface HistoryChartPoint {
  month: string;
  eventCount: number;
  medianPrice: number | null;
}

export function HistoryChart({ data }: { data: HistoryChartPoint[] }) {
  const [allHistory, setAllHistory] = useState(false);
  const view = useMemo(() => buildHistoryView(data, allHistory), [data, allHistory]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJs | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const Chart = ensureChartRegistered();

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      type: "bar",
      data: {
        labels: view.buckets.map((d) => d.label),
        datasets: [
          ...(!view.annual ? [{
            type: "line" as const,
            label: "Median recorded sold price",
            data: view.buckets.map(d => d.medianPrice),
            borderColor: "#8b5cf6",
            backgroundColor: "#8b5cf6",
            spanGaps: false,
            yAxisID: "price",
          }] : []),
          {
            type: "bar",
            label: "Historical records",
            data: view.buckets.map((d) => d.count),
            backgroundColor: "rgba(167, 139, 250, 0.55)",
            borderRadius: 4,
            yAxisID: "count",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          ...(!view.annual ? { price: {
            type: "linear" as const, position: "right" as const,
            title: { display: true, text: "Median sold price ($)" },
            grid: { drawOnChartArea: false },
            ticks: { callback: value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact" }).format(Number(value)) },
          } } : {}),
          count: {
            type: "linear",
            position: "left",
            beginAtZero: true,
            title: { display: true, text: "Records" },
            ticks: { precision: 0 },
            grid: { color: "rgba(83,49,115,0.12)" },
          },
          x: {
            title: { display: true, text: view.annual ? "Year (current year through this month)" : "Month" },
            ticks: { maxRotation: 0, maxTicksLimit: view.annual ? 10 : 6 },
            grid: { color: "rgba(83,49,115,0.08)" },
          },
        },
        plugins: {
          legend: { display: !view.annual },
          tooltip: { callbacks: { label: context => context.dataset.yAxisID === "price"
            ? `Median sold price: ${(context.parsed.y === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(context.parsed.y))}`
            : `Historical records: ${context.parsed.y}` } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [view]);

  return (
    <>
      <div className="history-controls" role="group" aria-label="Listing history period">
        <button type="button" aria-pressed={!allHistory} onClick={() => setAllHistory(false)}>Last 12 months</button>
        <button type="button" aria-pressed={allHistory} onClick={() => setAllHistory(true)}>All history</button>
      </div>
      <p className="section-note" role="status">
        {view.range} · {view.total} historical {view.total === 1 ? "record" : "records"} · {view.annual ? "Yearly" : "Monthly"} counts
      </p>
      <p className="section-note">{view.annual ? "Yearly record counts only; switch to Last 12 months for monthly median sold prices." : "Monthly median recorded sale price. Missing sale prices leave gaps."}</p>
      {view.total === 0 && <p className="chart-empty">
        {allHistory ? "No dated historical records match the current filters." : "No historical records in these 12 months. Choose All history to explore earlier records for these homes."}
      </p>}
      <div className="chart-canvas-wrap">
        <canvas ref={canvasRef} role="img" aria-label={`Historical listing and sale record counts, ${view.range}. ${view.total} records.${view.annual ? "" : " Monthly median recorded sold prices; missing prices are gaps."}`} />
      </div>
      <details className="history-values">
        <summary>View history as text</summary>
        <ul>{view.buckets.map((bucket) => <li key={bucket.label}>{bucket.label}: {bucket.count}{!view.annual && ` · Median sold price: ${bucket.medianPrice === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(bucket.medianPrice)}`}</li>)}</ul>
      </details>
    </>
  );
}
