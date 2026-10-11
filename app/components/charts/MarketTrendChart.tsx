"use client";

import { useEffect, useRef } from "react";
import type { Chart as ChartJs } from "chart.js";
import { formatMonthLabel } from "../../../lib/format";
import type { MarketSeriesPoint } from "../../../lib/types";
import { ensureChartRegistered } from "./registerChartJs";

interface MarketTrendChartProps {
  label: string;
  unit: "count" | "usd";
  points: MarketSeriesPoint[];
}

export function MarketTrendChart({ label, unit, points }: MarketTrendChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJs | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const Chart = ensureChartRegistered();

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      type: "line",
      data: {
        labels: points.map((p) => formatMonthLabel(p.month)),
        datasets: [
          {
            label,
            data: points.map((p) => p.value),
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167, 139, 250, 0.18)",
            fill: true,
            pointRadius: 0,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: {
            beginAtZero: unit === "count",
            title: { display: true, text: unit === "usd" ? "USD" : "Listings" },
            grid: { color: "rgba(83,49,115,0.12)" },
          },
          x: {
            grid: { color: "rgba(83,49,115,0.08)" },
            ticks: { maxTicksLimit: 12 },
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
  }, [label, unit, points]);

  if (points.length === 0) {
    return <p className="chart-empty">No data ingested for this metric yet.</p>;
  }

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} role="img" aria-label={`${label} monthly trend`} />
    </div>
  );
}
