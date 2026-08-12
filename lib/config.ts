/** Static configuration for the Grayslake IL 83 / IL 120 crossing monitor. */

const SNAPSHOT_BASE = "https://www.lakecountypassage.com/snapshots";

/**
 * The four approaches this PTZ camera writes, each to its own file.
 *
 * Keys are the only values accepted from a URL path — the lookup is a
 * whitelist, not string interpolation, so a request cannot be steered at an
 * arbitrary host.
 */
export const CAMERA_LEGS = {
  west: "West_Leg",
  north: "North_Leg",
  east: "East_Leg",
  south: "South_Leg",
} as const;

export type CameraLeg = keyof typeof CAMERA_LEGS;

export function legSnapshotUrl(leg: CameraLeg): string {
  return `${SNAPSHOT_BASE}/IL_83_@_IL_120_cctv_${CAMERA_LEGS[leg]}.jpg`;
}

/**
 * The leg the whole detection pipeline runs on: looking west, down IL 120,
 * with the grade crossing ~100 ft ahead.
 *
 * Use this rather than the WeatherBug/TrafficLand mirror
 * (ie.trafficland.com/v2.0/441577/huge?...&pubtoken=...): the PASSAGE original is
 * 720x480 where the mirror is a rescaled 704x469, it needs no publisher token,
 * and it serves Last-Modified so we can poll conditionally.
 */
export const CAMERA_URL = legSnapshotUrl("west");

/** Native frame size of the direct PASSAGE feed. */
export const FRAME_WIDTH = 720;
export const FRAME_HEIGHT = 480;

/** The crossing itself, for the sun-angle day/night decision. */
export const CROSSING_LAT = 42.33661;
export const CROSSING_LON = -88.03225;
export const LOCAL_TIMEZONE = "America/Chicago";

/**
 * Region of interest: the roadway where it crosses the CN Waukesha Sub tracks,
 * ~95-114 ft west of the intersection.
 *
 * Calibrated against a 7:35 AM daylight frame on 2026-08-11. The box spans
 * x 130-470, y 45-130 and contains, left to right: the near-side gate mast and
 * warning sign, the full width of the track bed where it crosses the roadway,
 * the vertical space a railcar body occupies above the rails, and the far-side
 * crossbuck and flasher mast.
 *
 * Two deliberate edge calls: the westbound traffic signal at x~145 sits just
 * inside the left edge, and the eastbound one at x~460 grazes the right edge.
 * Both are kept because trimming them would cut the gate mast and the crossbuck
 * respectively — the VLM prompt calls out the distinction instead.
 */
export const ROI = {
  left: 130,
  top: 45,
  width: 340,
  height: 85,
} as const;

/** Set to true once a human has eyeballed the calibration overlay in daylight. */
export const ROI_CALIBRATED = true;

/**
 * CV pre-filter escalation threshold.
 *
 * Measured on real frames from this camera (2026-08-11, daylight):
 *
 *   frame vs itself ............................  0.00
 *   two real no-train frames (busy traffic) ....  3.76   <- must NOT escalate
 *   threshold ..................................  6.00
 *   railcar wall across the ROI ................ 37.90   <- must escalate
 *
 * Ordinary road traffic scores low because `analyzeFrame` subtracts the
 * scene-wide change: cars move through the whole frame, so they lift the ROI and
 * the background together and mostly cancel. A train changes the ROI and nothing
 * else, which is exactly the signal this threshold is placed to catch.
 *
 * Bias stays toward escalating — the CV stage is a cost filter, not the source
 * of truth, and a wasted VLM call costs a fraction of a cent while a dropped
 * train is unrecoverable. Retune only from the audit counter on /stats.
 */
export const CV_ESCALATE_THRESHOLD = 6.0;

/**
 * Force a VLM call on every Nth new frame regardless of CV score, so we can
 * measure how often the CV stage would have wrongly filtered a train out.
 */
export const VLM_AUDIT_EVERY_N = 20;

/**
 * Once a train is confirmed, classify every frame in this window with the VLM
 * regardless of CV score, so blockage start/end edges aren't lost to filtering.
 */
export const BLOCKAGE_FORCE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Scene-difference score (outside the ROI) above which the PTZ camera has
 * probably been repositioned.
 *
 * ADVISORY ONLY — this flag is recorded and surfaced, it does not gate anything.
 *
 * That is a deliberate retreat from the original design, which skipped
 * classification on drift. Measurement killed it: a simulated pan scores 16.3
 * against the frame it came from and ~22.7 once ordinary traffic differences are
 * layered on, while two consecutive no-train frames already score 11.9 on
 * traffic alone. There is no threshold in that range that reliably separates
 * "camera moved" from "busy intersection".
 *
 * Gating on a signal that weak buys nothing and risks the worst failure mode
 * available — silently suppressing classification, so the site goes quiet and
 * looks healthy. Classifying anyway is safe because the vision model is told
 * what the scene should contain and instructed to answer "unknown" with low
 * confidence when it cannot tell, which is the correct response to a view that
 * has moved. The flag then tells a human where to look.
 */
export const DRIFT_THRESHOLD = 20.0;

/** Consecutive train observations within this gap belong to the same blockage. */
export const BLOCKAGE_MAX_GAP_MS = 15 * 60 * 1000;

/**
 * Minimum model confidence before a frame is recorded as a train.
 *
 * Derived from the first 12 positives, where the separation was total:
 *
 *   6 real trains ......... confidence 0.95, notes naming visible rolling stock
 *                           ("dark tanker cars", "locomotive and railcars")
 *   6 false positives ..... confidence 0.60-0.75, notes inferring from lights
 *                           ("red lights suggest", "indicating train passage")
 *
 * Every false positive was a red traffic signal blooming across wet pavement at
 * night. The model hedged and lowered its own confidence each time, so a gate at
 * 0.85 removes all six while leaving a 0.10 margin under every true positive.
 *
 * This is a safety net, not the fix — the prompt in lib/vlm.ts is. The raw model
 * answer is always preserved in observations.raw_vlm, so tightening or loosening
 * this never destroys information.
 */
export const TRAIN_CONFIDENCE_MIN = 0.85;

/** Keep JPEGs for confirmed-train observations this long, then purge. */
export const IMAGE_RETENTION_DAYS = 3;

/**
 * Small grayscale ROI crop kept for every classified frame, forever, as a
 * training set for a local model later.
 *
 * The evidence images above are deliberately short-lived, but a classifier needs
 * both classes retained — and the night false positives are the most valuable
 * examples of all, since they are exactly the hard negatives that a naive model
 * would get wrong. At this size a frame costs ~4 KB, so a year of collection is
 * a few hundred megabytes.
 */
export const TRAINING_CROP = { width: 240, height: 60 } as const;

/** Fallback sampling interval before we have enough poll data to measure one. */
export const ASSUMED_SAMPLING_INTERVAL_S = 390; // ~6.5 min, midpoint of measured 5-8

/** Blob path for the always-current frame powering the live view. */
export const LATEST_BLOB_PATH = "latest.jpg";
