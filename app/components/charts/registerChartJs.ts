import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";

let registered = false;

/** Registers the handful of Chart.js building blocks this app uses and applies
 * the dashboard’s light-lilac theme defaults. Safe to call repeatedly; only registers
 * once per client bundle. */
export function ensureChartRegistered(): typeof Chart {
  if (!registered) {
    Chart.register(
      BarController,
      LineController,
      DoughnutController,
      CategoryScale,
      LinearScale,
      BarElement,
      LineElement,
      PointElement,
      ArcElement,
      Tooltip,
      Legend,
    );

    Chart.defaults.color = "#665774";
    Chart.defaults.borderColor = "rgba(167, 139, 250, 0.12)";
    Chart.defaults.font.family = "Inter, ui-sans-serif, system-ui, sans-serif";
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(20, 16, 32, 0.95)";
    Chart.defaults.plugins.tooltip.borderColor = "rgba(167, 139, 250, 0.35)";
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = "#f4f0fc";
    Chart.defaults.plugins.tooltip.bodyColor = "#e8ddf4";

    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      Chart.defaults.animation = false;
    }

    registered = true;
  }
  return Chart;
}
