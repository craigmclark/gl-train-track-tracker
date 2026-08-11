import { put } from "@vercel/blob";
import { and, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  BLOCKAGE_FORCE_WINDOW_MS,
  CV_ESCALATE_THRESHOLD,
  DRIFT_THRESHOLD,
  LATEST_BLOB_PATH,
  VLM_AUDIT_EVERY_N,
} from "@/lib/config";
import { recomputeCurrentBlockage } from "@/lib/blockage";
import {
  db,
  getFeedState,
  observations,
  pollTicks,
  setFeedState,
} from "@/lib/db";
import { fetchSnapshot, toHttpDate } from "@/lib/passage";
import { purgeExpiredImages } from "@/lib/retention";
import { analyzeFrame, cropRoiJpeg, loadReference } from "@/lib/roi";
import { isDaylight } from "@/lib/sun";
import { classifyCrop, type VlmReason, type Verdict } from "@/lib/vlm";

// sharp is a native module, so this route cannot run on the edge runtime.
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const LAST_MODIFIED_KEY = "last_modified";
const FRAME_COUNTER_KEY = "frame_counter";
const LATEST_BLOB_URL_KEY = "latest_blob_url";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return await ingest();
  } catch (err) {
    console.error("ingest failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}

async function ingest() {
  const lastModified = await getFeedState(LAST_MODIFIED_KEY);
  const result = await fetchSnapshot(lastModified);

  // The common case: the camera has not produced a new frame yet. Recording the
  // tick is what makes the achieved sampling interval measurable later.
  if (result.status === "not-modified") {
    await db.insert(pollTicks).values({ gotNewFrame: false });
    return NextResponse.json({ status: "not-modified" });
  }

  const { buffer, capturedAt, sha256 } = result;

  // Guard against a feed that stops updating Last-Modified but keeps serving
  // the same bytes — without this the same frame would be logged repeatedly.
  const [duplicate] = await db
    .select({ id: observations.id })
    .from(observations)
    .where(eq(observations.capturedAt, capturedAt))
    .limit(1);

  if (duplicate) {
    await db.insert(pollTicks).values({ gotNewFrame: false });
    await setFeedState(LAST_MODIFIED_KEY, toHttpDate(capturedAt));
    return NextResponse.json({ status: "duplicate-capture-time" });
  }

  await db.insert(pollTicks).values({ gotNewFrame: true });

  // NB: Last-Modified is deliberately NOT stored yet. Storing it here would
  // mean a failure further down (Blob outage, VLM error) still advances the
  // cursor, so the next poll sends If-Modified-Since for a frame we never
  // recorded and gets a 304 — silently burning that frame. It is written only
  // after the observation row lands, which makes a failed ingest retryable.
  const daylight = isDaylight(capturedAt);
  const reference = await loadReference(daylight);

  let cvScore: number | null = null;
  let driftScore: number | null = null;
  let cvTriggered = false;
  let viewDrift = false;

  if (reference) {
    const analysis = await analyzeFrame(buffer, reference);
    cvScore = analysis.score;
    driftScore = analysis.driftScore;
    cvTriggered = analysis.score > CV_ESCALATE_THRESHOLD;
    viewDrift = analysis.driftScore > DRIFT_THRESHOLD;
  } else {
    // No baseline captured yet (pre-calibration). Classify everything rather
    // than silently recording a stream of "no train" rows that were never
    // actually looked at.
    cvTriggered = true;
  }

  const { shouldCall, reason } = await decideVlm(cvTriggered, capturedAt);

  // Note drift does not gate this. It is too weak a signal to separate a moved
  // camera from a busy intersection, and gating on it would silently suppress
  // classification — see DRIFT_THRESHOLD in lib/config.ts.
  let verdict: Verdict | null = null;
  if (shouldCall) {
    try {
      verdict = await classifyCrop(await cropRoiJpeg(buffer));
    } catch (err) {
      console.error("VLM classification failed:", err);
    }
  }

  // Image storage is best-effort. The observation is the data; the picture is
  // supporting evidence, so a Blob outage (or a store that was never created)
  // must not cost us the reading. Failures degrade to imageUrl = null.
  let imageUrl: string | null = null;
  let blobError: string | null = null;

  try {
    // Images are evidence for confirmed crossings only. Everything else is
    // discarded here and never reaches storage.
    if (verdict?.trainPresent) {
      const blob = await put(`trains/${capturedAt.toISOString()}.jpg`, buffer, {
        access: "public",
        contentType: "image/jpeg",
      });
      imageUrl = blob.url;
    }

    // The live view always shows the current frame, train or not.
    //
    // cacheControlMaxAge is essential here and easy to miss: Blob defaults to a
    // one-month TTL, and overwriting a stable pathname does NOT purge the CDN.
    // Without this the edge happily serves a frame from hours ago while the
    // status text next to it reads live — which is exactly what happened.
    const latestBlob = await put(LATEST_BLOB_PATH, buffer, {
      access: "public",
      contentType: "image/jpeg",
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
    });
    // The blob host is only known at runtime, so record it for /api/frame.
    //
    // The ?v= suffix carries the capture time. It is meaningless to Blob, but
    // it gives every frame a distinct CDN cache key, so /api/frame can never be
    // handed an edge copy of a previous frame no matter what TTL is in force.
    await setFeedState(
      LATEST_BLOB_URL_KEY,
      `${latestBlob.url}?v=${capturedAt.getTime()}`,
    );
  } catch (err) {
    blobError = err instanceof Error ? err.message : "unknown blob error";
    console.error("blob storage failed (observation still recorded):", err);
  }

  const [inserted] = await db
    .insert(observations)
    .values({
      capturedAt,
      imageUrl,
      imageSha256: sha256,
      cvScore,
      sceneDriftScore: driftScore,
      cvTriggered,
      vlmCalled: verdict !== null,
      vlmReason: verdict !== null ? reason : null,
      trainPresent: verdict?.trainPresent ?? false,
      gates: verdict?.gates ?? "unknown",
      confidence: verdict?.confidence ?? null,
      isDaylight: daylight,
      viewDrift,
      rawVlm: verdict ?? null,
    })
    .returning({ id: observations.id });

  // Only now advance the cursor. Everything above can fail and be retried
  // against the same frame; past this point the reading is durably recorded.
  await setFeedState(LAST_MODIFIED_KEY, toHttpDate(capturedAt));

  await recomputeCurrentBlockage();
  const purged = await purgeExpiredImages();

  return NextResponse.json({
    status: "new-frame",
    observationId: inserted.id,
    capturedAt: capturedAt.toISOString(),
    cvScore,
    driftScore,
    viewDrift,
    vlmCalled: verdict !== null,
    vlmReason: verdict !== null ? reason : null,
    trainPresent: verdict?.trainPresent ?? false,
    gates: verdict?.gates ?? "unknown",
    confidence: verdict?.confidence ?? null,
    imageStored: imageUrl !== null,
    blobError,
    imagesPurged: purged,
  });
}

/**
 * Decide whether this frame is worth a VLM call.
 *
 * The CV stage is a cost filter, not the source of truth, so there are two
 * escape hatches that fire regardless of its score:
 *
 *  - `audit`: every Nth frame, so the CV stage's false-negative rate is
 *    measurable rather than assumed. /stats reports it.
 *  - `forced`: every frame near a confirmed train, so a blockage's start and
 *    end edges are not lost to a borderline score.
 */
async function decideVlm(
  cvTriggered: boolean,
  capturedAt: Date,
): Promise<{ shouldCall: boolean; reason: VlmReason }> {
  const counter = Number((await getFeedState(FRAME_COUNTER_KEY)) ?? "0") + 1;
  await setFeedState(FRAME_COUNTER_KEY, String(counter));

  if (cvTriggered) return { shouldCall: true, reason: "threshold" };

  const since = new Date(capturedAt.getTime() - BLOCKAGE_FORCE_WINDOW_MS);
  if (await hasRecentTrain(since)) {
    return { shouldCall: true, reason: "forced" };
  }

  if (counter % VLM_AUDIT_EVERY_N === 0) {
    return { shouldCall: true, reason: "audit" };
  }

  return { shouldCall: false, reason: "threshold" };
}

/** Was a train confirmed at any point since `since`? */
async function hasRecentTrain(since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: observations.id })
    .from(observations)
    .where(
      and(
        gte(observations.capturedAt, since),
        eq(observations.trainPresent, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}
