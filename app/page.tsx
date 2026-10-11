import { parseAppUrlState, searchStringFromParams, type ServerSearchParams } from "../lib/url-state";
import { DashboardTabs } from "./components/DashboardTabs";

/**
 * Reading searchParams makes this route render per-request, so the saved
 * URL state (tab, map/list view, filters, open editor) is restored ON THE
 * SERVER and the very first paint already shows the saved view — refreshing
 * on any non-Home view never flashes Home first.
 */
export default async function Home({ searchParams }: { searchParams: Promise<ServerSearchParams> }) {
  const initialUrlState = parseAppUrlState(searchStringFromParams(await searchParams));
  const pitiStorageKey = process.env.REAL_ESTATE_DASHBOARD_PITI_STORAGE_KEY?.trim() || undefined;
  return <DashboardTabs initialUrlState={initialUrlState} pitiStorageKey={pitiStorageKey} />;
}
