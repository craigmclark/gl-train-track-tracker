import { createHash } from "node:crypto";

import { CAMERA_URL } from "./config";

export type FetchResult =
  | { status: "not-modified" }
  | {
      status: "new-frame";
      buffer: Buffer;
      capturedAt: Date;
      sha256: string;
      bytes: number;
    };

/**
 * Conditionally fetch the current PASSAGE snapshot.
 *
 * The feed serves Last-Modified and honours If-Modified-Since, so the common case
 * (the camera hasn't produced a new frame yet) costs a 304 with no body. That
 * matters: the source only updates every 5-8 minutes, so most polls are 304s and
 * we should not be re-downloading ~50 KB each time.
 *
 * Note `Cache-Control: max-age=30` and the mirror's `refreshRate=30000` are both
 * misleading — measured Last-Modified deltas are 5-8 minutes. Never infer capture
 * time from wall clock; always use Last-Modified.
 */
export async function fetchSnapshot(
  lastModified: string | null,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    // Identify ourselves honestly to a public agency feed.
    "User-Agent": "gltrains-crossing-monitor/0.1 (+https://github.com)",
    Accept: "image/jpeg,image/*",
  };
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const res = await fetch(CAMERA_URL, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 304) return { status: "not-modified" };

  if (!res.ok) {
    throw new Error(`PASSAGE feed returned HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new Error("PASSAGE feed returned an empty body");
  }
  // Guard against an error page served with a 200.
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) {
    throw new Error("PASSAGE feed returned a non-JPEG payload");
  }

  const header = res.headers.get("last-modified");
  const capturedAt = header ? new Date(header) : new Date();

  return {
    status: "new-frame",
    buffer,
    capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  };
}

/** The raw Last-Modified string to persist for the next conditional request. */
export function toHttpDate(d: Date): string {
  return d.toUTCString();
}
