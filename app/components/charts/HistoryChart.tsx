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
          legend: { display: false },
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
      {view.total === 0 && <p className="chart-empty">
        {allHistory ? "No dated historical records match the current filters." : "No historical records in these 12 months. Choose All history to explore earlier records for these homes."}
      </p>}
      <div className="chart-canvas-wrap">
        <canvas ref={canvasRef} role="img" aria-label={`Historical listing and sale record counts, ${view.range}. ${view.total} records.`} />
      </div>
      <details className="history-values">
        <summary>View record counts as text</summary>
        <ul>{view.buckets.map((bucket) => <li key={bucket.label}>{bucket.label}: {bucket.count}</li>)}</ul>
      </details>
    </>
  );
}
