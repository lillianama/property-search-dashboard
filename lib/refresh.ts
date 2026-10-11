// App-level Refresh coordination: one visible button re-fetches the
// currently mounted view's database-backed APIs (PostgreSQL reads only —
// this NEVER triggers external Zillow/RMLS ingestion) and reports honest
// loading/success/error feedback. The state machine is pure so the
// sequencing rules are unit-testable; components drive it from React state.

export type RefreshPhase = "idle" | "refreshing" | "success" | "error";

export interface RefreshState {
  /** Monotonic sequence number; bumping it is what triggers the mounted
   * views' load effects to re-fetch. */
  seq: number;
  phase: RefreshPhase;
}

export const INITIAL_REFRESH_STATE: RefreshState = { seq: 0, phase: "idle" };

/** Starts a refresh: bumps the sequence (triggering re-fetches) and enters
 * the "refreshing" phase. Starting during an in-flight refresh is allowed —
 * the newest sequence wins and the feedback keeps showing "refreshing". */
export function startRefresh(state: RefreshState): RefreshState {
  return { seq: state.seq + 1, phase: "refreshing" };
}

/**
 * Records the outcome of a load that settled while a refresh was pending.
 * Loads that settle when no refresh is in flight (initial page load, filter
 * changes) leave the state untouched, so routine fetches never flash the
 * refresh feedback.
 */
export function settleRefresh(state: RefreshState, ok: boolean): RefreshState {
  if (state.phase !== "refreshing") return state;
  return { ...state, phase: ok ? "success" : "error" };
}

/** Clears transient success/error feedback back to idle (e.g. after a
 * short timeout, or when the user navigates). A refresh in flight is not
 * cancelled. */
export function clearRefreshFeedback(state: RefreshState): RefreshState {
  if (state.phase === "refreshing") return state;
  return state.phase === "idle" ? state : { ...state, phase: "idle" };
}
