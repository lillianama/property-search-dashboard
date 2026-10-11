import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Property Search Dashboard",
  description: "Track houses and plexes with independent research views.",
};

/** Decorative four-point star. Inline SVG so no image assets are shipped. */
function DashboardGlyph() {
  return (
    <svg className="brand-glyph" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 1.5c.9 4.9 4.6 8.6 9.5 9.5-4.9.9-8.6 4.6-9.5 9.5-.9-4.9-4.6-8.6-9.5-9.5 4.9-.9 8.6-4.6 9.5-9.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="brand-bar">
          <p className="brand-mark">
            <DashboardGlyph />
            <span className="brand-name">Dashboard</span>
            <span className="brand-divider" aria-hidden="true">
              {"\u00b7"}
            </span>
            <span className="brand-context">Real Estate</span>
          </p>
          <p className="brand-tag">a research dashboard for houses and plexes</p>
        </header>
        {children}
        <footer className="brand-footer">
          <p>
            Property Search Dashboard
          </p>
        </footer>
      </body>
    </html>
  );
}
