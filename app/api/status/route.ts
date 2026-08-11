import { NextResponse } from "next/server";

import { formatDurationRange } from "@/lib/blockage";
import {
  getBlockedShare,
  getLatestObservation,
  getMedianSamplingIntervalS,
  getRecentBlockages,
} from "@/lib/db";
import { ASSUMED_SAMPLING_INTERVAL_S, ROI_CALIBRATED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [latest, blockages, interval, share] = await Promise.all([
    getLatestObservation(),
    getRecentBlockages(5),
    getMedianSamplingIntervalS(),
    getBlockedShare(),
  ]);

  const samplingIntervalS = interval ?? ASSUMED_SAMPLING_INTERVAL_S;

  return NextResponse.json({
    // "As of" matters more than "now" here: the newest frame can be several
    // minutes old, and a UI that implies otherwise is lying to the reader.
    asOf: latest?.capturedAt ?? null,
    stale: latest
      ? Date.now() - latest.capturedAt.getTime() > 2 * samplingIntervalS * 1000
      : true,
    trainPresent: latest?.trainPresent ?? null,
    gates: latest?.gates ?? "unknown",
    confidence: latest?.confidence ?? null,
    viewDrift: latest?.viewDrift ?? false,
    calibrated: ROI_CALIBRATED,
    samplingIntervalS,
    blockedSampleShare:
      share.total > 0 ? share.blocked / share.total : null,
    totalObservations: share.total,
    recentBlockages: blockages.map((b) => ({
      firstSeenAt: b.firstSeenAt,
      lastSeenAt: b.lastSeenAt,
      observationCount: b.observationCount,
      duration: formatDurationRange(
        b.minDurationS,
        b.maxDurationS,
        b.observationCount,
      ),
    })),
    disclaimer:
      "Observations are samples taken every 5-8 minutes. Most trains clear the crossing between frames and are never captured. This is not a complete record of crossing activity.",
  });
}
