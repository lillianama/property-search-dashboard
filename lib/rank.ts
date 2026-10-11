// Pure, dependency-free fractional ranking ("LexoRank-style") for the ONE
// durable global manual order across every tracked house. Rank keys are
// base-36 strings compared lexicographically; inserting between two rows
// only writes ONE new key (no renumbering), and a deterministic compaction
// re-spaces every key when chains grow too long. The rank NUMBER is never
// shown anywhere — order is communicated purely by row position.
//
// Persistence lives in scripts/rank-prefs-schema.sql (append-only
// property_funnel_ranks revisions) and lib/funnel-writes.ts; everything in
// this module is unit-testable without a database.

/** Ordered digit alphabet for rank keys. '0' is the lowest digit; valid
 * keys never END in '0' so every key keeps room strictly before the next
 * key that shares its prefix. */
export const RANK_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const BASE = RANK_ALPHABET.length;

/** A structurally valid rank key: non-empty, alphabet chars only, no
 * trailing '0'. Anything else in storage is treated as "no rank". */
export function isValidRankKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.endsWith("0")) return false;
  for (const ch of key) {
    if (!RANK_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Plain lexicographic comparison — exactly how Postgres ORDER BY and
 * Array.prototype.sort compare the keys, so every layer agrees. */
export function compareRankKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The midpoint algorithm (after Greenspan's fractional indexing): returns a
 * key strictly between `a` and `b`, where "" for `a` means "before
 * everything" and "" for `b` means "after everything". Both inputs must be
 * valid keys (or ""); throws on inverted/equal bounds so callers surface
 * stale concurrent moves instead of silently mis-ordering.
 */
function midpoint(a: string, b: string): string {
  if (b !== "" && a >= b) {
    throw new RangeError(`rank midpoint bounds inverted: "${a}" >= "${b}"`);
  }
  if (b !== "") {
    // Recurse past the longest common prefix. `a` shorter than the prefix
    // behaves as if padded with '0' (the lowest digit).
    let n = 0;
    while ((a.charAt(n) || "0") === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a === "" ? 0 : RANK_ALPHABET.indexOf(a.charAt(0));
  const digitB = b === "" ? BASE : RANK_ALPHABET.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return RANK_ALPHABET.charAt(Math.round(0.5 * (digitA + digitB)));
  }
  // Consecutive leading digits: reuse b's head when it has room below it,
  // otherwise extend a's head with a midpoint above a's tail.
  if (b.length > 1) {
    return b.slice(0, 1);
  }
  return RANK_ALPHABET.charAt(digitA) + midpoint(a.slice(1), "");
}

/**
 * A key strictly between `after` (null = start of the list) and `before`
 * (null = end of the list). Returns null instead of throwing when the
 * bounds are invalid or inverted — the caller decides how to surface the
 * stale/concurrent move.
 */
export function rankKeyBetween(after: string | null, before: string | null): string | null {
  const a = after ?? "";
  const b = before ?? "";
  if (a !== "" && !isValidRankKey(a)) return null;
  if (b !== "" && !isValidRankKey(b)) return null;
  if (a !== "" && b !== "" && a >= b) return null;
  try {
    const key = midpoint(a, b);
    return isValidRankKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** Keys longer than this trigger a deterministic compaction (a fresh
 * evenly-spaced key for every row) instead of growing without bound. Depth
 * like this needs thousands of adversarial same-spot insertions, so
 * compactions are rare. */
export const COMPACTION_KEY_LENGTH = 24;

export function needsCompaction(key: string): boolean {
  return key.length > COMPACTION_KEY_LENGTH;
}

function encodeBase36(value: number, width: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    out = RANK_ALPHABET.charAt(rest % BASE) + out;
    rest = Math.floor(rest / BASE);
  }
  return out;
}

/**
 * `count` strictly-increasing, evenly spaced, valid rank keys. Deterministic
 * for a given count, with generous gaps so normal moves keep landing single
 * short keys between neighbors. Used for the initial bootstrap and for
 * compaction.
 */
export function generateSpacedKeys(count: number): string[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  let width = 1;
  // Enough headroom that consecutive keys stay >= 32 apart in key space.
  while (BASE ** width < (count + 1) * 32) width += 1;
  const step = Math.floor((BASE ** width - 1) / (count + 1));
  const keys: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    // Trailing '0's are stripped (preserves lexicographic order for
    // fixed-width base-36 strings) so the keys are valid rank keys.
    const key = encodeBase36(i * step, width).replace(/0+$/, "");
    keys.push(key === "" ? RANK_ALPHABET.charAt(1) : key);
  }
  return keys;
}

// ── Bootstrap planning ───────────────────────────────────────────────────────

/** The minimum a house must expose for deterministic rank bootstrap. */
export interface RankableHouse {
  id: string;
  /** Funnel bucket precedence index (0 = top-contenders). Rejected houses
   * may be passed with the lowest precedence so they too keep a durable
   * rank for later restoration. */
  bucketPrecedence: number;
  /** ISO timestamp (or null): when the house entered the dashboard’s store. */
  dateAdded: string | null;
  address: string;
  /** Currently persisted rank key, or null when unranked. */
  rankKey: string | null;
}

/**
 * The canonical bootstrap ordering for houses with no persisted rank:
 * bucket precedence first (top-contenders, to-tour, watchlist), then
 * newest dateAdded first (nulls last), then address ascending, then id —
 * fully deterministic, mirroring how the list rendered before ranks
 * existed.
 */
export function compareBootstrapOrder(a: RankableHouse, b: RankableHouse): number {
  if (a.bucketPrecedence !== b.bucketPrecedence) return a.bucketPrecedence - b.bucketPrecedence;
  if (a.dateAdded !== b.dateAdded) {
    if (a.dateAdded === null) return 1;
    if (b.dateAdded === null) return -1;
    return a.dateAdded < b.dateAdded ? 1 : -1;
  }
  const byAddress = a.address.localeCompare(b.address);
  if (byAddress !== 0) return byAddress;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface RankAssignment {
  id: string;
  rankKey: string;
}

/**
 * Plans the deterministic rank keys to persist for every house that lacks
 * one, WITHOUT touching any existing rank:
 *
 * - When no house has a rank yet, every house gets an evenly spaced key in
 *   bootstrap order (the historical display order), so the very first drag
 *   starts from exactly what was on screen.
 * - When some houses are already ranked, each unranked house is chained in
 *   BEFORE the lowest-ranked house of its own bucket (new houses surface at
 *   the top of their bucket, newest first), or before the lowest ranked key
 *   overall when its bucket has no ranked rows yet.
 *
 * Returns only the new assignments; never rewrites an existing key.
 */
export function planRankBootstrap(houses: RankableHouse[]): RankAssignment[] {
  const unranked = houses.filter((h) => h.rankKey === null || !isValidRankKey(h.rankKey));
  if (unranked.length === 0) return [];
  unranked.sort(compareBootstrapOrder);

  const ranked = houses.filter((h): h is RankableHouse & { rankKey: string } =>
    h.rankKey !== null && isValidRankKey(h.rankKey),
  );

  if (ranked.length === 0) {
    const keys = generateSpacedKeys(unranked.length);
    return unranked.map((house, i) => ({ id: house.id, rankKey: keys[i] }));
  }

  let globalMin: string | null = null;
  const bucketMin = new Map<number, string>();
  for (const house of ranked) {
    if (globalMin === null || house.rankKey < globalMin) globalMin = house.rankKey;
    const current = bucketMin.get(house.bucketPrecedence);
    if (current === undefined || house.rankKey < current) {
      bucketMin.set(house.bucketPrecedence, house.rankKey);
    }
  }

  const assignments: RankAssignment[] = [];
  // Chain per bucket so several new arrivals in one bucket keep their
  // relative (newest-first) order among themselves.
  const prevByBucket = new Map<number, string | null>();
  for (const house of unranked) {
    const anchor = bucketMin.get(house.bucketPrecedence) ?? globalMin;
    const prev = prevByBucket.get(house.bucketPrecedence) ?? null;
    let key = rankKeyBetween(prev, anchor);
    if (key === null) {
      // Degenerate chain (extremely dense keys): fall back to spreading
      // after the last assigned key while staying deterministic.
      key = rankKeyBetween(prev, null);
    }
    if (key === null) continue; // unreachable in practice; skip rather than corrupt
    assignments.push({ id: house.id, rankKey: key });
    prevByBucket.set(house.bucketPrecedence, key);
  }
  return assignments;
}

/**
 * Deterministic full compaction: fresh evenly spaced keys for the given
 * ids IN THE ORDER SUPPLIED (the caller passes the current resolved global
 * order, with the moved house already at its requested position). Every id
 * gets a new short key; history rows are preserved by the append-only
 * storage, so provenance survives compaction.
 */
export function planCompaction(orderedIds: string[]): RankAssignment[] {
  const keys = generateSpacedKeys(orderedIds.length);
  return orderedIds.map((id, i) => ({ id, rankKey: keys[i] }));
}
