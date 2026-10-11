import { withReadOnlyClient } from "./db";
import { selectPlexUnits, type PlexUnitSummary, type UnitSourceRow } from "./plex-units";

// Project individual keys inside each unit BEFORE data leaves PostgreSQL.
// Unattributed rent estimates, building totals and manual financial blobs
// cannot safely be mapped to a unit and are deliberately excluded.
export const PLEX_UNIT_SQL = `
  SELECT o.property_id::text, o.field, o.source, o.observed_at::text,
    CASE
      WHEN o.field = 'unit_count' AND jsonb_typeof(o.value) = 'number' THEN o.value
      WHEN o.field = 'unit_configuration' AND jsonb_typeof(o.value) = 'string'
        THEN to_jsonb(substring(o.value #>> '{}' from '^Two side-by-side [0-9]+BR/[0-9]+(?:[.][0-9]+)?BA units(?:,|$)'))
      WHEN o.field = 'unit_mix' AND jsonb_typeof(o.value) = 'array' THEN
        (SELECT jsonb_agg(jsonb_build_object(
          'bedrooms', CASE WHEN jsonb_typeof(u->'bedrooms') = 'number' THEN u->'bedrooms' END, 'bathrooms', CASE WHEN jsonb_typeof(u->'bathrooms') = 'number' THEN u->'bathrooms' END,
          'sqft', CASE WHEN jsonb_typeof(u->'sqft') = 'number' THEN u->'sqft' END, 'occupancy', CASE WHEN u->>'occupancy' IN ('occupied', 'vacant') THEN u->'occupancy' END,
          'actualRent', CASE WHEN jsonb_typeof(u->'actualRent') = 'number' THEN u->'actualRent' END, 'expectedMonthlyRent', CASE WHEN jsonb_typeof(u->'expectedMonthlyRent') = 'number' THEN u->'expectedMonthlyRent' END
        ) ORDER BY ordinal)
        FROM jsonb_array_elements(o.value) WITH ORDINALITY AS units(u, ordinal)
        WHERE jsonb_typeof(u) = 'object')
      ELSE NULL
    END AS value
  FROM property_observations o
  JOIN property_records p ON p.id = o.property_id
  WHERE p.track = 'plex' AND o.property_id = ANY($1::uuid[])
    AND o.field IN ('unit_mix', 'unit_configuration', 'unit_count')
  ORDER BY o.observed_at DESC, o.id DESC
`;

export async function fetchPlexUnitSummaries(propertyIds: string[]): Promise<Map<string, PlexUnitSummary>> {
  if (!propertyIds.length) return new Map();
  return withReadOnlyClient(async client => {
    const result = await client.query<UnitSourceRow>(PLEX_UNIT_SQL, [propertyIds]);
    return selectPlexUnits(result.rows);
  });
}
