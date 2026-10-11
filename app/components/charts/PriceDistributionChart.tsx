"use client";

import { useEffect, useRef } from "react";
import type { Chart as ChartJs } from "chart.js";
import type { PriceBucket } from "../../../lib/aggregate";
import { ensureChartRegistered } from "./registerChartJs";

export function PriceDistributionChart({ data }: { data: PriceBucket[] }) {
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
        labels: data.map((d) => d.label),
        datasets: [
          {
            label: "Houses",
            data: data.map((d) => d.count),
            backgroundColor: "rgba(244, 114, 182, 0.5)",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              // Full, unambiguous half-open range with exact dollar bounds.
              title: (items) => {
                const bucket = data[items[0]?.dataIndex ?? -1];
                if (!bucket) return "";
                const fmt = (v: number) => `$${v.toLocaleString("en-US")}`;
                return bucket.rangeEnd === null
                  ? `${fmt(bucket.rangeStart)}+`
                  : `${fmt(bucket.rangeStart)} \u2013 under ${fmt(bucket.rangeEnd)}`;
              },
              label: (item) => {
                const count = data[item.dataIndex]?.count ?? 0;
                return `${count} house${count === 1 ? "" : "s"}`;
              },
            },
          },
        },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
          x: { grid: { display: false }, ticks: { maxRotation: 60, autoSkip: true } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  if (data.length === 0) {
    return <p className="chart-empty">No priced houses match the current filters.</p>;
  }

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} role="img" aria-label="Price distribution of tracked houses" />
    </div>
  );
}
