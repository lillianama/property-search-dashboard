"use client";

import { useEffect, useRef } from "react";
import type { Chart as ChartJs, Plugin } from "chart.js";
import type { StatusCount } from "../../../lib/aggregate";
import { planWedgeLabels, WEDGE_LABEL_FONT_PX, type WedgeArc } from "../../../lib/chart-wedge-labels";
import { ensureChartRegistered } from "./registerChartJs";

const STATUS_COLORS: Record<string, string> = {
  Active: "#34d399",
  Pending: "#fbbf24",
  Inactive: "#94a3b8",
  Unverified: "#f97316",
  Sold: "#a78bfa",
  Unknown: "#4b5563",
};

function colorFor(status: string): string {
  return STATUS_COLORS[status] ?? "#f472b6";
}

/** The subset of Chart.js arc-element geometry the labels need. */
interface ArcGeometry {
  x: number;
  y: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
}

/**
 * Chart-local plugin (never registered globally) that draws each wedge's
 * property count inside the wedge. All visibility/placement/contrast rules
 * live in lib/chart-wedge-labels.ts (pure, unit-tested): zero-value wedges
 * and wedges too small to legibly hold their count are skipped — the
 * legend and tooltip still carry the exact numbers. Drawing from the live
 * arc geometry each frame keeps labels correct through animation, resize,
 * and legend toggling (a hidden wedge collapses to zero angle and its
 * label disappears with it).
 */
const wedgeCountLabels: Plugin<"doughnut"> = {
  id: "wedgeCountLabels",
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    const values = chart.data.datasets[0]?.data ?? [];
    const colors = chart.data.datasets[0]?.backgroundColor as string[] | undefined;

    const arcs: WedgeArc[] = meta.data.map((element, index) => {
      const arc = element as unknown as ArcGeometry;
      return {
        value: typeof values[index] === "number" ? (values[index] as number) : 0,
        startAngle: arc.startAngle,
        endAngle: arc.endAngle,
        innerRadius: arc.innerRadius,
        outerRadius: arc.outerRadius,
        centerX: arc.x,
        centerY: arc.y,
        backgroundColor: colors?.[index] ?? "#4b5563",
      };
    });

    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 ${WEDGE_LABEL_FONT_PX}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const label of planWedgeLabels(arcs)) {
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, label.x, label.y);
    }
    ctx.restore();
  },
};

export function StatusDistributionChart({ data }: { data: StatusCount[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartJs | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const Chart = ensureChartRegistered();

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: data.map((d) => d.status),
        datasets: [
          {
            data: data.map((d) => d.count),
            backgroundColor: data.map((d) => colorFor(d.status)),
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#51405f" } },
        },
      },
      plugins: [wedgeCountLabels],
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data]);

  if (data.length === 0) {
    return <p className="chart-empty">No status data matches the current filters.</p>;
  }

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} role="img" aria-label="Status distribution of tracked houses" />
    </div>
  );
}
