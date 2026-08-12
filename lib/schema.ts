import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One row per *distinct camera frame* we managed to fetch.
 *
 * Deliberately named "observations", not "crossings". The camera updates every
 * 5-8 minutes while a train clears the crossing in 45s-3min, so these rows are a
 * sparse sample of crossing activity, never a complete log. See lib/stats.ts for
 * the catch-rate math the UI is required to display.
 */
export const observations = pgTable(
  "observations",
  {
    id: serial("id").primaryKey(),

    /** Authoritative capture time, parsed from the feed's Last-Modified header. */
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .unique(),
    /** When our poller actually retrieved it (>= capturedAt). */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * How far the frame *outside* the ROI diverges from the reference image.
     *
     * This is the PTZ-drift signal. Note we deliberately do NOT read the burned-in
     * "Looking west" banner: that text is generated from the same camera-preset
     * label as the filename, so it keeps saying "west" even if an operator pans
     * the camera elsewhere. Only the scene itself can reveal a moved camera.
     */
    sceneDriftScore: real("scene_drift_score"),

    /** Blob URL. NULL when no train was seen, or when the 3-day window expired. */
    imageUrl: text("image_url"),
    imageSha256: text("image_sha256").notNull(),

    /**
     * Small grayscale ROI crop kept indefinitely as training data. Unlike
     * image_url this is never purged — a local classifier needs both classes,
     * and the night false positives are the most valuable examples in the set.
     */
    trainingCropUrl: text("training_crop_url"),

    /** CV pre-filter score (mean abs diff + edge delta vs reference). */
    cvScore: real("cv_score"),
    /** Did the CV score clear the escalation threshold? */
    cvTriggered: boolean("cv_triggered").notNull().default(false),

    /** Did we actually spend a VLM call on this frame? */
    vlmCalled: boolean("vlm_called").notNull().default(false),
    /** 'threshold' | 'audit' | 'forced' — why the VLM ran. Null if it didn't. */
    vlmReason: text("vlm_reason"),

    trainPresent: boolean("train_present").notNull().default(false),
    /** 'up' | 'down' | 'unknown' */
    gates: text("gates").notNull().default("unknown"),
    confidence: real("confidence"),

    isDaylight: boolean("is_daylight").notNull().default(true),
    /** True when the camera was pointed somewhere other than the west leg. */
    viewDrift: boolean("view_drift").notNull().default(false),

    rawVlm: jsonb("raw_vlm"),
  },
  (t) => [
    index("observations_captured_at_idx").on(t.capturedAt),
    index("observations_train_idx").on(t.trainPresent, t.capturedAt),
    // Supports the retention sweep: find train frames that still hold a blob.
    index("observations_image_url_idx").on(t.imageUrl, t.capturedAt),
  ],
);

/**
 * One row per poll attempt, including the ones that returned 304 Not Modified.
 *
 * This is what makes the *achieved* sampling interval measurable rather than
 * assumed — GitHub Actions cron drifts, and we need to show the real number.
 */
export const pollTicks = pgTable(
  "poll_ticks",
  {
    id: serial("id").primaryKey(),
    polledAt: timestamp("polled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    gotNewFrame: boolean("got_new_frame").notNull().default(false),
  },
  (t) => [index("poll_ticks_polled_at_idx").on(t.polledAt)],
);

/**
 * A run of consecutive observations that all showed a train.
 *
 * Durations are stored as a *bounded range*, never a point estimate: we know the
 * train was there at first_seen_at and at last_seen_at, and nothing about the
 * gaps in between or on either side.
 */
export const blockages = pgTable(
  "blockages",
  {
    id: serial("id").primaryKey(),
    firstObservationId: integer("first_observation_id").notNull(),
    lastObservationId: integer("last_observation_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    observationCount: integer("observation_count").notNull(),
    /** lastSeenAt - firstSeenAt. Zero for a single-frame sighting. */
    minDurationS: integer("min_duration_s").notNull(),
    /** minDuration + 2 * median sampling interval (it could have started just
     *  after the previous frame and ended just before the next). */
    maxDurationS: integer("max_duration_s").notNull(),
  },
  (t) => [index("blockages_first_seen_idx").on(t.firstSeenAt)],
);

/** Tiny KV for poller bookkeeping (last Last-Modified, audit counter). */
export const feedState = pgTable("feed_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Observation = typeof observations.$inferSelect;
export type Blockage = typeof blockages.$inferSelect;
export type PollTick = typeof pollTicks.$inferSelect;
