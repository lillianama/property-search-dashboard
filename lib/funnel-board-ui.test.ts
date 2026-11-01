import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FunnelBoard } from "../app/components/FunnelBoard";
import { DEFAULT_PITI_ASSUMPTIONS } from "./piti";
import type { FunnelBucket, HouseRecord } from "./types";

// Inspect the same element handlers rendered below without adding a DOM dependency.
// State updates/effects and browser drag gestures are outside this static harness.
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: () => {},
}));
vi.mock("../app/components/PropertyPhoto", () => ({ PropertyPhoto: () => null }));
const trackState = vi.hoisted(() => ({ track: "house" }));
vi.mock("../app/components/TrackContext", () => ({ useTrack: () => trackState.track }));

function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function house(bucket: FunnelBucket, id: string = bucket): HouseRecord {
  return {
    id, address: `${id} Example St`, funnelBucket: bucket, rankKey: "h",
    displayStatus: "Active", latestPrice: null, bedroomSizeFlag: "unknown",
    judgments: { bedroomSizeOk: "unknown", rentalIncome: "yes", drumSpace: "no" },
  } as HouseRecord;
}

describe("rendered funnel bucket actions", () => {
  it.each([
    ["watchlist", ["To tour", "Top contender", "To top", "To bottom", "Edit", "Reject"]],
    ["to-tour", ["Top contender", "To Watchlist", "Edit", "Reject"]],
    ["top-contenders", ["To Watchlist", "Edit", "Reject"]],
  ] as const)("renders the full action set for %s", (bucket, labels) => {
    const props = { properties: [house(bucket)], placements: {}, onMove: vi.fn(),
      onWatchlistTop: vi.fn(), onWatchlistBottom: vi.fn(), onEditNotes: vi.fn(), pitiAssumptions: DEFAULT_PITI_ASSUMPTIONS };
    const html = renderToStaticMarkup(createElement(FunnelBoard, props));
    const actionHtml = html.slice(html.indexOf('class="funnel-row-actions"'));
    const buttons = [...actionHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map(match => match[1].replace(/<svg\b[\s\S]*?<\/svg>/g, "").trim());
    expect(buttons).toEqual(labels);
    expect(html).toContain(`Edit notes and judgments for ${props.properties[0].address}`);
    expect(html).toContain("Reorder ");
  });

  it.each([
    ["watchlist", "to-tour", "To tour"],
    ["watchlist", "top-contenders", "Top contenders"],
    ["to-tour", "top-contenders", "Top contenders"],
    ["to-tour", "watchlist", "Watchlist"],
    ["top-contenders", "watchlist", "Watchlist"],
  ] as const)("routes %s → %s through the existing ranked move callback", (origin, target, label) => {
    const source = house(origin, "source");
    const neighbor = house(target, "neighbor");
    const onMove = vi.fn();
    const onEditNotes = vi.fn();
    const onWatchlistBottom = vi.fn();
    const tree = FunnelBoard({ properties: [source, neighbor], placements: {}, onMove,
      onEditNotes, onWatchlistTop: vi.fn(), onWatchlistBottom, pitiAssumptions: DEFAULT_PITI_ASSUMPTIONS });
    const row = elements(tree).find(el => el.props.house === source)!;
    const renderedRow = (row.type as (props: any) => ReactNode)(row.props);
    const button = elements(renderedRow).find(el => el.type === "button" &&
      el.props["aria-label"] === `Move ${source.address} to ${label}`)!;
    expect(button).toBeDefined();
    button.props.onClick();
    expect(onMove).toHaveBeenCalledExactlyOnceWith(source, target, {
      placement: { afterId: null, beforeId: neighbor.id },
    });
    elements(renderedRow).find(el => el.props["aria-label"] === `Edit notes and judgments for ${source.address}`)!.props.onClick();
    expect(onEditNotes).toHaveBeenCalledWith(source);
    if (origin === "watchlist") {
      elements(renderedRow).find(el => el.props["aria-label"] === `Move ${source.address} to bottom of Watchlist`)!.props.onClick();
      expect(onWatchlistBottom).toHaveBeenCalledWith(source);
    }
    expect(source).toMatchObject({ funnelBucket: origin, rankKey: "h" });
  });
});

 describe.each(["house", "plex"])("%s watchlist top action wiring", track => {
  it("places Top directly above Bottom and calls only the top callback", () => {
    trackState.track = track;
    const source = house("watchlist", "source");
    const onWatchlistTop = vi.fn();
    const onWatchlistBottom = vi.fn();
    const onMove = vi.fn();
    const tree = FunnelBoard({ properties: [source], placements: {}, onMove,
      onWatchlistTop, onWatchlistBottom, onEditNotes: vi.fn(), bottomMoveBusy: true,
      pitiAssumptions: DEFAULT_PITI_ASSUMPTIONS });
    const row = elements(tree).find(el => el.props.house === source)!;
    const rendered = (row.type as (props: any) => ReactNode)(row.props);
    const buttons = elements(rendered).filter(el => el.type === "button");
    const topIndex = buttons.findIndex(el => el.props["aria-label"] === `Move ${source.address} to top of Watchlist`);
    expect(topIndex).toBeGreaterThan(-1);
    expect(buttons[topIndex + 1].props["aria-label"]).toBe(`Move ${source.address} to bottom of Watchlist`);
    expect(buttons[topIndex].props.disabled).toBe(true);
    expect(buttons[topIndex + 1].props.disabled).toBe(true);
    buttons[topIndex].props.onClick();
    expect(onWatchlistTop).toHaveBeenCalledExactlyOnceWith(source);
    expect(onWatchlistBottom).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });
});
