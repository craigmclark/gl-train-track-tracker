import { NextResponse } from "next/server";

import { getSiteStatus, type StatusToken } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Crossbuck favicon, coloured by current crossing status.
 *
 * Drawn as SVG rather than served as a static file so the tab icon carries the
 * same signal as the page: red when a train is on the crossing, green when it
 * is clear. Browsers cache favicons hard, so layout.tsx appends the status
 * token to the URL — the icon only refetches when the status actually changes.
 */
const PALETTE: Record<StatusToken, { bg: string; fg: string }> = {
  train: { bg: "#d8291c", fg: "#f4ede0" },
  clear: { bg: "#17694a", fg: "#f4ede0" },
  skipped: { bg: "#f5a623", fg: "#14110f" },
  nodata: { bg: "#14110f", fg: "#8b8377" },
};

export async function GET() {
  const { token } = await getSiteStatus();
  const { bg, fg } = PALETTE[token] ?? PALETTE.nodata;

  // Heavier bars than the header mark: at 16px a thin X turns to mush.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="5" fill="${bg}"/>
  <g fill="${fg}">
    <rect x="13" y="-4" width="6" height="40" transform="rotate(45 16 16)"/>
    <rect x="13" y="-4" width="6" height="40" transform="rotate(-45 16 16)"/>
  </g>
</svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      // Short, and the URL changes on status change anyway.
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}
