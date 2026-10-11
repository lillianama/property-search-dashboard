import { describe, expect, it, vi } from "vitest";
import { resolveStreetView, type StreetViewProxyDeps } from "./streetview-proxy";

const KNOWN_ID = "dddddddd-1111-4222-8333-444444444444";
const API_KEY = "test-secret-key";
const PORTLAND_LOCATION = { latitude: 45.515, longitude: -122.65 };

const OK_METADATA = {
  status: "OK",
  pano_id: "pano-abc",
  location: { lat: 45.5148, lng: -122.65 }, // just south of the property
  date: "2024-06",
  copyright: "\u00a9 Google",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function imageResponse(bytes = [1, 2, 3], contentType = "image/jpeg", status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { "Content-Type": contentType } });
}

function deps(overrides: Partial<StreetViewProxyDeps> = {}): StreetViewProxyDeps {
  return {
    apiKey: API_KEY,
    fetchLocation: vi.fn().mockResolvedValue(PORTLAND_LOCATION),
    fetchFn: vi.fn().mockResolvedValue(jsonResponse(OK_METADATA)),
    ...overrides,
  };
}

describe("resolveStreetView input validation", () => {
  it("rejects non-UUID ids before touching the database or Google", async () => {
    const d = deps();
    for (const id of ["", "not-a-uuid", "123", "../../etc/passwd", `${KNOWN_ID}x`]) {
      const result = await resolveStreetView(id, "image", d);
      expect(result).toEqual({ type: "not_found", reason: "invalid-property-id" });
    }
    expect(d.fetchLocation).not.toHaveBeenCalled();
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("reports a missing or blank api key without hitting the database", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      const d = deps({ apiKey });
      const result = await resolveStreetView(KNOWN_ID, "image", d);
      expect(result).toEqual({ type: "no_api_key" });
      expect(d.fetchLocation).not.toHaveBeenCalled();
      expect(d.fetchFn).not.toHaveBeenCalled();
    }
  });

  it("rejects unknown property ids", async () => {
    const d = deps({ fetchLocation: vi.fn().mockResolvedValue(null) });
    const result = await resolveStreetView(KNOWN_ID, "image", d);
    expect(result).toEqual({ type: "not_found", reason: "unknown-property" });
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("rejects coordinate-less properties without spending quota", async () => {
    const d = deps({ fetchLocation: vi.fn().mockResolvedValue({ latitude: null, longitude: null }) });
    const result = await resolveStreetView(KNOWN_ID, "image", d);
    expect(result).toEqual({ type: "not_found", reason: "no-coordinates" });
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("rejects non-Portland properties without spending quota", async () => {
    const d = deps({ fetchLocation: vi.fn().mockResolvedValue({ latitude: 47.606, longitude: -122.332 }) });
    const result = await resolveStreetView(KNOWN_ID, "image", d);
    expect(result).toEqual({ type: "not_found", reason: "outside-portland" });
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it("maps database failures to an upstream error, not a crash", async () => {
    const d = deps({ fetchLocation: vi.fn().mockRejectedValue(new Error("db down")) });
    const result = await resolveStreetView(KNOWN_ID, "image", d);
    expect(result).toEqual({ type: "upstream_error", reason: "location-lookup-failed" });
  });
});

describe("resolveStreetView metadata availability check", () => {
  it("runs the free metadata check before any image request", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockResolvedValueOnce(imageResponse());
    await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchFn.mock.calls[0][0] as string);
    expect(firstUrl.pathname).toBe("/maps/api/streetview/metadata");
    expect(firstUrl.searchParams.get("location")).toBe("45.515,-122.65");
  });

  it("treats ZERO_RESULTS as not found and never fetches an image", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: "ZERO_RESULTS" }));
    const result = await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));
    expect(result).toEqual({ type: "not_found", reason: "no-street-view-imagery" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("treats REQUEST_DENIED as an upstream error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: "REQUEST_DENIED" }));
    const result = await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));
    expect(result).toEqual({ type: "upstream_error", reason: "metadata-REQUEST_DENIED" });
  });

  it("handles broken metadata responses (bad status, bad json, network failure)", async () => {
    expect(
      await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn: vi.fn().mockResolvedValue(jsonResponse({}, 500)) })),
    ).toEqual({ type: "upstream_error", reason: "metadata-http-500" });

    expect(
      await resolveStreetView(
        KNOWN_ID,
        "image",
        deps({ fetchFn: vi.fn().mockResolvedValue(new Response("not json", { status: 200 })) }),
      ),
    ).toEqual({ type: "upstream_error", reason: "metadata-fetch-failed" });

    expect(
      await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn: vi.fn().mockRejectedValue(new Error("offline")) })),
    ).toEqual({ type: "upstream_error", reason: "metadata-fetch-failed" });
  });
});

describe("resolveStreetView metadata mode", () => {
  it("returns sanitized metadata without fetching the image", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(OK_METADATA));
    const result = await resolveStreetView(KNOWN_ID, "metadata", deps({ fetchFn }));
    expect(result).toEqual({ type: "metadata", imageryDate: "2024-06", copyright: "\u00a9 Google" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never leaks the api key or panorama internals in the result", async () => {
    const result = await resolveStreetView(KNOWN_ID, "metadata", deps());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("pano-abc");
    expect(serialized).not.toContain("googleapis");
  });
});

describe("resolveStreetView image mode", () => {
  it("fetches the image by panorama, aimed from the camera toward the house", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockResolvedValueOnce(imageResponse([7, 8, 9]));
    const result = await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));

    const imageUrl = new URL(fetchFn.mock.calls[1][0] as string);
    expect(imageUrl.pathname).toBe("/maps/api/streetview");
    expect(imageUrl.searchParams.get("pano")).toBe("pano-abc");
    expect(imageUrl.searchParams.get("return_error_code")).toBe("true");
    // Panorama sits due south of the property, so the camera faces north.
    expect(Number(imageUrl.searchParams.get("heading"))).toBeCloseTo(0, 1);

    expect(result.type).toBe("image");
    if (result.type === "image") {
      expect(result.contentType).toBe("image/jpeg");
      expect(new Uint8Array(result.body)).toEqual(new Uint8Array([7, 8, 9]));
    }
  });

  it("omits the heading when the panorama location is unknown", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", pano_id: "pano-abc" }))
      .mockResolvedValueOnce(imageResponse());
    await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));
    const imageUrl = new URL(fetchFn.mock.calls[1][0] as string);
    expect(imageUrl.searchParams.has("heading")).toBe(false);
  });

  it("maps a return_error_code 404 to not found", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockResolvedValueOnce(imageResponse([], "text/plain", 404));
    const result = await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }));
    expect(result).toEqual({ type: "not_found", reason: "image-not-found" });
  });

  it("maps other image failures to upstream errors", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockResolvedValueOnce(imageResponse([], "image/jpeg", 500));
    expect(await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn }))).toEqual({
      type: "upstream_error",
      reason: "image-http-500",
    });

    const fetchFnHtml = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockResolvedValueOnce(imageResponse([1], "text/html", 200));
    expect(await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn: fetchFnHtml }))).toEqual({
      type: "upstream_error",
      reason: "image-not-an-image",
    });

    const fetchFnNetwork = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(OK_METADATA))
      .mockRejectedValueOnce(new Error("reset"));
    expect(await resolveStreetView(KNOWN_ID, "image", deps({ fetchFn: fetchFnNetwork }))).toEqual({
      type: "upstream_error",
      reason: "image-fetch-failed",
    });
  });

  it("never places the api key in non-image results", async () => {
    const outcomes = [
      await resolveStreetView("bad-id", "image", deps()),
      await resolveStreetView(KNOWN_ID, "image", deps({ fetchLocation: vi.fn().mockResolvedValue(null) })),
      await resolveStreetView(
        KNOWN_ID,
        "image",
        deps({ fetchFn: vi.fn().mockResolvedValue(jsonResponse({ status: "REQUEST_DENIED" })) }),
      ),
    ];
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    }
  });
});
