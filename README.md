# 💜 Nova Nest · Dashboard

**A cozy command center for your next home (or next plex).**

House hunting has enough tabs. This one helps you remember why you liked the kitchen—and why you absolutely did not like the basement.

Nova Nest is a self-hosted property-search dashboard built with Next.js and PostgreSQL. Keep **Houses** and **Plexes** in separate search tracks, compare the numbers, and move promising places from “hmm” to “let’s tour.” Its regional market and enrichment adapters currently target **Portland, Oregon**.

## 🏡 What's in the nest?

- **Your shortlist, organized:** Top contenders, To tour, Watchlist, and a Rejected archive with reconsideration. Drag, drop, or use the keyboard; decisions keep their history.
- **The big picture:** filtered lists, an interactive map, KPIs, price/status charts, and shareable view URLs. Filters stay put through refreshes. Finally, a little object permanence.
- **Notes that remember:** remarks, pros, cons, and tri-state judgments with revision history and unsaved-change protection.
- **Numbers with boundaries:** editable PITI assumptions and recorded taxes; plex rent summaries and estimated rent-minus-PITI comparisons when whole-building data is complete and comparable. This is not a full operating-profit model. Missing facts stay unknown—not magically zero.
- **Useful context:** stored listing photos, published bedroom measurements/flags, listing history, and optional labeled Google Street View fallback.
- **A market reality check:** optional Zillow Research single-family city and neighborhood series for Portland. Plex market data is explicitly unavailable; houses do not get to impersonate duplexes.

### Two little helpers, one nest

This repo is the place to **review, compare, and decide**. The companion [Nova Nest browser extension](https://github.com/lillianama/property-search-browser-extension) reads supported Zillow listing pages you open and sends validated observations to your dashboard. It can offer an explicit **Add to Watchlist** action for eligible untracked listings; browsing alone never creates a property.

The dashboard also works without the extension. Neither repo includes a complete property-discovery/research pipeline or a ready-filled database.

## 🚀 Get it running

Requires **Node.js 22+ and npm**, or **Docker Engine + Compose v2**. Provision PostgreSQL separately; no database container is bundled.

```sh
cp .env.example .env
npm ci
npm run dev -- --hostname 127.0.0.1
```

Open <http://localhost:3000>. Set `DATABASE_URL` in your untracked `.env` to your compatible property store, or leave it empty to explore the database-unavailable UI. An empty database is not a secret demo catalog. It is just empty. Very minimalist.

For a **fresh database**, review and apply the schema explicitly with a schema-capable role and securely supplied `DATABASE_URL`:

```sh
npm run schema:base       # fresh databases only; never over an existing store
npm run schema:editor
npm run schema:rank-prefs
npm run schema:market
```

These create structure, not property records. `pgcrypto` may require an administrator. The web process never runs DDL; an existing store needs only compatible additive migrations, not the base initializer.

Prefer containers? After configuring `.env`:

```sh
docker compose config --quiet
docker compose build web
docker compose up -d web
```

The default publishes on loopback at port 3000. `WEB_PORT` changes the host port; a container's `localhost` is the container itself, so use a database hostname it can actually reach.

## 🔐 Public code, private nest

There is **no built-in user authentication**. Keep the listener private and put an authenticated TLS reverse proxy in front of remote access. Same-origin checks are not login, and everyone using a deployment shares its database and notes.

Keep credentials, property records, and private research out of Git. Use an untracked `.env` or runtime environment; no secrets are needed for image builds. This repo contains application code, schema SQL, and synthetic tests—not anybody's housing diary.

The extension uses a separate scoped token, an allowed extension ID, and a restricted database role. It captures allowlisted listing facts with provenance, not your dashboard notes or judgments. Exact identity checks reject conflicts; apartment-only facts must not become whole-property facts just because the street address looks familiar.

<details>
<summary>🔧 Connecting the extension and other setup details</summary>

### Browser observations

1. Provision a dedicated PostgreSQL LOGIN role named `browser_observation_writer`, without inherited application privileges. As the trusted schema owner, review and apply [scripts/browser-observation-schema.sql](scripts/browser-observation-schema.sql) after the property/editor/ranking schemas. It grants execution on validated functions, not direct table access.
2. Set `BROWSER_OBSERVATION_DATABASE_URL` for that role, a strong private `BROWSER_OBSERVATION_TOKEN`, and `BROWSER_OBSERVATION_EXTENSION_ID` from Chrome. All three are required; the API stays disabled otherwise. See [.env.example](.env.example).
3. Configure the authenticated TLS proxy so the extension can reach `OPTIONS` and bearer-authenticated `POST /api/browser-observations` without an interactive login redirect. Preserve authentication on dashboard pages; the endpoint checks its own token and extension origin.
4. Follow the [extension setup](https://github.com/lillianama/property-search-browser-extension#-let-it-perch-in-chrome). Recognition and capture are separate: an exact apartment-range alias may report a tracked whole property while apartment capture and Add remain blocked.

### Database and runtime contract

The schema-only [base SQL](scripts/schema/property-store-schema.sql) defines property records, identifiers, observations, source snapshots, listing events, bedroom flags, interactions, and collections. Exact read contracts live in [lib/queries.ts](lib/queries.ts) and [lib/market-queries.ts](lib/market-queries.ts); normal editor/funnel writes live in [lib/editor-writes.ts](lib/editor-writes.ts) and [lib/funnel-writes.ts](lib/funnel-writes.ts).

The normal web role needs SELECT on queried relations and narrowly scoped note, judgment, ranking, interaction, and collection writes, sequence USAGE, and row-lock permissions used by those modules. It needs no DDL or DELETE. Browser observations use the separate execute-only role above. `/api/health` reports process liveness; `/api/db-health` checks database connectivity. Missing enrichments render incomplete states.

PITI settings are shared across tracks and stored locally in the browser. Current illustrative defaults: 5% down, 30 years, 7.25% note rate, $1,200/year insurance, and 0.36% annual PMI; HOA is excluded. `PROPERTY_SEARCH_DASHBOARD_PITI_STORAGE_KEY` can preserve an existing same-origin key. Defaults are editable assumptions, not a live loan quote.

Optional `GOOGLE_CLOUD_API_KEY` enables server-side Street View Static API fallback; images are labeled and loaded lazily, without persisting their bytes. Maps use MapLibre and OpenStreetMap tiles, so those features involve external services.

For a host-network reverse proxy, use [compose.host-network.yaml](compose.host-network.yaml) with the base Compose file. Set `WEB_HOSTNAME` to a private interface reachable only by the authenticated proxy and `WEB_PORT` to an available port:

```sh
docker compose -f compose.yaml -f compose.host-network.yaml up -d web
```

</details>

## 📈 Optional market snack

With the market schema applied, supply a separate `MARKET_DATABASE_URL` role with SELECT/INSERT/UPDATE and sequence USAGE on the two market tables, then run:

```sh
docker compose --profile market-ingest run --rm market-ingest
```

For host networking, include the same override as above. Ingestion downloads public Zillow monthly CSVs into market tables; it does not refresh individual listings or plex data, modify property records, run DDL, or schedule itself. Panels show missing/stale data honestly. `MARKET_PREF_*` variables tune the tracked-property preference summary, not citywide inventory. Changing regions requires adapter changes—not just wishing very hard at an environment variable.

## 🧪 Check the nest

```sh
npm test
npm run typecheck
npm run build
docker compose --profile market-ingest config --quiet
```

No database is required for builds or unit tests. Synthetic/mocked checks cover search tracks, ranking, notes, status, photos, finances, and URL state; real database/browser integration still needs its own configured environment.
