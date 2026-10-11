import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pragmatic source-contract assertions (same spirit as map-css.test.ts):
// the no-Home-flash fix is structural — the saved URL state must be parsed
// on the SERVER (app/page.tsx reads the request's searchParams) and used as
// the initial client state, so the first painted HTML already shows the
// saved tab/view. The pure parsing pipeline itself is covered in
// url-state.test.ts; these tests guard the wiring that makes it run before
// any dashboard content renders.

const appFile = (...parts: string[]) => readFileSync(join(__dirname, "..", "app", ...parts), "utf8");

describe("initial route restoration (no Home flash on refresh)", () => {
  it("page.tsx parses the request's searchParams server-side and passes the initial state down", () => {
    const page = appFile("page.tsx");
    expect(page).toContain("searchParams");
    expect(page).toContain("parseAppUrlState(searchStringFromParams(await searchParams))");
    expect(page).toContain("initialUrlState={initialUrlState}");
  });

  it("DashboardTabs seeds its URL state from the server-parsed initial state, not a hardcoded default", () => {
    const tabs = appFile("components", "DashboardTabs.tsx");
    expect(tabs).toContain("initialUrlState = DEFAULT_APP_URL_STATE");
    expect(tabs).toContain("useState<AppUrlState>(initialUrlState)");
  });

  it("keeps popstate/back-forward handling and per-URL scroll restoration", () => {
    const tabs = appFile("components", "DashboardTabs.tsx");
    expect(tabs).toContain('window.addEventListener("popstate", onPopState)');
    expect(tabs).toContain("queueScrollRestore");
    expect(tabs).toContain("saveScrollPosition");
  });
});
