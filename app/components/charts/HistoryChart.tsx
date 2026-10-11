"use client";

import { useEffect, useRef } from "react";
import type { Chart as ChartJs } from "chart.js";
import { formatMonthLabel } from "../../../lib/format";
import { ensureChartRegistered } from "./registerChartJs";

export interface HistoryChartPoint {
  month: string;
  eventCount: number;
  medianPrice: number | null;
}

export function HistoryChart({ data }: { data: HistoryChartPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJs | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const Chart = ensureChartRegistered();

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      data: {
        labels: data.map((d) => formatMonthLabel(d.month)),
        datasets: [
          {
            type: "bar",
            label: "Tracked listing events",
            data: data.map((d) => d.eventCount),
            backgroundColor: "rgba(167, 139, 250, 0.55)",
            borderRadius: 4,
            yAxisID: "count",
          },
          {
            type: "line",
            label: "Median price",
            data: data.map((d) => d.medianPrice),
            borderColor: "#34d399",
            backgroundColor: "#34d399",
            spanGaps: true,
            tension: 0.25,
            yAxisID: "price",
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
            title: { display: true, text: "Events" },
            grid: { color: "rgba(83,49,115,0.12)" },
          },
          price: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            title: { display: true, text: "Median price ($)" },
            grid: { display: false },
          },
          x: {
            grid: { color: "rgba(83,49,115,0.08)" },
          },
        },
        plugins: {
          legend: { labels: { color: "#51405f" } },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  if (data.length === 0) {
    return <p className="chart-empty">No dated listing events match the current filters.</p>;
  }

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} role="img" aria-label="Monthly tracked listing events and median price" />
    </div>
  );
}
