// Pure geometry/contrast logic for drawing each Status Distribution
// doughnut wedge's property count INSIDE its wedge. Kept dependency-free
// (no Chart.js import) so label visibility, placement, and contrast rules
// are unit-testable; the chart component adapts Chart.js arc elements into
// WedgeArc and draws the returned placements on the canvas.
//
// Honesty rules: zero-value wedges have no area and get no label, and a
// nonzero wedge whose arc is too small to legibly contain its count is
// skipped rather than drawn overlapping its neighbors — the legend and
// tooltip still carry the exact count, so nothing is ever misrepresented.

export interface WedgeArc {
  /** The wedge's data value (property count). */
  value: number;
  /** Arc angles in radians (Chart.js convention). */
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  /** Chart center in canvas coordinates. */
  centerX: number;
  centerY: number;
  /** Wedge fill as a hex color ("#rgb" or "#rrggbb"). */
  backgroundColor: string;
}

export interface WedgeLabel {
  text: string;
  x: number;
  y: number;
  /** Dark-on-light or light-on-dark, chosen per wedge for contrast. */
  color: string;
}

export const WEDGE_LABEL_FONT_PX = 12;

/** Breathing room required around the text, radially and along the chord. */
const LABEL_PADDING_PX = 3;

/** Near-black page background / near-white text from the dashboard’s palette, so
 * labels always sit on their wedge with strong contrast. */
export const WEDGE_LABEL_DARK_TEXT = "#0a0714";
export const WEDGE_LABEL_LIGHT_TEXT = "#f4f0fc";

function channelToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a hex color; NaN-safe fallback is 0 (treat
 * unparseable colors as dark, yielding light text). */
export function relativeLuminance(hex: string): number {
  const raw = hex.trim().replace(/^#/, "");
  const full = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) return 0;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/**
 * Picks near-black or near-white label text for a wedge fill. The 0.3
 * luminance threshold gives every color in the status palette (emerald,
 * amber, slate, violet, dark gray, pink fallback) at least ~4.5:1 contrast
 * against the chosen text color.
 */
export function wedgeLabelColor(backgroundColor: string): string {
  return relativeLuminance(backgroundColor) > 0.3 ? WEDGE_LABEL_DARK_TEXT : WEDGE_LABEL_LIGHT_TEXT;
}

/** Cheap sans-serif width estimate for short numeric labels; deliberately
 * a little generous so borderline wedges are skipped, never overflowed. */
export function estimateLabelWidth(text: string, fontPx: number = WEDGE_LABEL_FONT_PX): number {
  return text.length * fontPx * 0.62;
}

/**
 * True when the wedge can legibly contain its label: the ring must be
 * thick enough for the text height, and the chord at the label radius
 * (where the text is centered) must be wide enough for the text width.
 * Zero/negative values never fit — they have no wedge at all.
 */
export function wedgeLabelFits(arc: WedgeArc, text: string, fontPx: number = WEDGE_LABEL_FONT_PX): boolean {
  if (arc.value <= 0) return false;
  const angle = arc.endAngle - arc.startAngle;
  if (angle <= 0) return false;
  const thickness = arc.outerRadius - arc.innerRadius;
  if (thickness < fontPx + LABEL_PADDING_PX * 2) return false;
  const labelRadius = (arc.innerRadius + arc.outerRadius) / 2;
  const chord = 2 * labelRadius * Math.sin(Math.min(angle, Math.PI) / 2);
  return chord >= estimateLabelWidth(text, fontPx) + LABEL_PADDING_PX * 2;
}

/** Mid-angle, mid-ring label position for one wedge — visually centered in
 * the wedge's area, matching how the arc itself is drawn. */
export function wedgeLabelPosition(arc: WedgeArc): { x: number; y: number } {
  const midAngle = (arc.startAngle + arc.endAngle) / 2;
  const labelRadius = (arc.innerRadius + arc.outerRadius) / 2;
  return {
    x: arc.centerX + Math.cos(midAngle) * labelRadius,
    y: arc.centerY + Math.sin(midAngle) * labelRadius,
  };
}

/**
 * Plans the count labels for a full set of wedges: one label per wedge
 * whose count is nonzero AND legibly fits, positioned at the wedge's
 * visual center with a per-wedge contrast-checked text color.
 */
export function planWedgeLabels(arcs: WedgeArc[]): WedgeLabel[] {
  const labels: WedgeLabel[] = [];
  for (const arc of arcs) {
    const text = String(arc.value);
    if (!wedgeLabelFits(arc, text)) continue;
    const { x, y } = wedgeLabelPosition(arc);
    labels.push({ text, x, y, color: wedgeLabelColor(arc.backgroundColor) });
  }
  return labels;
}
