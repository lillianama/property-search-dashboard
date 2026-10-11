export function DbUnavailableBanner() {
  return (
    <div className="banner banner-warning" role="alert">
      <strong>Database unavailable.</strong> The dashboard could not reach Postgres, so every view below is empty
      rather than showing stale or partial numbers. Check that the <code>postgres</code> service is healthy and
      <code>DATABASE_URL</code> is set, then reload.
    </div>
  );
}

export function EmptyDatasetBanner() {
  return (
    <div className="banner banner-info" role="status">
      <strong>No tracked properties match the current filters.</strong> Try widening the price, bedroom, year, or date
      range filters, or reset them.
    </div>
  );
}

export function CoverageNote({ note }: { note: string }) {
  return (
    <div className="banner banner-muted">
      <strong>Coverage note.</strong> {note}
    </div>
  );
}

export function LoadErrorBanner({ message }: { message: string }) {
  return (
    <div className="banner banner-warning" role="alert">
      <strong>Could not load dashboard data.</strong> {message}
    </div>
  );
}

export function EmptyRejectedBanner() {
  return (
    <div className="banner banner-info" role="status">
      <strong>No rejected properties yet.</strong> Properties only land here after an explicit rejection decision. Nothing
      has been rejected in the property store so far.
    </div>
  );
}
