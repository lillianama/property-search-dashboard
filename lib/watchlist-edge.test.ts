import { isValidElement, type ReactNode, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../app/components/Dashboard";
import { FunnelBoard } from "../app/components/FunnelBoard";
import { EMPTY_FILTER_FORM } from "./url-state";
import { applyLocalFunnelState, EMPTY_LOCAL_FUNNEL_STATE, groupByBucket, type LocalFunnelState } from "./funnel";
import type { HouseRecord } from "./types";

const harness = vi.hoisted(() => ({ track: "house", stateIndex: 0, local: {} as any, data: {} as any }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => ({ current: value }),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = harness.stateIndex++;
    const value = index === 1 ? harness.data : index === 4 ? harness.local : initial;
    return [value, (update: any) => {
      if (index === 4) harness.local = typeof update === "function" ? update(harness.local) : update;
    }];
  },
}));
vi.mock("../app/components/TrackContext", () => ({ useTrack: () => harness.track }));
vi.mock("../app/components/PropertyMap", () => ({ PropertyMap: () => null }));
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function property(id: string, rankKey: string, funnelBucket = "watchlist"): HouseRecord {
  return { id, rankKey, funnelBucket, address: id } as HouseRecord;
}
afterEach(() => vi.unstubAllGlobals());

describe.each(["house", "plex"])("%s watchlist edge action through Dashboard", track => {
  it("moves to top using full-track neighbors and existing persistence", async () => {
    const properties = [property("a", "5"), property("b", "i"), property("c", "q"), property("tour", "8", "to-tour")];
    harness.track = track;
    harness.stateIndex = 0;
    harness.local = { ...EMPTY_LOCAL_FUNNEL_STATE, placements: {
      c: { bucket: "watchlist", afterId: null, beforeId: "a", seq: 0 },
    } } satisfies LocalFunnelState;
    // Only b is visible; a and c must still count when choosing neighbors.
    harness.data = { properties: [properties[1]], meta: { dbAvailable: true } };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ properties }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const tree = Dashboard({ view: "list", filters: EMPTY_FILTER_FORM, editingId: null, refreshSeq: 0,
      onViewChange: vi.fn(), onFiltersChange: vi.fn(), onOpenEditor: vi.fn(), onCloseEditor: vi.fn(), onLoadSettled: vi.fn() });
    const board = elements(tree).find(el => el.type === FunnelBoard)!;
    await board.props.onWatchlistTop(properties[1]);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/dashboard?lifecycle=search&track=${track}`);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/funnel/move?track=${track}`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ propertyId: "b", action: "watchlist",
      beforeId: "c" });
    const grouped = groupByBucket(applyLocalFunnelState(properties, harness.local), harness.local.placements);
    expect(grouped.watchlist.map(row => row.id)).toEqual(["b", "c", "a"]);
    expect(grouped["to-tour"]).toEqual([properties[3]]);
  });

  it("does not persist a move for the first item or a single-item watchlist", async () => {
    for (const properties of [[property("a", "5"), property("b", "i")], [property("a", "5")]]) {
      harness.track = track;
      harness.stateIndex = 0;
      harness.local = EMPTY_LOCAL_FUNNEL_STATE;
      harness.data = { properties, meta: { dbAvailable: true } };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties }) });
      vi.stubGlobal("fetch", fetchMock);
      const tree = Dashboard({ view: "list", filters: EMPTY_FILTER_FORM, editingId: null, refreshSeq: 0,
        onViewChange: vi.fn(), onFiltersChange: vi.fn(), onOpenEditor: vi.fn(), onCloseEditor: vi.fn(), onLoadSettled: vi.fn() });
      await elements(tree).find(el => el.type === FunnelBoard)!.props.onWatchlistTop(properties[0]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.local).toBe(EMPTY_LOCAL_FUNNEL_STATE);
    }
  });
});
