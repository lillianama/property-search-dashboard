import { describe, expect, it } from "vitest";
import {
  AUTOSCROLL_EDGE_PX,
  AUTOSCROLL_MAX_SPEED_PX,
  autoscrollSpeed,
  createAutoscroller,
} from "./drag-autoscroll";

const VIEWPORT = 900;

describe("autoscrollSpeed", () => {
  it("is zero in the middle of the viewport", () => {
    expect(autoscrollSpeed(VIEWPORT / 2, VIEWPORT)).toBe(0);
    expect(autoscrollSpeed(AUTOSCROLL_EDGE_PX, VIEWPORT)).toBe(0);
    expect(autoscrollSpeed(VIEWPORT - AUTOSCROLL_EDGE_PX, VIEWPORT)).toBe(0);
  });

  it("scrolls up (negative) near the top and down (positive) near the bottom", () => {
    expect(autoscrollSpeed(10, VIEWPORT)).toBeLessThan(0);
    expect(autoscrollSpeed(VIEWPORT - 10, VIEWPORT)).toBeGreaterThan(0);
  });

  it("ramps up toward the edge and caps at the max speed", () => {
    const midZone = autoscrollSpeed(AUTOSCROLL_EDGE_PX / 2, VIEWPORT);
    const atEdge = autoscrollSpeed(0, VIEWPORT);
    expect(Math.abs(atEdge)).toBeGreaterThan(Math.abs(midZone));
    expect(atEdge).toBe(-AUTOSCROLL_MAX_SPEED_PX);
    expect(autoscrollSpeed(VIEWPORT, VIEWPORT)).toBe(AUTOSCROLL_MAX_SPEED_PX);
  });

  it("clamps coordinates outside the viewport (native drags report them)", () => {
    expect(autoscrollSpeed(-50, VIEWPORT)).toBe(-AUTOSCROLL_MAX_SPEED_PX);
    expect(autoscrollSpeed(VIEWPORT + 50, VIEWPORT)).toBe(AUTOSCROLL_MAX_SPEED_PX);
  });

  it("shrinks the zones instead of overlapping in short viewports", () => {
    const height = AUTOSCROLL_EDGE_PX; // zones would overlap at full size
    expect(autoscrollSpeed(height / 2, height)).toBe(0);
    expect(autoscrollSpeed(1, height)).toBeLessThan(0);
    expect(autoscrollSpeed(height - 1, height)).toBeGreaterThan(0);
  });

  it("returns zero for degenerate input", () => {
    expect(autoscrollSpeed(Number.NaN, VIEWPORT)).toBe(0);
    expect(autoscrollSpeed(100, 0)).toBe(0);
    expect(autoscrollSpeed(100, -5)).toBe(0);
  });
});

/** Manually-pumped fake rAF environment. */
function fakeEnv() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  const scrolls: number[] = [];
  return {
    scrolls,
    pending,
    env: {
      requestFrame: (cb: () => void) => {
        const handle = nextHandle++;
        pending.set(handle, cb);
        return handle;
      },
      cancelFrame: (handle: number) => void pending.delete(handle),
      scrollBy: (dy: number) => void scrolls.push(dy),
    },
    pump() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

describe("createAutoscroller", () => {
  it("only runs a frame loop while inside an edge zone", () => {
    const { env, pump, scrolls, pending } = fakeEnv();
    const scroller = createAutoscroller(env);

    scroller.update(VIEWPORT / 2, VIEWPORT);
    expect(scroller.isActive()).toBe(false);
    expect(pending.size).toBe(0);

    scroller.update(5, VIEWPORT);
    expect(scroller.isActive()).toBe(true);
    pump();
    pump();
    expect(scrolls.length).toBe(2);
    expect(scrolls[0]).toBeLessThan(0);

    // Leaving the zone stops the loop without an explicit stop() call.
    scroller.update(VIEWPORT / 2, VIEWPORT);
    expect(scroller.isActive()).toBe(false);
    pump();
    expect(scrolls.length).toBe(2);
  });

  it("does not double-schedule frames on repeated updates", () => {
    const { env, pending } = fakeEnv();
    const scroller = createAutoscroller(env);
    scroller.update(5, VIEWPORT);
    scroller.update(6, VIEWPORT);
    scroller.update(7, VIEWPORT);
    expect(pending.size).toBe(1);
    scroller.stop();
  });

  it("stop() cancels the scheduled frame and is idempotent", () => {
    const { env, pump, scrolls, pending } = fakeEnv();
    const scroller = createAutoscroller(env);
    scroller.update(VIEWPORT - 5, VIEWPORT);
    expect(pending.size).toBe(1);

    scroller.stop();
    scroller.stop();
    expect(scroller.isActive()).toBe(false);
    expect(pending.size).toBe(0);
    pump();
    expect(scrolls.length).toBe(0);
  });

  it("keeps scrolling with updated speed as the pointer moves within the zone", () => {
    const { env, pump, scrolls } = fakeEnv();
    const scroller = createAutoscroller(env);
    scroller.update(40, VIEWPORT);
    pump();
    scroller.update(2, VIEWPORT);
    pump();
    expect(scrolls.length).toBe(2);
    expect(Math.abs(scrolls[1])).toBeGreaterThan(Math.abs(scrolls[0]));
    scroller.stop();
  });
});
