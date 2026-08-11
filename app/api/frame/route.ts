import { NextResponse } from "next/server";

import { getFeedState } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Redirect to the most recently stored frame.
 *
 * The Blob host is only known at runtime, so the ingest route records the URL
 * and this indirection keeps a stable, cacheable path in the page markup.
 */
export async function GET() {
  const url = await getFeedState("latest_blob_url");
  if (!url) {
    return NextResponse.json({ error: "no frame stored yet" }, { status: 404 });
  }
  return NextResponse.redirect(url, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
