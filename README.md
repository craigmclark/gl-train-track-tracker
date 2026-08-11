# GL TRAIN TRACK TRACKER

Samples the Lake County PASSAGE traffic camera at IL 83 & IL 120 in Grayslake,
Illinois and records when a train is occupying the Canadian National grade
crossing about 100 ft west of the intersection.

The whole site recolours from the current crossing status — bone and rail green
when clear, full signal red when a train is on the crossing, amber when the
frame was not classified, and lights-out black when there is no signal. That is
driven by `data-status` on `<html>`, set once in `app/layout.tsx` from
`lib/status.ts`, so the history and stats pages carry the same signal as the
front page.

## Read this before you build anything on it

The camera refreshes roughly **every 5–8 minutes**. That number was measured,
not assumed:

| Feed | Result |
| --- | --- |
| WeatherBug / TrafficLand mirror | 60 samples over 318s → 1 new frame (at t+226s) |
| Direct PASSAGE feed | 40 samples over 463s → 1 new frame; `Last-Modified` 02:01:25 → 02:09:25 GMT = exactly 8 min |

The `refreshRate=30000` parameter in the WeatherBug URL and the feed's
`Cache-Control: max-age=30` are both misleading. There is no MJPEG or HLS
stream behind it — every `/stream`, `/live`, `/hls`, `/mjpeg`, and `.m3u8`
variant returns 404. It is stills only.

A CN freight clears this crossing in 1–3 minutes and a Metra North Central
Service train in about 45 seconds. At one frame per 5–8 minutes:

- **Train length cannot be measured.** One frame per train means there is no
  second measurement to derive length or speed from.
- **Per-crossing duration cannot be measured** for normal trains — the error
  bar is wider than the event.
- **Most trains are never captured at all** (roughly 12% of passenger trains and
  38% of freights produce even one frame).

So this project does not report train length, and it never reports a crossing
duration as a single number. What it does do:

- Live blocked / clear status
- Detection and **bounded** timing of long or stopped blockages — the ones that
  actually cost you time
- Time-of-day statistics expressed as *share of samples blocked*

### Honest-logging rules

These are enforced in the UI and should stay that way:

- Rows are **observations**, never "crossings".
- Blockage durations render as a range (`blocked for 8–21 min`), never a point
  estimate. A single-frame sighting reads `duration unknown`.
- `/stats` states the measured sampling interval, the derived catch rate, and
  that most trains are never captured.
- Frequency is `% of samples blocked`, never trains/day.

## The data source

```bash
curl -o west.jpg "https://www.lakecountypassage.com/snapshots/IL_83_@_IL_120_cctv_West_Leg.jpg"
```

720×480 JPEG, no token required, serves `Last-Modified` so the poller can use
conditional requests. All four approaches exist (`West/North/East/South_Leg.jpg`).
Prefer this over the WeatherBug mirror, which is a rescaled 704×469 and needs a
publisher token.

Geometry, from OpenStreetMap: the IL 83 / IL 120 junction is at
(42.336613, −88.031857) and the level-crossing nodes are at (42.33661, −88.03221)
and (42.33661, −88.03228) — **95–114 ft due west** on IL 120 (East Belvidere
Road), with essentially zero north–south offset. The camera looks west, so the
crossing sits straight ahead. The line is the **CN Waukesha Subdivision**, a
60 mph freight main that also carries Metra's North Central Service.

## Setup

### 1. Install and configure

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Neon or Supabase Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store |
| `ANTHROPIC_API_KEY` | Anthropic console |
| `CRON_SECRET` | `openssl rand -hex 32` |

### 2. Create the schema

```bash
npm run db:push
```

### 3. Build the reference images

**The ROI is already calibrated.** It was set against a 7:35 AM daylight frame
and confirmed to contain the track bed, the near-side gate mast, the crossbuck,
and the vertical space a railcar occupies. To re-check it after any camera
change:

```bash
npm run calibrate      # writes calibration-output/overlay.png
```

What still needs doing is the **baseline images** the CV stage differences
against. A single frame is a poor baseline — this is a busy signalised
intersection and there is nearly always a vehicle somewhere in the ROI, which
would be baked into the baseline permanently. Instead, take a per-pixel median
over many frames: traffic moves between frames, the road and rails do not, so
the median converges on the empty scene.

```bash
npm run build-reference        # 6 frames, ~30-50 min
npm run build-reference 10     # cleaner, proportionally slower
```

Run it once in daylight and once after dark; it picks `reference/day.jpg` or
`reference/night.jpg` from the sun angle. It is slow only because the camera is.

A shipped `reference/day.jpg` is included as a starting point, but it is a
single frame and **should be replaced** by a median before you trust the
change-scores. If a reference file is missing entirely, the poller safely
classifies every frame instead of filtering.

Sanity-check the whole fetch and differencing path any time:

```bash
npm run verify-pipeline
```

### 4. Deploy and schedule

Deploy to Vercel, then add two **repository secrets** in GitHub:

- `INGEST_URL` — `https://<your-app>.vercel.app/api/ingest`
- `CRON_SECRET` — the same value as in Vercel's environment variables

`.github/workflows/poll.yml` fires every 5 minutes. Vercel's own cron is not
used: on Hobby it only runs **once per day, ±1 hour**, which cannot poll a feed
that updates every 5–8 minutes.

## How detection works

```
GitHub Actions (5 min)
  └─> POST /api/ingest
        ├─ conditional GET (If-Modified-Since)  ──304──> record poll tick, stop
        ├─ CV pre-filter: ROI diff vs day/night reference
        ├─ VLM confirm (Claude vision) on the ROI crop
        ├─ store JPEG only if a train was confirmed
        └─ derive blockage, purge images older than 3 days
```

The CV stage is a **cost filter, not the source of truth**. Two escape hatches
fire regardless of its score:

- **audit** — every 20th frame is classified anyway, so the filter's
  false-negative rate is measured rather than assumed. `/stats` reports it, and
  it should read zero.
- **forced** — every frame within 30 minutes of a confirmed train, so a
  blockage's start and end edges are never lost to a borderline score.

The model is set to `claude-haiku-4-5` in `lib/vlm.ts`. At ~200–300 frames a day
this costs cents; switch `VLM_MODEL` to `claude-opus-5` if the audit counter
shows Haiku struggling on night frames.

Thresholds are measured, not guessed (daylight frames, 2026-08-11):

| Case | Change score | Outcome |
| --- | --- | --- |
| Frame vs itself | 0.00 | filtered |
| Two real no-train frames, busy traffic | 3.76 | filtered |
| **Escalation threshold** | **6.00** | |
| Railcar wall across the ROI | 37.90 | classified |

Ordinary traffic scores low because `analyzeFrame` subtracts the scene-wide
change — cars move through the whole frame and largely cancel, while a train
changes the ROI and nothing else.

### PTZ drift is advisory

PASSAGE cameras are operator-movable, so it is worth knowing when the view has
shifted. Two things are worth recording about how that is detected.

First, the burned-in `Looking west` banner is **not** a usable signal. It is
generated from the same camera-preset label as the filename, so it keeps saying
"west" even if someone pans the camera elsewhere. Only the scene can reveal a
moved camera.

Second, the scene-based signal is weak. A simulated pan scores 16.3 against the
frame it came from, and ~22.7 once traffic differences are layered in — but two
consecutive no-train frames already score 11.9 on traffic alone. No threshold in
that range reliably separates "camera moved" from "busy intersection".

So drift is **recorded and surfaced, never gated on**. An earlier design skipped
classification when drift tripped; that was removed because it buys nothing and
risks the worst failure mode available — silently suppressing detection so the
site goes quiet while looking healthy. Frames are classified regardless; the
vision model is told what the scene should contain and instructed to answer
`unknown` with low confidence when it cannot tell, which is the right response
to a moved view. The flag just tells a human where to look.

### Retention

- Confirmed-train JPEGs: kept **3 days**, then purged at the end of an ingest run.
- `latest.jpg`: overwritten every new frame, for the live view.
- Every other frame: never uploaded at all.
- Observation and blockage **rows are kept indefinitely** — a few hundred bytes a
  day, and they are what the history and stats pages are built from.

Because no-train frames are never stored, a CV false negative can be *counted*
(the VLM verdict lands in `raw_vlm`) but its pixels cannot be re-examined later.
Threshold retuning works from `cv_score` distributions plus the audit counter.

## Operational notes

- **GitHub Actions cron drift.** 5 minutes is the floor, and free-tier scheduled
  runs are routinely delayed 5–20 minutes under load. `poll_ticks` measures the
  achieved interval; if it degrades, point `INGEST_URL` at cron-job.org or
  Upstash QStash instead — no code change needed.
- Scheduled workflows are **auto-disabled after 60 days of repo inactivity**.
- Private-repo Actions minutes (2000/mo) are tight at 288 runs/day — use a public
  repo or a longer interval.
- The feed is a public government resource. Conditional GETs every 5 minutes are
  modest, but confirm Lake County DOT's terms before making the site public.

## Verification

```bash
npm run typecheck && npm run build && npm run verify-pipeline
```

`verify-pipeline` needs no credentials. It hits the live feed and checks that
conditional requests return 304, that the sun model matches reality at five
known instants, and that the ROI differencing separates a synthetic railcar wall
from a simulated camera pan.

Then, with credentials configured:

1. `npm run calibrate` at midday → confirm the ROI overlay still frames the
   crossing.
2. `curl -X POST localhost:3000/api/ingest -H "x-cron-secret: $CRON_SECRET"`
   twice in a row → the first inserts an observation, the second returns
   `not-modified` and writes only a poll tick.
3. Backdate a train observation four days, run an ingest → the blob is gone and
   `image_url` is NULL, but the row survives. Confirm a no-train frame never
   created a blob at all.
4. `gh workflow run poll.yml` → a row lands in Postgres and an image in Blob.
5. After ~48h, `/stats` should show a 5–8 minute median interval and an audit
   miss count of zero. A non-zero miss count means `CV_ESCALATE_THRESHOLD` is
   too high and the historical blocked-sample share is an undercount.

## Disclaimer

Unofficial project, not affiliated with Lake County DOT, Canadian National, or
Metra. Never use it to decide whether it is safe to cross railroad tracks.
