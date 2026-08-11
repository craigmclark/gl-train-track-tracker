import { desc, eq } from "drizzle-orm";

import {
  ASSUMED_SAMPLING_INTERVAL_S,
  BLOCKAGE_MAX_GAP_MS,
} from "./config";
import {
  blockages,
  db,
  getLatestObservation,
  getMedianSamplingIntervalS,
  observations,
} from "./db";
import type { Blockage } from "./schema";

/**
 * Rebuild the blockage row covering the most recent observation.
 *
 * Called after every insert. Walks backwards from the newest frame through
 * consecutive train-present observations to find where the current run started,
 * then upserts a single row keyed on that run's first observation — so a run
 * that grows by one frame updates in place rather than creating duplicates.
 *
 * Bounded to the last 200 observations: a blockage spanning more than ~20 hours
 * of frames is not a train, it is a broken camera.
 */
export async function recomputeCurrentBlockage(): Promise<void> {
  const recent = await db
    .select({
      id: observations.id,
      capturedAt: observations.capturedAt,
      trainPresent: observations.trainPresent,
      viewDrift: observations.viewDrift,
    })
    .from(observations)
    .orderBy(desc(observations.capturedAt))
    .limit(200);

  if (recent.length === 0) return;

  const newest = recent[0];
  // The newest frame is clear, so no run is currently open. Any previous run was
  // already finalised on the insert that closed it.
  if (!newest.trainPresent) return;

  // Walk backwards while frames stay train-present and consecutive.
  const run = [newest];
  for (let i = 1; i < recent.length; i++) {
    const candidate = recent[i];
    const next = run[run.length - 1];

    if (!candidate.trainPresent) break;

    const gap = next.capturedAt.getTime() - candidate.capturedAt.getTime();
    if (gap > BLOCKAGE_MAX_GAP_MS) break;

    run.push(candidate);
  }

  const first = run[run.length - 1];
  const last = run[0];

  const minDurationS = Math.round(
    (last.capturedAt.getTime() - first.capturedAt.getTime()) / 1000,
  );

  // We know the train was there at first and last sighting. It could have
  // arrived any time after the preceding frame and left any time before the
  // following one, so the upper bound adds one sampling interval at each end.
  const interval =
    (await getMedianSamplingIntervalS()) ?? ASSUMED_SAMPLING_INTERVAL_S;
  const maxDurationS = Math.round(minDurationS + 2 * interval);

  const [existing] = await db
    .select()
    .from(blockages)
    .where(eq(blockages.firstObservationId, first.id))
    .limit(1);

  const row = {
    firstObservationId: first.id,
    lastObservationId: last.id,
    firstSeenAt: first.capturedAt,
    lastSeenAt: last.capturedAt,
    observationCount: run.length,
    minDurationS,
    maxDurationS,
  };

  if (existing) {
    await db.update(blockages).set(row).where(eq(blockages.id, existing.id));
  } else {
    await db.insert(blockages).values(row);
  }
}

/**
 * The blockage still in progress, if any.
 *
 * "In progress" means the most recent frame showed a train and that frame is
 * the tail of a blockage run. There is no way to know the train is *still*
 * there right now — only that it was at the last frame — which is why the
 * caller must render this as a lower bound, never a live stopwatch.
 */
export async function getOpenBlockage(): Promise<Blockage | null> {
  const latest = await getLatestObservation();
  if (!latest?.trainPresent) return null;

  const [open] = await db
    .select()
    .from(blockages)
    .where(eq(blockages.lastObservationId, latest.id))
    .limit(1);

  return open ?? null;
}

export type BlockageTier = "brief" | "notable" | "long" | "extended";

/**
 * Severity banding for how long the crossing has been shut.
 *
 * Thresholds are about driver impact, not railroading: under 10 minutes is a
 * normal train, 10-20 means something is moving slowly or stopped, and past 30
 * you should genuinely go around.
 */
export function blockageTier(minutes: number): {
  tier: BlockageTier;
  label: string | null;
} {
  if (minutes >= 30) return { tier: "extended", label: "Extended blockage" };
  if (minutes >= 20) return { tier: "long", label: "Long blockage" };
  if (minutes >= 10) return { tier: "notable", label: "Slow or stopped" };
  return { tier: "brief", label: null };
}

/**
 * Bounds on how long an in-progress blockage has lasted, in minutes.
 *
 * `confirmed` is the span we actually witnessed (first frame to last frame).
 * `possible` extends that to now, because the train may well still be sitting
 * there — but we have not seen a frame since, so it is a ceiling, not a fact.
 */
export function openBlockageMinutes(b: Blockage): {
  confirmed: number;
  possible: number;
} {
  return {
    confirmed: Math.round(
      (b.lastSeenAt.getTime() - b.firstSeenAt.getTime()) / 60000,
    ),
    possible: Math.round((Date.now() - b.firstSeenAt.getTime()) / 60000),
  };
}

/**
 * Format a blockage duration for display.
 *
 * Always a range, never a point estimate — a single-frame sighting genuinely
 * tells us nothing about how long the train was there, and rendering "0 min"
 * would be a lie of precision. See the honest-logging rules in the README.
 */
export function formatDurationRange(
  minDurationS: number,
  maxDurationS: number,
  observationCount: number,
): string {
  if (observationCount <= 1) {
    return "duration unknown (seen in a single frame)";
  }
  const lo = Math.round(minDurationS / 60);
  const hi = Math.round(maxDurationS / 60);
  return `blocked for ${lo}–${hi} min`;
}
