import { describe, expect, it } from "vitest";
import {
  clearRefreshFeedback,
  INITIAL_REFRESH_STATE,
  settleRefresh,
  startRefresh,
} from "./refresh";

describe("refresh coordination state machine", () => {
  it("starts idle with sequence zero", () => {
    expect(INITIAL_REFRESH_STATE).toEqual({ seq: 0, phase: "idle" });
  });

  it("startRefresh bumps the sequence (what triggers re-fetches) and enters refreshing", () => {
    const s1 = startRefresh(INITIAL_REFRESH_STATE);
    expect(s1).toEqual({ seq: 1, phase: "refreshing" });
    const s2 = startRefresh(s1);
    expect(s2.seq).toBe(2);
    expect(s2.phase).toBe("refreshing");
  });

  it("settleRefresh records success or failure only while refreshing", () => {
    const refreshing = startRefresh(INITIAL_REFRESH_STATE);
    expect(settleRefresh(refreshing, true).phase).toBe("success");
    expect(settleRefresh(refreshing, false).phase).toBe("error");
  });

  it("routine loads (no refresh in flight) never flash refresh feedback", () => {
    expect(settleRefresh(INITIAL_REFRESH_STATE, true)).toBe(INITIAL_REFRESH_STATE);
    const success = settleRefresh(startRefresh(INITIAL_REFRESH_STATE), true);
    // A later routine load settling does not re-enter feedback phases.
    expect(settleRefresh(success, false)).toBe(success);
  });

  it("clearRefreshFeedback returns to idle but never cancels an in-flight refresh", () => {
    const success = settleRefresh(startRefresh(INITIAL_REFRESH_STATE), true);
    expect(clearRefreshFeedback(success).phase).toBe("idle");
    expect(clearRefreshFeedback(success).seq).toBe(success.seq);

    const refreshing = startRefresh(INITIAL_REFRESH_STATE);
    expect(clearRefreshFeedback(refreshing)).toBe(refreshing);

    expect(clearRefreshFeedback(INITIAL_REFRESH_STATE)).toBe(INITIAL_REFRESH_STATE);
  });
});
