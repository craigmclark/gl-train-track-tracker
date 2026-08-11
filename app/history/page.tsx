import { countObservations, getRecentObservations } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PAGE_SIZE = 100;

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  const pageNum = Math.max(1, Number(page ?? "1") || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const [rows, total] = await Promise.all([
    getRecentObservations(PAGE_SIZE, offset),
    countObservations(),
  ]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <h2 style={{ marginTop: 24 }}>Observation log</h2>

      <div className="notice">
        Every row is one camera frame — <strong>an observation, not a
        crossing</strong>. A row saying &ldquo;clear&rdquo; means no train was
        visible at that instant, not that no train passed since the previous
        row. Frames where the cheap change-detector saw nothing were never sent
        to the classifier; those are marked <em>skipped</em>.
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Captured (local)</th>
              <th>Verdict</th>
              <th>Gates</th>
              <th>Conf.</th>
              <th>Change score</th>
              <th>Classified</th>
              <th>Light</th>
              <th>Image</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>{fmtDateTime(o.capturedAt)}</td>
                <td className={o.trainPresent ? "train" : "dim"}>
                  {!o.vlmCalled ? "skipped" : o.trainPresent ? "TRAIN" : "clear"}
                  {o.viewDrift && (
                    <span className="dim" title="Scene differs from reference; camera may have moved">
                      {" "}
                      ⚑
                    </span>
                  )}
                </td>
                <td className="dim">{o.gates}</td>
                <td className="dim">
                  {o.confidence === null ? "—" : o.confidence.toFixed(2)}
                </td>
                <td className="dim">
                  {o.cvScore === null ? "—" : o.cvScore.toFixed(1)}
                </td>
                <td className="dim">{o.vlmReason ?? "—"}</td>
                <td className="dim">{o.isDaylight ? "day" : "night"}</td>
                <td>
                  {o.imageUrl ? (
                    <a href={o.imageUrl} target="_blank" rel="noreferrer">
                      view
                    </a>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="dim">
                  No observations recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="note" style={{ marginTop: 16 }}>
        {total.toLocaleString()} observations · page {pageNum} of {lastPage}
        {pageNum > 1 && (
          <>
            {" · "}
            <a href={`/history?page=${pageNum - 1}`}>newer</a>
          </>
        )}
        {pageNum < lastPage && (
          <>
            {" · "}
            <a href={`/history?page=${pageNum + 1}`}>older</a>
          </>
        )}
      </p>

      <p className="note">
        Images are kept for confirmed trains only, for 3 days. Older rows keep
        their verdict but lose the picture, and frames with no train never had
        one stored.
      </p>
    </>
  );
}
