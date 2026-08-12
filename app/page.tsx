import {
  blockageTier,
  formatDurationRange,
  getOpenBlockage,
  openBlockageMinutes,
} from "@/lib/blockage";
import { ROI_CALIBRATED } from "@/lib/config";
import { getRecentBlockagesWithImages } from "@/lib/db";
import { fmtAgo, fmtDateTime, fmtInterval, fmtTime } from "@/lib/format";
import { getSiteStatus } from "@/lib/status";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Grid order puts the crossing view first, then reads clockwise. The other
 * three legs are context — they show whether traffic is backed up on the
 * approaches, which is often the first visible sign of a blockage.
 */
const LIVE_LEGS = [
  { dir: "west", label: "Looking west", note: "The crossing" },
  { dir: "north", label: "Looking north", note: null },
  { dir: "east", label: "Looking east", note: null },
  { dir: "south", label: "Looking south", note: null },
] as const;

export default async function LivePage() {
  const [status, blockages, open] = await Promise.all([
    getSiteStatus(),
    getRecentBlockagesWithImages(10),
    getOpenBlockage(),
  ]);

  const { latest, samplingIntervalS, stale } = status;

  const elapsed = open ? openBlockageMinutes(open) : null;
  const tier = elapsed ? blockageTier(elapsed.confirmed) : null;

  // Matches the 2-minute cache on /api/leg, so the grid refreshes on the same
  // cadence the proxy is willing to serve rather than hammering it per render.
  const legBust = Math.floor(Date.now() / 120_000);

  return (
    <>
      {!ROI_CALIBRATED && (
        <div className="notice warn">
          <strong>NOT CALIBRATED.</strong> The detection region has not been
          checked against a daylight image. Run <code>npm run calibrate</code>,
          confirm the overlay, then set <code>ROI_CALIBRATED</code> in{" "}
          <code>lib/config.ts</code>. Treat every verdict below as unverified.
        </div>
      )}

      <div className="status-card">
        <h1 className="verdict">{status.label}</h1>

        {latest ? (
          <p className="asof">
            As of {fmtDateTime(latest.capturedAt)} · {fmtAgo(latest.capturedAt)}
          </p>
        ) : (
          <p className="asof">Waiting for the first frame</p>
        )}

        {/* Elapsed time is a lower bound, never a stopwatch. We know the train
            was there at the first and last frame; we have not seen anything
            since, so "at least" is the only honest verb available. */}
        {open && elapsed && tier && (
          <div className={`elapsed tier-${tier.tier}`}>
            <span className="elapsed-value">
              Blocked at least {elapsed.confirmed} min
            </span>
            {tier.label && <span className="elapsed-tag">{tier.label}</span>}
            <span className="elapsed-detail">
              First seen {fmtTime(open.firstSeenAt)}, still blocked at{" "}
              {fmtTime(open.lastSeenAt)} across {open.observationCount} frames.
              {elapsed.possible > elapsed.confirmed && (
                <> If it never left, it is up to {elapsed.possible} min by now.</>
              )}
            </span>
          </div>
        )}

        {latest && !latest.vlmCalled && (
          <p className="note">
            This frame looked unchanged from the empty-crossing baseline, so it
            was not sent to the classifier.
          </p>
        )}

        {latest?.viewDrift && (
          <p className="note">
            The scene differs noticeably from the reference image, so the camera
            may have been repositioned. The verdict still stands on its own
            merits — this is a flag to check the view, not a reason to discard it.
          </p>
        )}

        {stale && latest && (
          <p className="note">
            No new frame in a while. That is usually the poller rather than the
            camera — check <a href="/stats">poll health</a>.
          </p>
        )}

        {/* Only render once a frame exists — /api/frame 404s before the first
            successful ingest, and a broken-image box is a worse empty state
            than no image at all. Cache-busted per minute so the browser does
            not pin the first image it ever saw at this stable path. */}
        {latest ? (
          <img
            className="frame"
            // Keyed to the frame's own capture time rather than the clock, so
            // the URL changes exactly when there is genuinely a new image and
            // never in between.
            src={`/api/frame?t=${latest.capturedAt.getTime()}`}
            alt="Most recent camera frame, looking west along IL 120"
          />
        ) : (
          <p className="note">
            The camera image appears here once the poller stores its first
            frame.
          </p>
        )}
      </div>

      <div className="notice">
        The camera refreshes roughly every {fmtInterval(samplingIntervalS)},
        while a train clears this crossing in about 45 seconds to 3 minutes.{" "}
        <strong>Most trains pass entirely between frames and never appear
        here.</strong>{" "}
        Read this as what the camera happened to catch, not as a complete record.
      </div>

      <h2 id="livelook">Live look</h2>
      <p className="note" style={{ marginTop: 0, marginBottom: 14 }}>
        All four approaches, straight from the camera. Only the west leg — the
        one facing the crossing — is recorded and classified; the other three
        are views, not data.
      </p>
      <div className="livelook">
        {LIVE_LEGS.map((leg) => (
          <a
            className="livelook-cell"
            href={`#leg-${leg.dir}`}
            key={leg.dir}
            aria-label={`Enlarge the ${leg.label} view`}
          >
            <img
              src={`/api/leg/${leg.dir}?t=${legBust}`}
              alt={`IL 83 at IL 120, ${leg.label}`}
              loading="lazy"
            />
            <span className="livelook-label">
              {leg.label}
              {leg.note && <em>{leg.note}</em>}
            </span>
          </a>
        ))}
      </div>

      {LIVE_LEGS.map((leg) => (
        <div className="lightbox" id={`leg-${leg.dir}`} key={`lb-${leg.dir}`}>
          <a
            className="lightbox-backdrop"
            href="#livelook"
            aria-label="Close enlarged image"
          />
          <div className="lightbox-inner">
            <img
              src={`/api/leg/${leg.dir}?t=${legBust}`}
              alt={`IL 83 at IL 120, ${leg.label}`}
            />
            <div className="lightbox-bar">
              <span>
                IL 83 @ IL 120 · {leg.label}
                {leg.note ? ` · ${leg.note}` : ""}
              </span>
              <a href="#livelook" className="lightbox-close">
                Close ✕
              </a>
            </div>
          </div>
        </div>
      ))}

      <h2 id="sightings-heading">Recent sightings</h2>
      {blockages.length === 0 ? (
        <p className="note">No trains caught on camera yet.</p>
      ) : (
        <div className="sightings" id="sightings">
          {blockages.map((b) => (
            <div className="sighting" key={b.id}>
              {b.imageUrl ? (
                <a
                  className="sighting-thumb-link"
                  href={`#shot-${b.id}`}
                  aria-label={`Enlarge the frame from ${fmtDateTime(b.firstSeenAt)}`}
                >
                  <img
                    className="sighting-thumb"
                    src={b.imageUrl}
                    alt={`Train on the crossing at ${fmtDateTime(b.firstSeenAt)}`}
                    loading="lazy"
                  />
                  <span className="sighting-zoom">Enlarge</span>
                </a>
              ) : (
                <div className="sighting-thumb empty">
                  Image expired
                  <br />
                  (kept 3 days)
                </div>
              )}
              <div className="sighting-body">
                <span className="sighting-duration">
                  {formatDurationRange(
                    b.minDurationS,
                    b.maxDurationS,
                    b.observationCount,
                  )}
                </span>
                <span className="sighting-meta">
                  {fmtDateTime(b.firstSeenAt)} → {fmtTime(b.lastSeenAt)}
                </span>
                <span className="sighting-meta">
                  Seen in {b.observationCount}{" "}
                  {b.observationCount === 1 ? "frame" : "frames"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightboxes live outside the cards and are driven by :target, so this
          stays a server component with no client JavaScript. Closing links back
          to #sightings rather than a bare "#" so the page does not jump to the
          top when the overlay is dismissed. */}
      {blockages
        .filter((b) => b.imageUrl)
        .map((b) => (
          <div className="lightbox" id={`shot-${b.id}`} key={`lb-${b.id}`}>
            <a
              className="lightbox-backdrop"
              href="#sightings"
              aria-label="Close enlarged image"
            />
            <div className="lightbox-inner">
              <img
                src={b.imageUrl!}
                alt={`Train on the crossing at ${fmtDateTime(b.firstSeenAt)}`}
              />
              <div className="lightbox-bar">
                <span>
                  {fmtDateTime(b.firstSeenAt)} ·{" "}
                  {formatDurationRange(
                    b.minDurationS,
                    b.maxDurationS,
                    b.observationCount,
                  )}
                </span>
                <a href="#sightings" className="lightbox-close">
                  Close ✕
                </a>
              </div>
            </div>
          </div>
        ))}
    </>
  );
}
