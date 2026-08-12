import type { Metadata } from "next";
import { Archivo_Black, Space_Mono } from "next/font/google";

import { getSiteStatus } from "@/lib/status";

import "./globals.css";

const display = Archivo_Black({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * The favicon URL carries the status token so the tab icon recolours with the
 * page. Without the query change, browsers would cache the first icon forever.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { token } = await getSiteStatus();
  return {
    title: "GL TRAIN TRACK TRACKER",
    description:
      "Sampled observations of the CN Waukesha Sub grade crossing on IL 120 in Grayslake, Illinois.",
    icons: {
      icon: [{ url: `/api/favicon?s=${token}`, type: "image/svg+xml" }],
    },
  };
}

/** The crossbuck, drawn rather than fetched. */
function Crossbuck() {
  return (
    <svg className="crossbuck" viewBox="0 0 48 48" aria-hidden="true">
      <rect
        x="20"
        y="-8"
        width="9"
        height="64"
        transform="rotate(45 24 24)"
        fill="currentColor"
      />
      <rect
        x="20"
        y="-8"
        width="9"
        height="64"
        transform="rotate(-45 24 24)"
        fill="currentColor"
      />
    </svg>
  );
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The whole site recolours from this. Fetched here, not per-page, so history
  // and stats carry the same signal as the front page.
  const status = await getSiteStatus();

  return (
    <html
      lang="en"
      data-status={status.token}
      className={`${display.variable} ${mono.variable}`}
    >
      <body>
        <div className="gatearm" aria-hidden="true" />

        <header className="site-header">
          <div className="wrap header-inner">
            <a href="/" className="brand">
              <Crossbuck />
              <span className="brand-text">
                <span className="brand-line">GL TRAIN</span>
                <span className="brand-line">TRACK TRACKER</span>
              </span>
            </a>
            <nav>
              <a href="/">LIVE</a>
              <a href="/history">LOG</a>
              <a href="/stats">STATS</a>
            </nav>
          </div>
        </header>

        <main className="wrap">{children}</main>

        {/* The gate arm closes the content, then the colophon sits below it —
            the stripe is the divider, so the footer needs no rule of its own. */}
        <div className="gatearm" aria-hidden="true" />

        <footer className="wrap site-footer">
          <p>
            <strong>IL 83 @ IL 120 · GRAYSLAKE, IL · CN WAUKESHA SUB</strong>
          </p>
          <p>
            Images courtesy of Lake County PASSAGE. Unofficial project, not
            affiliated with Lake County DOT, Canadian National, or Metra. Never
            rely on it to decide whether it is safe to cross railroad tracks.
          </p>
        </footer>
      </body>
    </html>
  );
}
