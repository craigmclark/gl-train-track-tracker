import {
  blockageTier,
  formatDurationRange,
  getOpenBlockage,
  openBlockageMinutes,
} from "@/lib/blockage";
import { ROI_CALIBRATED } from "@/lib/config";
import { getRecentBlockages } from "@/lib/db";
import { fmtAgo, fmtDateTime, fmtInterval, fmtTime } from "@/lib/format";
import { getSiteStatus } from "@/lib/status";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LivePage() {
  const [status, blockages, open] = await Promise.all([
    getSiteStatus(),
    getRecentBlockages(10),
    getOpenBlockage(),
  ]);

  const { latest, samplingIntervalS, stale } = status;

  const elapsed = open ? openBlockageMinutes(open) : null;
  const tier = elapsed ? blockageTier(elapsed.confirmed) : null;

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
            src={`/api/frame?t=${Math.floor(Date.now() / 60000)}`}
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

      <h2>Recent sightings</h2>
      {blockages.length === 0 ? (
        <p className="note">No trains caught on camera yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>First seen</th>
                <th>Last seen</th>
                <th>Frames</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {blockages.map((b) => (
                <tr key={b.id}>
                  <td>{fmtDateTime(b.firstSeenAt)}</td>
                  <td>{fmtDateTime(b.lastSeenAt)}</td>
                  <td className="dim">{b.observationCount}</td>
                  <td>
                    {formatDurationRange(
                      b.minDurationS,
                      b.maxDurationS,
                      b.observationCount,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
