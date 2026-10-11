import { describe, expect, it } from "vitest";
import {
  attachPhotoSelections,
  buildPhotoCoverageNote,
  extractPhotoCandidates,
  isSafePhotoUrl,
  selectBestPhoto,
  selectPhotosByProperty,
  type PhotoCandidate,
  type PhotoSourceRow,
} from "./photos";
import type { HouseRecord } from "./types";

function row(overrides: Partial<PhotoSourceRow>): PhotoSourceRow {
  return {
    propertyId: "prop-1",
    payload: {},
    source: "rentcast-house-weekly",
    observedAt: "2026-07-01T00:00:00Z",
    confidence: 0.7,
    ...overrides,
  };
}

function house(overrides: Partial<HouseRecord>): HouseRecord {
  return {
    id: "prop-1",
    address: "123 SE Example St",
    city: "Portland",
    state: "OR",
    zipCode: "97202",
    latitude: 45.5,
    longitude: -122.6,
    bedrooms: 3,
    bathrooms: 1,
    finishedSqft: 1400,
    yearBuilt: 1925,
    latestPrice: 450000,
    latestStatus: "Active",
    latestSalePrice: null,
    latestSaleDate: null,
    bedroomSizeFlag: "ok",
    smallestBedroomSqft: 110,
    zillowUrl: null,
    photoUrl: null,
    photoSource: null,
    funnelBucket: "watchlist",
    rankKey: null,
    judgments: { bedroomSizeOk: "unknown" as const, rentalIncome: "unknown" as const, drumSpace: "unknown" as const },
    displayStatus: "Active",
    dateAdded: null,
    annualTaxAmount: null,
    annualTaxYear: null,
    annualTaxAsOf: null,
    annualTaxSource: null,
    firstSeenAt: null,
    lastSeenAt: null,
    neighborhood: null,
    neighborhoodMarket: null,
    ...overrides,
  };
}

describe("isSafePhotoUrl", () => {
  it("accepts https URLs with an image extension", () => {
    expect(isSafePhotoUrl("https://example.com/homes/front.jpg")).toBe(true);
    expect(isSafePhotoUrl("https://example.com/a.jpeg")).toBe(true);
    expect(isSafePhotoUrl("https://example.com/a.PNG")).toBe(true);
    expect(isSafePhotoUrl("https://example.com/a.webp?w=640")).toBe(true);
  });

  it("accepts trusted listing-photo hosts without an extension", () => {
    expect(isSafePhotoUrl("https://photos.zillowstatic.com/fp/abc123-cc_ft_768")).toBe(true);
    expect(isSafePhotoUrl("https://ap.rdcpix.com/abc/photo-m1s")).toBe(true);
  });

  it("rejects non-https, credentialed, and private-host URLs", () => {
    expect(isSafePhotoUrl("http://example.com/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://user:pass@credentialtest/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://localhost/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://192.168.1.5/a.jpg")).toBe(false);
    expect(isSafePhotoUrl("https://10.0.0.2/a.jpg")).toBe(false);
  });

  it("rejects non-image pages, garbage, and non-strings", () => {
    expect(isSafePhotoUrl("https://www.zillow.com/homes/123-Main-St_rb/")).toBe(false);
    expect(isSafePhotoUrl("https://realtor.example.com/about")).toBe(false);
    expect(isSafePhotoUrl("not a url")).toBe(false);
    expect(isSafePhotoUrl("")).toBe(false);
    expect(isSafePhotoUrl(null)).toBe(false);
    expect(isSafePhotoUrl(42)).toBe(false);
    expect(isSafePhotoUrl({ url: "https://example.com/a.jpg" })).toBe(false);
  });

  it("rejects absurdly long URLs", () => {
    expect(isSafePhotoUrl(`https://example.com/${"a".repeat(2100)}.jpg`)).toBe(false);
  });
});

describe("extractPhotoCandidates", () => {
  it("reads string, string-array, and media-object-array shapes from allowlisted keys", () => {
    const candidates = extractPhotoCandidates(
      row({
        payload: {
          photoUrl: "https://example.com/main.jpg",
          photos: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
          images: [{ url: "https://example.com/3.jpg" }, { href: "https://example.com/4.jpg" }],
        },
      }),
    );
    expect(candidates.map((c) => c.url)).toEqual([
      "https://example.com/1.jpg",
      "https://example.com/2.jpg",
      "https://example.com/3.jpg",
      "https://example.com/4.jpg",
      "https://example.com/main.jpg",
    ]);
    expect(candidates.map((c) => c.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never reads photo-looking URLs from non-allowlisted keys", () => {
    const candidates = extractPhotoCandidates(
      row({
        payload: {
          description: "See https://example.com/sneaky.jpg",
          owner: "https://example.com/owner.jpg",
          listingAgent: { url: "https://example.com/agent.jpg" },
          zillowUrl: "https://example.com/page.jpg",
        },
      }),
    );
    expect(candidates).toEqual([]);
  });

  it("drops unsafe URLs and tolerates malformed payloads", () => {
    expect(
      extractPhotoCandidates(
        row({ payload: { photos: ["http://example.com/a.jpg", 42, null, "https://ok.example.com/b.jpg"] } }),
      ).map((c) => c.url),
    ).toEqual(["https://ok.example.com/b.jpg"]);
    expect(extractPhotoCandidates(row({ payload: null }))).toEqual([]);
    expect(extractPhotoCandidates(row({ payload: "https://example.com/a.jpg" }))).toEqual([]);
    expect(extractPhotoCandidates(row({ payload: ["https://example.com/a.jpg"] }))).toEqual([]);
  });

  it("carries provenance onto each candidate", () => {
    const [candidate] = extractPhotoCandidates(
      row({ source: "rmls", confidence: 0.9, payload: { photoUrl: "https://example.com/a.jpg" } }),
    );
    expect(candidate.source).toBe("rmls");
    expect(candidate.confidence).toBe(0.9);
    expect(candidate.observedAt).toBe("2026-07-01T00:00:00Z");
  });
});

describe("selectBestPhoto", () => {
  const base: PhotoCandidate = {
    url: "https://example.com/a.jpg",
    source: "s",
    observedAt: "2026-07-01T00:00:00Z",
    confidence: 0.7,
    sequence: 0,
  };

  it("returns null for no candidates", () => {
    expect(selectBestPhoto([])).toBeNull();
  });

  it("prefers higher confidence", () => {
    const picked = selectBestPhoto([
      { ...base, url: "https://example.com/low.jpg", confidence: 0.5 },
      { ...base, url: "https://example.com/high.jpg", confidence: 0.9 },
    ]);
    expect(picked?.url).toBe("https://example.com/high.jpg");
  });

  it("prefers newer observations at equal confidence", () => {
    const picked = selectBestPhoto([
      { ...base, url: "https://example.com/old.jpg", observedAt: "2026-01-01T00:00:00Z" },
      { ...base, url: "https://example.com/new.jpg", observedAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(picked?.url).toBe("https://example.com/new.jpg");
  });

  it("prefers earlier payload position, then URL, as final tiebreaks", () => {
    const bySequence = selectBestPhoto([
      { ...base, url: "https://example.com/second.jpg", sequence: 1 },
      { ...base, url: "https://example.com/first.jpg", sequence: 0 },
    ]);
    expect(bySequence?.url).toBe("https://example.com/first.jpg");

    const byUrl = selectBestPhoto([
      { ...base, url: "https://example.com/b.jpg" },
      { ...base, url: "https://example.com/a.jpg" },
    ]);
    expect(byUrl?.url).toBe("https://example.com/a.jpg");
  });

  it("is deterministic regardless of input order", () => {
    const candidates: PhotoCandidate[] = [
      { ...base, url: "https://example.com/x.jpg", confidence: 0.7, sequence: 2 },
      { ...base, url: "https://example.com/y.jpg", confidence: 0.9, sequence: 5 },
      { ...base, url: "https://example.com/z.jpg", confidence: null, sequence: 0 },
    ];
    const forward = selectBestPhoto(candidates);
    const reversed = selectBestPhoto([...candidates].reverse());
    expect(forward).toEqual(reversed);
    expect(forward?.url).toBe("https://example.com/y.jpg");
  });
});

describe("selectPhotosByProperty", () => {
  it("groups rows per property and merges candidates across rows", () => {
    const selections = selectPhotosByProperty([
      row({ propertyId: "p1", confidence: 0.6, payload: { photoUrl: "https://example.com/p1-low.jpg" } }),
      row({ propertyId: "p1", confidence: 0.9, payload: { photoUrl: "https://example.com/p1-high.jpg" } }),
      row({ propertyId: "p2", payload: { photos: ["https://example.com/p2.jpg"] } }),
      row({ propertyId: "p3", payload: { description: "no photos here" } }),
    ]);
    expect(selections.get("p1")).toEqual({ url: "https://example.com/p1-high.jpg", source: "rentcast-house-weekly" });
    expect(selections.get("p2")?.url).toBe("https://example.com/p2.jpg");
    expect(selections.has("p3")).toBe(false);
  });
});

describe("attachPhotoSelections", () => {
  it("fills photo fields from selections and leaves the rest null", () => {
    const selections = new Map([["prop-1", { url: "https://example.com/a.jpg", source: "rmls" }]]);
    const { houses, withPhoto } = attachPhotoSelections(
      [house({ id: "prop-1" }), house({ id: "prop-2", address: "456 NE Other Ave" })],
      selections,
    );
    expect(withPhoto).toBe(1);
    expect(houses[0].photoUrl).toBe("https://example.com/a.jpg");
    expect(houses[0].photoSource).toBe("rmls");
    expect(houses[1].photoUrl).toBeNull();
    expect(houses[1].photoSource).toBeNull();
  });

  it("does not mutate the input records", () => {
    const input = house({ id: "prop-1" });
    attachPhotoSelections([input], new Map([["prop-1", { url: "https://example.com/a.jpg", source: "s" }]]));
    expect(input.photoUrl).toBeNull();
  });
});

describe("buildPhotoCoverageNote", () => {
  it("is honest when nothing has a photo", () => {
    const note = buildPhotoCoverageNote(0, 12);
    expect(note).toContain("0 of 12");
    expect(note).toContain("never fetched live, scraped, or fabricated");
  });

  it("only ever counts stored listing photos, never Street View fallbacks", () => {
    const note = buildPhotoCoverageNote(3, 12);
    expect(note).toContain("listing photo stored in the property store");
    expect(note).not.toContain("Street View");
  });

  it("reports partial coverage", () => {
    const note = buildPhotoCoverageNote(3, 12);
    expect(note).toContain("3 of 12");
  });

  it("handles the empty filtered set", () => {
    expect(buildPhotoCoverageNote(0, 0)).toContain("not applicable");
  });
});
