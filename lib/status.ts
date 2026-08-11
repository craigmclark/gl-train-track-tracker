import { ASSUMED_SAMPLING_INTERVAL_S } from "./config";
import { getLatestObservation, getMedianSamplingIntervalS } from "./db";
import type { Observation } from "./schema";

/** Drives the site-wide colour scheme via `data-status` on <html>. */
export type StatusToken = "train" | "clear" | "skipped" | "nodata";

export type SiteStatus = {
  token: StatusToken;
  label: string;
  latest: Observation | null;
  samplingIntervalS: number;
  stale: boolean;
};

const FALLBACK: SiteStatus = {
  token: "nodata",
  label: "No signal",
  latest: null,
  samplingIntervalS: ASSUMED_SAMPLING_INTERVAL_S,
  stale: true,
};

/**
 * Current crossing status, safe to call from the root layout.
 *
 * Deliberately swallows database errors: this runs on every page render, and a
 * transient Postgres blip should degrade the site to "No signal" rather than
 * throw and take down history and stats along with it.
 */
export async function getSiteStatus(): Promise<SiteStatus> {
  try {
    const [latest, interval] = await Promise.all([
      getLatestObservation(),
      getMedianSamplingIntervalS(),
    ]);

    const samplingIntervalS = interval ?? ASSUMED_SAMPLING_INTERVAL_S;
    if (!latest) return { ...FALLBACK, samplingIntervalS };

    const stale =
      Date.now() - latest.capturedAt.getTime() > 2 * samplingIntervalS * 1000;

    let token: StatusToken;
    let label: string;
    if (latest.trainPresent) {
      token = "train";
      label = "Train on the crossing";
    } else if (!latest.vlmCalled) {
      token = "skipped";
      label = "Probably clear";
    } else {
      token = "clear";
      label = "Crossing clear";
    }

    return { token, label, latest, samplingIntervalS, stale };
  } catch (err) {
    console.error("status lookup failed:", err);
    return FALLBACK;
  }
}
