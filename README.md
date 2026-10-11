# Property Search Dashboard

A standalone Next.js dashboard for researching houses and plexes against an external PostgreSQL property store. The current regional enrichment and market-data adapters are configured for Portland, Oregon; those Portland-specific assumptions are called out below rather than implied as universal behavior. The code is public, but any live dashboard and its property data remain private and must stay behind external authentication. This repository contains application code, synthetic tests, and schema-only SQL; it contains no property records, research workflow, user data, or database backup.

## Setup

Requires Node.js 22 or newer with npm, or Docker Engine with Docker Compose v2. PostgreSQL must be separately provisioned and reachable from your chosen runtime. A schema-only initializer is included for fresh installations; it does not recreate any research workflow or import data. No database container or property research/ingestion pipeline is included.

```sh
cp .env.example .env
npm ci
npm run dev -- --hostname 127.0.0.1
```

Next.js reads `.env` for local development. For containers, Compose injects the listed environment variables at runtime. Set `DATABASE_URL` to your own external database URL; leave it empty to explore the database-unavailable UI. Inside a container, `localhost` refers to the container, not the database host. Use a reachable database hostname and configure PostgreSQL TLS and permissions as appropriate for your infrastructure.

```sh
docker compose config --quiet
docker compose build web
docker compose up -d web
```

Visit `http://localhost:3000`. The portable default Compose setup publishes the app on loopback only; `WEB_PORT` changes the host port and `WEB_BIND_ADDRESS` changes the published host interface (default `127.0.0.1`). For a host-network reverse-proxy deployment, use `docker compose -f compose.yaml -f compose.host-network.yaml up -d web` and set `WEB_HOSTNAME` to a private host interface address and `WEB_PORT` to an available port. The override removes port publishing and makes the app bind directly to that configured address. Keep this listener private and reachable only by the authenticated reverse proxy; do not bind it to a public/LAN interface. The app has **no built-in authentication**: put an authenticated TLS reverse proxy in front of it before allowing remote access. Same-origin checks protect write requests but do not authenticate users. All users of a deployment share its database and notes.

Secrets belong only in an untracked local `.env` or runtime environment. Build stages need no database credentials or Google key. The Docker build context uses an allowlist that excludes Git metadata and environment files. Do not put secrets or user data in source directories. The web and optional ingest images run as the unprivileged Node user.

## Database schema and external contract

This repository includes schema-only initialization for a fresh database, but not the private research workflow, property records, or their provenance history. The base schema in `scripts/schema/property-store-schema.sql` defines tables, indexes, views, and required extension only. It has no data inserts. Review the SQL and run it explicitly with a PostgreSQL schema-capable role; the web process never executes DDL. `CREATE EXTENSION pgcrypto` may require a database administrator.

For a fresh compatible PostgreSQL database, apply the base schema, then the additive dashboard schemas. For an existing private property store, do not apply the base schema; apply only needed additive migrations after checking compatibility. These operations do not load or alter property data.

```sh
# From the project root, with DATABASE_URL supplied securely in the shell/runtime
npm run schema:base       # fresh database only
npm run schema:editor
npm run schema:rank-prefs
npm run schema:market
```

The same explicit schema scripts are available in the optional maintenance image. The editor and ranking migrations are append-only/additive; market schema creates only the market tables. `npm run ingest` / the market-ingest Compose profile is a separate, manually invoked data-ingestion operation.

This dashboard expects the following property-store contract after schema setup (the base SQL supplies its structural tables/views, not records): The authoritative SELECT contracts are in `lib/queries.ts` and `lib/market-queries.ts`; write contracts are in `lib/editor-writes.ts` and `lib/funnel-writes.ts`.

The property store must expose:

- `property_current`: property UUID `id`, `track` (`house` or `plex`), `canonical_address`, `city`, `state`, `zip_code`, coordinates, numeric JSONB observations (`bedrooms`, `bathrooms`, `finished_sqft`, `year_built`), latest listing/sale fields, and first/last-seen timestamps.
- `property_records`: the underlying property identity and track used to validate and lock writes.
- `property_bedroom_flags`, `property_identifiers`, `property_listing_events`, `property_observations`, and `property_source_snapshots`: measurements, listing URLs, status history, and allowlisted photo/tax/neighborhood source fields.
- `property_interactions` and `property_collections`: decisions and collection memberships used by the funnel and rejected archive.

Consult the SQL in the modules above for exact columns and types before connecting an independently implemented store. The included base schema is structural only; it does not provide the private research workflow, seed data, or historical provenance records. No database connection is required to build or run unit tests.

For the optional maintenance container, set `MARKET_DATABASE_URL` securely to the target database. It is passed as runtime configuration, never baked into the image:

The web role needs SELECT on the referenced relations, INSERT on editor notes/judgments, rank revisions, interactions and collections, and UPDATE on collections for membership changes, plus USAGE on associated sequences and UPDATE on the identifier column of property_records for row-level transaction locks. The app never changes source-fact columns. It does not need DDL or DELETE. Read paths set session read-only mode; the two validated write endpoints use explicit transactions. Missing optional enrichments render unknown/incomplete states. `/api/health` reports process liveness; `/api/db-health` separately checks database connectivity.

## Houses and Plexes

The mode switch persists `track=house` or `track=plex` in the URL. Each mode has its own tracked results, KPIs, charts, map, funnel ranks, rejection archive, editor requests and photo lookups. PITI assumptions are global across both modes, matching the original dashboard behavior. The browser key defaults to a generic project-specific name; deployments may set `PROPERTY_SEARCH_DASHBOARD_PITI_STORAGE_KEY` at runtime to preserve an existing same-origin key without publishing it in this repository. Switching modes remounts the view to isolate loaded data, drafts and optimistic changes. Writes validate property and neighbor membership in the selected track. Properties without a collection appear in Watchlist without writing a membership.

The Market tab currently displays Zillow Research single-family data for Portland, Oregon Houses. Portland assessor-neighborhood matching, regional bounds for Street View fallback, and the ingestion filters are Portland-specific code configuration; changing the market region requires updating those adapters and their tests. Plexes explicitly reports market data unavailable; it never substitutes single-family metrics or neighborhood valuations as plex data.

## Features

- My Search filters apply to KPIs, status/history/price charts and Map/List views. MapLibre uses OpenStreetMap tiles, with accessible marker quick views and Edit/Reject actions.
- The list provides keyboard and pointer drag-and-drop across Top contenders, To tour, Watchlist and a confirmation-based Rejected target. Fractional rank revisions are append-only, serialized with an advisory lock; stale neighbor order returns a conflict and rolls back the optimistic UI.
- Rejected properties appear only in the archive when their latest explicit decision is a rejection. Later reconsideration restores the property without deleting history.
- The editor saves Remarks, Pros, Cons and three tri-state judgments as append-only revisions, with unsaved-change protection and immediate confirmed updates.
- Status resolution distinguishes generic inactive-feed observations from explicit pending/sold/relisting evidence. Date added comes from the property store, independently of listing dates.
- PITI uses editable local assumptions, actual recorded taxes only, and an explicit incomplete state when tax data is absent. Defaults are illustrative: 5% down, 30 years, 6.5% note rate, $1,200 annual insurance and 0.36% annual PMI; HOA is excluded. Stored settings are versioned and migrated.
- Photos come from allowlisted stored fields. Optional server-side Google Street View fallback requires `GOOGLE_CLOUD_API_KEY` with Street View Static API enabled. It remains visibly labeled, loads lazily, and does not persist image bytes. Without the key, a placeholder remains available.
- Assessor neighborhoods join to Zillow regions by normalized names and explicit aliases; unknown matches stay unknown. RMLS sources are recognized by the generic `rmls` source family.
- Tabs, filters, Map/List view, track and editor selection survive URL restoration; Back/Forward, scroll restoration, refresh feedback and editor-return highlighting remain available.

## Optional market ingestion

The manually invoked profile downloads official public Zillow Research monthly CSVs and upserts Portland, Oregon single-family city metrics and neighborhood ZHVI into `market_metric_series`; `market_ingest_runs` records outcomes. Apply the idempotent additive schema in `scripts/market-schema.sql` separately with a schema-capable role before the first ingestion. The ingestion process never runs DDL and needs only SELECT, INSERT, UPDATE and sequence USAGE on its two market tables. It does not modify property-store records. This is not a research workflow migration. Nothing schedules ingestion automatically.

```sh
docker compose --profile market-ingest run --rm market-ingest
# If using the private host-network deployment, include its override:
# docker compose -f compose.yaml -f compose.host-network.yaml --profile market-ingest run --rm market-ingest
```

Until ingestion runs, market panels report missing data. Preference-match defaults can be overridden with the three `MARKET_PREF_*` variables in `.env.example`. This summary counts tracked properties only, not the full market. The UI reports data age and limited coverage.

## Verification and provenance

```sh
npm test
npm run typecheck
npm run build
docker compose --profile market-ingest config --quiet
# Optional: inspect schema SQL for data-changing statements before applying
```

Tests use synthetic records and mocked database clients. They cover track query/API/write isolation, market separation, ranking, notes, status, rejection, photos, PITI, URL state and interaction helpers. These checks do not establish connectivity to a real property store or replace browser/deployment testing.
