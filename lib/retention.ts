import { del } from "@vercel/blob";
import { and, eq, isNotNull, lt } from "drizzle-orm";

import { IMAGE_RETENTION_DAYS } from "./config";
import { db, observations } from "./db";

/**
 * Delete stored JPEGs older than the retention window.
 *
 * Only train-present observations ever get a blob in the first place (see the
 * ingest route), so this sweep is small: at a few sightings a day it touches a
 * handful of rows. It runs at the end of every ingest rather than on its own
 * schedule, so it cannot silently stop while ingestion keeps running.
 *
 * The observation row itself is kept forever — it is a few hundred bytes and it
 * is what the history and stats pages are built from. Only the image goes.
 */
export async function purgeExpiredImages(): Promise<number> {
  const cutoff = new Date(
    Date.now() - IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const expired = await db
    .select({ id: observations.id, imageUrl: observations.imageUrl })
    .from(observations)
    .where(
      and(isNotNull(observations.imageUrl), lt(observations.capturedAt, cutoff)),
    )
    .limit(200);

  let purged = 0;

  for (const row of expired) {
    if (!row.imageUrl) continue;

    try {
      await del(row.imageUrl);
    } catch (err) {
      // A blob that is already gone is the desired end state, so fall through
      // and clear the column anyway — otherwise one failed delete would be
      // retried on every ingest forever.
      console.warn(`blob delete failed for observation ${row.id}:`, err);
    }

    await db
      .update(observations)
      .set({ imageUrl: null })
      .where(eq(observations.id, row.id));
    purged++;
  }

  return purged;
}
