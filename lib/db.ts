import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import * as schema from "./schema";
import { blockages, feedState, observations, pollTicks } from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

const sqlClient = neon(process.env.DATABASE_URL);
export const db = drizzle(sqlClient, { schema });

export { observations, pollTicks, blockages, feedState };

/* -------------------------------------------------------------------------- */
/* feed_state helpers                                                          */
/* -------------------------------------------------------------------------- */

export async function getFeedState(key: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(feedState)
    .where(eq(feedState.key, key))
    .limit(1);
  return row?.value ?? null;
}

export async function setFeedState(key: string, value: string): Promise<void> {
  await db
    .insert(feedState)
    .values({ key, value })
    .onConflictDoUpdate({
      target: feedState.key,
      set: { value, updatedAt: new Date() },
    });
}

/* -------------------------------------------------------------------------- */
/* Reads used by the UI                                                        */
/* -------------------------------------------------------------------------- */

export async function getLatestObservation() {
  const [row] = await db
    .select()
    .from(observations)
    .orderBy(desc(observations.capturedAt))
    .limit(1);
  return row ?? null;
}

export async function getRecentObservations(limit = 50, offset = 0) {
  return db
    .select()
    .from(observations)
    .orderBy(desc(observations.capturedAt))
    .limit(limit)
    .offset(offset);
}

export async function getRecentBlockages(limit = 25) {
  return db
    .select()
    .from(blockages)
    .orderBy(desc(blockages.firstSeenAt))
    .limit(limit);
}

/**
 * Recent blockages, each with a stored frame from somewhere inside the run.
 *
 * The image lives on the observation, not the blockage, so this picks the first
 * observation in the run that still has one. Most will be null: images are only
 * kept for confirmed trains, and only for three days.
 */
export async function getRecentBlockagesWithImages(limit = 10) {
  const rows = await sqlClient`
    SELECT
      b.id,
      b.first_seen_at,
      b.last_seen_at,
      b.observation_count,
      b.min_duration_s,
      b.max_duration_s,
      (
        SELECT o.image_url
        FROM observations o
        WHERE o.id BETWEEN b.first_observation_id AND b.last_observation_id
          AND o.image_url IS NOT NULL
        ORDER BY o.captured_at
        LIMIT 1
      ) AS image_url
    FROM blockages b
    ORDER BY b.first_seen_at DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: Number(r.id),
    firstSeenAt: new Date(r.first_seen_at as string),
    lastSeenAt: new Date(r.last_seen_at as string),
    observationCount: Number(r.observation_count),
    minDurationS: Number(r.min_duration_s),
    maxDurationS: Number(r.max_duration_s),
    imageUrl: (r.image_url as string | null) ?? null,
  }));
}

/** Worst blockages on record, longest confirmed span first. */
export async function getLongestBlockages(limit = 10) {
  return db
    .select()
    .from(blockages)
    .orderBy(desc(blockages.minDurationS))
    .limit(limit);
}

export async function countObservations(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(observations);
  return Number(row?.n ?? 0);
}

/**
 * Median gap between consecutive distinct frames, in seconds.
 *
 * This is the *achieved* sampling interval — it folds in both the camera's own
 * 5-8 min cadence and any GitHub Actions cron drift, which is exactly the number
 * the honesty disclaimers need.
 */
export async function getMedianSamplingIntervalS(): Promise<number | null> {
  const rows = await sqlClient`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) AS median_gap
    FROM (
      SELECT EXTRACT(EPOCH FROM (
        captured_at - LAG(captured_at) OVER (ORDER BY captured_at)
      )) AS gap
      FROM observations
    ) g
    WHERE gap IS NOT NULL AND gap > 0 AND gap < 3600
  `;
  const median = rows[0]?.median_gap;
  return median == null ? null : Number(median);
}

/** Fraction of all observations that showed a train. */
export async function getBlockedShare(): Promise<{
  total: number;
  blocked: number;
}> {
  const [row] = await db
    .select({
      total: count(),
      blocked: sql<number>`COUNT(*) FILTER (WHERE ${observations.trainPresent})`,
    })
    .from(observations);
  return {
    total: Number(row?.total ?? 0),
    blocked: Number(row?.blocked ?? 0),
  };
}

/** Blocked-sample share bucketed by local hour and weekday, for the heatmap. */
export async function getHourWeekdayHeatmap() {
  const rows = await sqlClient`
    SELECT
      EXTRACT(DOW  FROM captured_at AT TIME ZONE 'America/Chicago')::int AS dow,
      EXTRACT(HOUR FROM captured_at AT TIME ZONE 'America/Chicago')::int AS hour,
      COUNT(*)::int AS samples,
      COUNT(*) FILTER (WHERE train_present)::int AS blocked
    FROM observations
    WHERE NOT view_drift
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
  return rows as { dow: number; hour: number; samples: number; blocked: number }[];
}

/**
 * The CV pre-filter's report card.
 *
 * Of the frames we sent to the VLM purely as an audit (CV said "nothing changed"),
 * how many turned out to have a train? That count is the false-negative rate of the
 * cheap stage. It should be ~0; if it isn't, CV_ESCALATE_THRESHOLD is too high.
 */
export async function getCvAuditReport() {
  const [row] = await db
    .select({
      auditFrames: count(),
      missedTrains: sql<number>`COUNT(*) FILTER (WHERE ${observations.trainPresent})`,
    })
    .from(observations)
    .where(
      and(eq(observations.vlmReason, "audit"), eq(observations.cvTriggered, false)),
    );
  return {
    auditFrames: Number(row?.auditFrames ?? 0),
    missedTrains: Number(row?.missedTrains ?? 0),
  };
}

/** Poll health: how many checks ran and how many yielded a new frame. */
export async function getPollStats(sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000);
  const [row] = await db
    .select({
      polls: count(),
      newFrames: sql<number>`COUNT(*) FILTER (WHERE ${pollTicks.gotNewFrame})`,
    })
    .from(pollTicks)
    .where(gte(pollTicks.polledAt, since));
  return {
    polls: Number(row?.polls ?? 0),
    newFrames: Number(row?.newFrames ?? 0),
  };
}
