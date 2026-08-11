import { blockageTier, formatDurationRange } from "@/lib/blockage";
import { ASSUMED_SAMPLING_INTERVAL_S } from "@/lib/config";
import {
  getBlockedShare,
  getCvAuditReport,
  getHourWeekdayHeatmap,
  getLongestBlockages,
  getMedianSamplingIntervalS,
  getPollStats,
} from "@/lib/db";
import { fmtDateTime, fmtInterval } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Rough gate-down durations on this line, in seconds. */
const METRA_GATE_DOWN_S = 45;
const FREIGHT_GATE_DOWN_S = 150;

export default async function StatsPage() {
  const [interval, share, heat, audit, polls, longest] = await Promise.all([
    getMedianSamplingIntervalS(),
    getBlockedShare(),
    getHourWeekdayHeatmap(),
    getCvAuditReport(),
    getPollStats(24),
    getLongestBlockages(10),
  ]);

  const samplingS = interval ?? ASSUMED_SAMPLING_INTERVAL_S;

  // A train is only captured if a frame lands while it is on the crossing, so
  // the catch rate is just its occupancy time over the sampling interval.
  const catchMetra = Math.min(1, METRA_GATE_DOWN_S / samplingS);
  const catchFreight = Math.min(1, FREIGHT_GATE_DOWN_S / samplingS);

  const grid = new Map<string, { samples: number; blocked: number }>();
  for (const r of heat) {
    grid.set(`${r.dow}-${r.hour}`, { samples: r.samples, blocked: r.blocked });
  }
  const maxRate = Math.max(
    0.0001,
    ...heat.filter((r) => r.samples >= 3).map((r) => r.blocked / r.samples),
  );

  return (
    <>
      <h2 style={{ marginTop: 24 }}>What this data can and cannot tell you</h2>
      <div className="notice warn">
        The camera updates about every {fmtInterval(samplingS)} (measured, not
        assumed). A Metra North Central train occupies this crossing for roughly{" "}
        {METRA_GATE_DOWN_S}s and a CN freight for around{" "}
        {Math.round(FREIGHT_GATE_DOWN_S / 60)} minutes, so an individual train is
        captured only about{" "}
        <strong>{Math.round(catchMetra * 100)}%</strong> (passenger) to{" "}
        <strong>{Math.round(catchFreight * 100)}%</strong> (freight) of the time.{" "}
        <strong>
          Most trains are never captured. This is a sample of crossing activity,
          not a complete record.
        </strong>{" "}
        Train length and per-crossing duration cannot be measured at this frame
        rate, and are deliberately not reported anywhere on this site.
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="value">{fmtInterval(samplingS)}</div>
          <div className="label">Median gap between frames</div>
        </div>
        <div className="metric">
          <div className="value">
            {share.total > 0
              ? `${((share.blocked / share.total) * 100).toFixed(1)}%`
              : "—"}
          </div>
          <div className="label">Samples showing a train</div>
        </div>
        <div className="metric">
          <div className="value">{share.total.toLocaleString()}</div>
          <div className="label">Total observations</div>
        </div>
        <div className="metric">
          <div className="value">
            {polls.polls > 0 ? `${polls.newFrames}/${polls.polls}` : "—"}
          </div>
          <div className="label">New frames / polls (24h)</div>
        </div>
      </div>

      <h2>When the crossing is busiest</h2>
      <p className="note">
        Share of <em>samples</em> showing a train, by local hour and weekday.
        Darker means more often blocked. Cells with fewer than three samples are
        left blank rather than shown as noise.
      </p>
      <div className="table-scroll">
        <table className="heatmap">
          <thead>
            <tr>
              <th className="row-label" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, dow) => (
              <tr key={day}>
                <th className="row-label">{day}</th>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = grid.get(`${dow}-${hour}`);
                  const enough = cell && cell.samples >= 3;
                  const rate = enough ? cell.blocked / cell.samples : 0;
                  const alpha = enough ? 0.12 + 0.88 * (rate / maxRate) : 0;
                  return (
                    <td key={hour}>
                      <div
                        className="cell"
                        title={
                          cell
                            ? `${day} ${hour}:00 — ${cell.blocked}/${cell.samples} samples blocked`
                            : `${day} ${hour}:00 — no samples`
                        }
                        style={
                          enough
                            ? {
                                background: `color-mix(in srgb, var(--accent) ${(
                                  alpha * 100
                                ).toFixed(0)}%, var(--panel))`,
                              }
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Longest blockages recorded</h2>
      <p className="note">
        These are the events this camera <em>can</em> measure well. A normal
        train is gone between frames, but a stopped or slow-moving one spans
        several, so its length is directly observed rather than inferred. Each
        figure is still a range: the low number is the span actually witnessed,
        the high number adds one sampling interval at each end for the time
        before the first frame and after the last.
      </p>
      {longest.length === 0 ? (
        <p className="note">No blockages recorded yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Duration</th>
                <th>Frames</th>
                <th>Severity</th>
              </tr>
            </thead>
            <tbody>
              {longest.map((b) => {
                const mins = Math.round(b.minDurationS / 60);
                const { label } = blockageTier(mins);
                return (
                  <tr key={b.id}>
                    <td>{fmtDateTime(b.firstSeenAt)}</td>
                    <td className={mins >= 20 ? "train" : undefined}>
                      {formatDurationRange(
                        b.minDurationS,
                        b.maxDurationS,
                        b.observationCount,
                      )}
                    </td>
                    <td className="dim">{b.observationCount}</td>
                    <td className="dim">{label ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Detector health</h2>
      <p className="note">
        Most frames are filtered by a cheap change-detector before reaching the
        vision model. To check that filter is not swallowing real trains, every
        20th frame is classified regardless of its score. If the filter were
        well behaved, the miss count below would be zero.
      </p>
      <div className="metrics">
        <div className="metric">
          <div className="value">{audit.auditFrames.toLocaleString()}</div>
          <div className="label">Audit frames classified</div>
        </div>
        <div className="metric">
          <div
            className="value"
            style={{ color: audit.missedTrains > 0 ? "var(--signal)" : undefined }}
          >
            {audit.missedTrains}
          </div>
          <div className="label">Trains the filter would have missed</div>
        </div>
      </div>
      {audit.missedTrains > 0 && (
        <div className="notice warn" style={{ marginTop: 14 }}>
          The change-detector has missed {audit.missedTrains} confirmed train
          {audit.missedTrains === 1 ? "" : "s"}. Lower{" "}
          <code>CV_ESCALATE_THRESHOLD</code> in <code>lib/config.ts</code> — and
          treat the historical blocked-sample share as an undercount until it
          reads zero again.
        </div>
      )}
    </>
  );
}
