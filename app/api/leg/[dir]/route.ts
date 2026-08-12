import { NextResponse } from "next/server";

import { CAMERA_LEGS, legSnapshotUrl, type CameraLeg } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy one approach of the intersection camera for the Live Look grid.
 *
 * Proxied rather than hotlinked for two reasons. It keeps a public agency's
 * server out of every visitor's page load, and it lets us set the cache policy:
 * with s-maxage the CDN collapses all traffic into at most one upstream fetch
 * per leg per window, no matter how many people are looking.
 *
 * Only the west leg is stored and classified — the other three are live-only
 * views, never recorded, so nothing here touches the database.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ dir: string }> },
) {
  const { dir } = await params;

  // Whitelist lookup — the path segment never reaches URL construction.
  if (!Object.prototype.hasOwnProperty.call(CAMERA_LEGS, dir)) {
    return NextResponse.json({ error: "unknown leg" }, { status: 404 });
  }

  const upstream = await fetch(legSnapshotUrl(dir as CameraLeg), {
    headers: {
      "User-Agent": "gltrains-crossing-monitor/0.1 (+https://github.com)",
      Accept: "image/jpeg,image/*",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `upstream returned ${upstream.status}` },
      { status: 502 },
    );
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": "image/jpeg",
      // The source only refreshes every ~7 min, so a two-minute window is well
      // inside "live" while cutting upstream requests by an order of magnitude.
      "Cache-Control": "public, max-age=120, s-maxage=120, stale-while-revalidate=300",
    },
  });
}
