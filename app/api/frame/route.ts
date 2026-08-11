import { NextResponse } from "next/server";

import { getFeedState } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve the most recently stored frame.
 *
 * This proxies the bytes rather than redirecting to the Blob URL. Redirecting
 * looks cheaper, but it hands the browser a stable, long-lived Blob URL whose
 * caching we do not control — and because every frame overwrites the same
 * pathname, a cached copy silently pins the image to whatever was current when
 * it was first fetched. Proxying keeps the cache policy here, where it can
 * match the camera's actual 5-8 minute cadence.
 */
export async function GET() {
  const url = await getFeedState("latest_blob_url");
  if (!url) {
    return NextResponse.json({ error: "no frame stored yet" }, { status: 404 });
  }

  // no-store on the upstream fetch: the blob is written to a fixed pathname, so
  // without this the function itself can be handed a stale edge copy.
  const upstream = await fetch(url, { cache: "no-store" });
  if (!upstream.ok) {
    return NextResponse.json(
      { error: `blob fetch failed: ${upstream.status}` },
      { status: 502 },
    );
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": "image/jpeg",
      // Comfortably shorter than the camera's refresh, so a viewer never sees a
      // frame older than the timestamp rendered beside it.
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}
