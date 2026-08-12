/**
 * Apply the confidence gate retroactively and rebuild the blockage table.
 *
 *   npx tsx scripts/backfill-confidence-gate.ts          # dry run, changes nothing
 *   npx tsx scripts/backfill-confidence-gate.ts --apply  # write
 *
 * Background: the first twelve train detections split perfectly by confidence.
 * Six were genuine (0.95, notes naming visible rolling stock) and six were red
 * traffic signals blooming on wet pavement at night (0.60-0.75, notes inferring
 * from lights). TRAIN_CONFIDENCE_MIN now rejects the latter at ingest, but rows
 * written before that gate existed are still marked as trains.
 *
 * This only flips `train_present`. The model's original answer stays in
 * `raw_vlm`, so the correction is auditable and reversible — and those frames
 * remain in the training archive, where they are the most valuable negatives we
 * have.
 */
import { and, asc, eq, lt, sql } from "drizzle-orm";

import { BLOCKAGE_MAX_GAP_MS, TRAIN_CONFIDENCE_MIN } from "../lib/config";
import { blockages, db, getMedianSamplingIntervalS, observations } from "../lib/db";
import { ASSUMED_SAMPLING_INTERVAL_S } from "../lib/config";

async function main() {
  const apply = process.argv.includes("--apply");

  const doomed = await db
    .select()
    .from(observations)
    .where(
      and(
        eq(observations.trainPresent, true),
        lt(observations.confidence, TRAIN_CONFIDENCE_MIN),
      ),
    )
    .orderBy(asc(observations.capturedAt));

  console.log(
    `Confidence gate: ${TRAIN_CONFIDENCE_MIN}\n` +
      `Train rows below it: ${doomed.length}\n`,
  );

  for (const o of doomed) {
    const local = o.capturedAt.toLocaleString("en-US", {
      timeZone: "America/Chicago",
    });
    const notes = (o.rawVlm as { notes?: string } | null)?.notes ?? "";
    console.log(
      `  #${String(o.id).padStart(4)} ${local.padEnd(24)} conf=${o.confidence?.toFixed(2)}  ${notes}`,
    );
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write these changes.");
    return;
  }

  if (doomed.length > 0) {
    await db
      .update(observations)
      .set({ trainPresent: false })
      .where(
        and(
          eq(observations.trainPresent, true),
          lt(observations.confidence, TRAIN_CONFIDENCE_MIN),
        ),
      );
    console.log(`\nDemoted ${doomed.length} observation(s) to clear.`);
  }

  // Blockages are derived, so rebuild rather than patch — that way the table
  // cannot drift from the observations it is supposed to summarise.
  await db.delete(blockages);

  const all = await db
    .select({
      id: observations.id,
      capturedAt: observations.capturedAt,
      trainPresent: observations.trainPresent,
    })
    .from(observations)
    .orderBy(asc(observations.capturedAt));

  const interval =
    (await getMedianSamplingIntervalS()) ?? ASSUMED_SAMPLING_INTERVAL_S;

  type Run = typeof all;
  const runs: Run[] = [];
  let current: Run = [];

  for (const o of all) {
    if (!o.trainPresent) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const prev = current[current.length - 1];
    if (
      prev &&
      o.capturedAt.getTime() - prev.capturedAt.getTime() > BLOCKAGE_MAX_GAP_MS
    ) {
      runs.push(current);
      current = [];
    }
    current.push(o);
  }
  if (current.length) runs.push(current);

  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    const minDurationS = Math.round(
      (last.capturedAt.getTime() - first.capturedAt.getTime()) / 1000,
    );
    await db.insert(blockages).values({
      firstObservationId: first.id,
      lastObservationId: last.id,
      firstSeenAt: first.capturedAt,
      lastSeenAt: last.capturedAt,
      observationCount: run.length,
      minDurationS,
      maxDurationS: Math.round(minDurationS + 2 * interval),
    });
  }

  const [{ n }] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(blockages);
  console.log(`Rebuilt blockages: ${n} run(s) from ${all.length} observations.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
