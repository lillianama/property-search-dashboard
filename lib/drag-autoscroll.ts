// Viewport-edge auto-scroll for pointer/native HTML5 drags: when a drag
// hovers near the top or bottom of the viewport, the page scrolls smoothly
// so long lists can be traversed without dropping the row. The speed math
// is pure (unit-testable); the runner below drives it with a single bounded
// requestAnimationFrame loop that is fully cleaned up on drop/dragend/
// cancel/unmount. Keyboard dragging never goes through this module — it
// relies on focus scrolling — so accessibility behavior is untouched.

/** Distance from the viewport edge (px) inside which auto-scroll engages. */
export const AUTOSCROLL_EDGE_PX = 72;

/** Speed cap (px per frame at 60fps) reached right at the viewport edge. */
export const AUTOSCROLL_MAX_SPEED_PX = 24;

/**
 * Signed scroll speed for a pointer at `clientY` in a viewport of
 * `viewportHeight`: negative scrolls up, positive scrolls down, 0 outside
 * both edge zones. Speed ramps linearly from 0 at the zone's inner boundary
 * to AUTOSCROLL_MAX_SPEED_PX at the edge, and is clamped to the max even
 * for coordinates outside the viewport (native HTML5 drags can report
 * them). Returns 0 for degenerate viewports.
 */
export function autoscrollSpeed(
  clientY: number,
  viewportHeight: number,
  edge: number = AUTOSCROLL_EDGE_PX,
  maxSpeed: number = AUTOSCROLL_MAX_SPEED_PX,
): number {
  if (!Number.isFinite(clientY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  // A short viewport could make the zones overlap; shrink them so they meet
  // in the middle at most.
  const zone = Math.min(edge, viewportHeight / 2);
  if (zone <= 0) return 0;

  if (clientY < zone) {
    const intensity = Math.min(1, (zone - clientY) / zone);
    return -Math.ceil(intensity * maxSpeed);
  }
  const fromBottom = viewportHeight - clientY;
  if (fromBottom < zone) {
    const intensity = Math.min(1, (zone - fromBottom) / zone);
    return Math.ceil(intensity * maxSpeed);
  }
  return 0;
}

interface AutoscrollEnv {
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
  scrollBy(dy: number): void;
}

/**
 * A bounded rAF-driven auto-scroller. `update(clientY, viewportHeight)` is
 * called from dragover/pointermove events; the loop only runs while the
 * pointer is inside an edge zone (speed != 0) and stops itself otherwise,
 * so there is never a free-running animation loop. `stop()` cancels
 * everything and is safe to call repeatedly (drop, dragend, cancel,
 * unmount).
 */
export function createAutoscroller(env?: Partial<AutoscrollEnv>) {
  const requestFrame =
    env?.requestFrame ?? ((cb: () => void) => window.requestAnimationFrame(() => cb()));
  const cancelFrame = env?.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const scrollBy = env?.scrollBy ?? ((dy: number) => window.scrollBy(0, dy));

  let speed = 0;
  let frameHandle: number | null = null;

  const tick = () => {
    frameHandle = null;
    if (speed === 0) return;
    scrollBy(speed);
    frameHandle = requestFrame(tick);
  };

  return {
    /** Recompute the speed from the latest pointer position. */
    update(clientY: number, viewportHeight: number): void {
      speed = autoscrollSpeed(clientY, viewportHeight);
      if (speed !== 0 && frameHandle === null) {
        frameHandle = requestFrame(tick);
      }
      if (speed === 0 && frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
    /** Halt scrolling and cancel any scheduled frame. Idempotent. */
    stop(): void {
      speed = 0;
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
    /** True while a frame is scheduled (i.e. actively scrolling). */
    isActive(): boolean {
      return frameHandle !== null;
    },
  };
}

export type Autoscroller = ReturnType<typeof createAutoscroller>;
