export type PropertyTrack = "house" | "plex";

export function parseTrack(value: string | null | undefined): PropertyTrack {
  return value === "plex" ? "plex" : "house";
}

export function trackUrl(url: string, track: PropertyTrack): string {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set("track", track);
  return `${path}?${params}`;
}
