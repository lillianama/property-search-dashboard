import { describe, expect, it } from "vitest";
import {
  buildImageUrl,
  buildMetadataUrl,
  buildStreetViewFallbackNote,
  buildStreetViewLabel,
  chooseExteriorHeading,
  choosePhotoDisplay,
  computeHeading,
  formatImageryDate,
  isWithinPortlandBounds,
  parseStreetViewMetadata,
  STREET_VIEW_FOV,
  STREET_VIEW_IMAGE_HEIGHT,
  STREET_VIEW_IMAGE_WIDTH,
} from "./streetview";

const PORTLAND = { latitude: 45.515, longitude: -122.65 };

describe("isWithinPortlandBounds", () => {
  it("accepts coordinates inside Portland", () => {
    expect(isWithinPortlandBounds(45.515, -122.65)).toBe(true);
    expect(isWithinPortlandBounds(45.50, -122.64)).toBe(true);
  });

  it("rejects coordinates outside Portland", () => {
    expect(isWithinPortlandBounds(47.606, -122.332)).toBe(false); // Seattle
    expect(isWithinPortlandBounds(45.515, -121.5)).toBe(false); // east of the metro
    expect(isWithinPortlandBounds(0, 0)).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    expect(isWithinPortlandBounds(Number.NaN, -122.65)).toBe(false);
    expect(isWithinPortlandBounds(45.5, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("computeHeading", () => {
  it("points north when the target is due north", () => {
    const heading = computeHeading(PORTLAND, { ...PORTLAND, latitude: PORTLAND.latitude + 0.001 });
    expect(heading).toBeCloseTo(0, 1);
  });

  it("points east when the target is due east", () => {
    const heading = computeHeading(PORTLAND, { ...PORTLAND, longitude: PORTLAND.longitude + 0.001 });
    expect(heading).toBeCloseTo(90, 0);
  });

  it("points south when the target is due south", () => {
    const heading = computeHeading(PORTLAND, { ...PORTLAND, latitude: PORTLAND.latitude - 0.001 });
    expect(heading).toBeCloseTo(180, 1);
  });

  it("points west when the target is due west", () => {
    const heading = computeHeading(PORTLAND, { ...PORTLAND, longitude: PORTLAND.longitude - 0.001 });
    expect(heading).toBeCloseTo(270, 0);
  });

  it("always returns a value in [0, 360)", () => {
    for (const dLat of [-0.002, 0, 0.002]) {
      for (const dLng of [-0.002, 0.002]) {
        const heading = computeHeading(PORTLAND, {
          latitude: PORTLAND.latitude + dLat,
          longitude: PORTLAND.longitude + dLng,
        });
        expect(heading).toBeGreaterThanOrEqual(0);
        expect(heading).toBeLessThan(360);
      }
    }
  });
});

describe("chooseExteriorHeading", () => {
  it("aims from the panorama toward the property", () => {
    // Camera on the street just south of the house should face north.
    const pano = { latitude: PORTLAND.latitude - 0.0002, longitude: PORTLAND.longitude };
    expect(chooseExteriorHeading(PORTLAND, pano)).toBeCloseTo(0, 1);

    const panoWest = { latitude: PORTLAND.latitude, longitude: PORTLAND.longitude - 0.0002 };
    expect(chooseExteriorHeading(PORTLAND, panoWest)).toBeCloseTo(90, 0);
  });

  it("returns null when the panorama location is unknown", () => {
    expect(chooseExteriorHeading(PORTLAND, null)).toBeNull();
  });

  it("returns null when the panorama sits on the property (bearing is meaningless)", () => {
    expect(chooseExteriorHeading(PORTLAND, { ...PORTLAND })).toBeNull();
    expect(
      chooseExteriorHeading(PORTLAND, {
        latitude: PORTLAND.latitude + 1e-6,
        longitude: PORTLAND.longitude - 1e-6,
      }),
    ).toBeNull();
  });
});

describe("buildMetadataUrl", () => {
  it("targets the free metadata endpoint with outdoor-only panoramas", () => {
    const url = new URL(buildMetadataUrl("test-key", PORTLAND));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/streetview/metadata");
    expect(url.searchParams.get("location")).toBe("45.515,-122.65");
    expect(url.searchParams.get("source")).toBe("outdoor");
    expect(url.searchParams.get("key")).toBe("test-key");
  });
});

describe("buildImageUrl", () => {
  it("requests the static image by panorama with return_error_code=true", () => {
    const url = new URL(buildImageUrl("test-key", { panoId: "pano-123", heading: 42.5 }));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/streetview");
    expect(url.searchParams.get("size")).toBe(`${STREET_VIEW_IMAGE_WIDTH}x${STREET_VIEW_IMAGE_HEIGHT}`);
    expect(url.searchParams.get("pano")).toBe("pano-123");
    expect(url.searchParams.get("heading")).toBe("42.5");
    expect(url.searchParams.get("fov")).toBe(String(STREET_VIEW_FOV));
    expect(url.searchParams.get("return_error_code")).toBe("true");
    expect(url.searchParams.get("key")).toBe("test-key");
  });

  it("omits the heading when null so Google picks its default view", () => {
    const url = new URL(buildImageUrl("test-key", { panoId: "pano-123", heading: null }));
    expect(url.searchParams.has("heading")).toBe(false);
  });
});

describe("parseStreetViewMetadata", () => {
  it("parses a full OK response", () => {
    const parsed = parseStreetViewMetadata({
      status: "OK",
      pano_id: "abc123",
      location: { lat: 45.5151, lng: -122.6502 },
      date: "2024-06",
      copyright: "\u00a9 Google",
    });
    expect(parsed).toEqual({
      kind: "available",
      panoId: "abc123",
      panoramaLocation: { latitude: 45.5151, longitude: -122.6502 },
      imageryDate: "2024-06",
      copyright: "\u00a9 Google",
    });
  });

  it("tolerates OK responses missing optional fields", () => {
    const parsed = parseStreetViewMetadata({ status: "OK", pano_id: "abc123" });
    expect(parsed).toEqual({
      kind: "available",
      panoId: "abc123",
      panoramaLocation: null,
      imageryDate: null,
      copyright: null,
    });
  });

  it("treats ZERO_RESULTS and NOT_FOUND as unavailable, not errors", () => {
    expect(parseStreetViewMetadata({ status: "ZERO_RESULTS" })).toEqual({ kind: "unavailable" });
    expect(parseStreetViewMetadata({ status: "NOT_FOUND" })).toEqual({ kind: "unavailable" });
  });

  it("surfaces denial and quota statuses as errors", () => {
    expect(parseStreetViewMetadata({ status: "REQUEST_DENIED" })).toEqual({
      kind: "error",
      status: "REQUEST_DENIED",
    });
    expect(parseStreetViewMetadata({ status: "OVER_QUERY_LIMIT" })).toEqual({
      kind: "error",
      status: "OVER_QUERY_LIMIT",
    });
  });

  it("treats malformed bodies as errors", () => {
    expect(parseStreetViewMetadata(null).kind).toBe("error");
    expect(parseStreetViewMetadata("OK").kind).toBe("error");
    expect(parseStreetViewMetadata([]).kind).toBe("error");
    expect(parseStreetViewMetadata({}).kind).toBe("error");
    expect(parseStreetViewMetadata({ status: "OK" }).kind).toBe("error"); // OK without pano_id
    expect(parseStreetViewMetadata({ status: "OK", pano_id: "" }).kind).toBe("error");
  });
});

describe("choosePhotoDisplay", () => {
  it("always prefers a persisted listing photo", () => {
    expect(
      choosePhotoDisplay({ photoUrl: "https://example.com/a.jpg", latitude: 45.515, longitude: -122.65 }),
    ).toBe("listing");
    expect(choosePhotoDisplay({ photoUrl: "https://example.com/a.jpg", latitude: null, longitude: null })).toBe(
      "listing",
    );
  });

  it("falls back to street view only with Portland coordinates", () => {
    expect(choosePhotoDisplay({ photoUrl: null, latitude: 45.515, longitude: -122.65 })).toBe("street-view");
  });

  it("uses the placeholder without coordinates or outside Portland", () => {
    expect(choosePhotoDisplay({ photoUrl: null, latitude: null, longitude: null })).toBe("placeholder");
    expect(choosePhotoDisplay({ photoUrl: null, latitude: 45.515, longitude: null })).toBe("placeholder");
    expect(choosePhotoDisplay({ photoUrl: null, latitude: 47.606, longitude: -122.332 })).toBe("placeholder");
  });
});

describe("street view labeling", () => {
  it("formats imagery dates", () => {
    expect(formatImageryDate("2024-06")).toBe("Jun 2024");
    expect(formatImageryDate("2019-12")).toBe("Dec 2019");
    expect(formatImageryDate("2024-13")).toBeNull();
    expect(formatImageryDate("June 2024")).toBeNull();
    expect(formatImageryDate(null)).toBeNull();
  });

  it("builds the visible label and never claims to be a listing photo", () => {
    expect(buildStreetViewLabel("2024-06")).toBe("Street View \u00b7 Jun 2024");
    expect(buildStreetViewLabel(null)).toBe("Street View");
    expect(buildStreetViewLabel("garbage")).toBe("Street View");
    expect(buildStreetViewLabel("2024-06").toLowerCase()).not.toContain("listing");
  });
});

describe("buildStreetViewFallbackNote", () => {
  it("keeps street view coverage distinct and truthful", () => {
    const note = buildStreetViewFallbackNote(4, 10);
    expect(note).toContain("4 of the 10");
    expect(note).toContain("Street View");
    expect(note).toContain("never presented as a listing photo");
  });

  it("handles full listing-photo coverage", () => {
    expect(buildStreetViewFallbackNote(0, 0)).toContain("no Street View fallback");
  });
});
