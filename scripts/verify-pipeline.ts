/**
 * Exercise the fetch + CV path against the live feed, with no database, no
 * Blob store, and no API key required.
 *
 *   npx tsx scripts/verify-pipeline.ts
 *
 * It checks the three things that are easy to get quietly wrong: that
 * conditional requests actually return 304, that the sun model agrees with
 * reality, and that the ROI differencing separates a train (big change inside
 * the box, scene otherwise stable) from a repositioned camera (everything
 * changes at once).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  CV_ESCALATE_THRESHOLD,
  DRIFT_THRESHOLD,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  ROI,
} from "../lib/config";
import { fetchSnapshot, toHttpDate } from "../lib/passage";
import { analyzeFrame, cropRoiJpeg } from "../lib/roi";
import { isDaylight, solarAltitudeDeg } from "../lib/sun";

const OUT_DIR = path.join(process.cwd(), "calibration-output");

async function main() {
  console.log("=== 1. conditional GET ===");
  const first = await fetchSnapshot(null);
  if (first.status !== "new-frame") throw new Error("expected a frame");
  console.log(`  200 -> ${first.bytes} bytes`);
  console.log(`  Last-Modified -> ${first.capturedAt.toISOString()}`);

  const meta = await sharp(first.buffer).metadata();
  console.log(`  decoded ${meta.width}x${meta.height} ${meta.format}`);
  if (meta.width !== FRAME_WIDTH || meta.height !== FRAME_HEIGHT) {
    console.warn(
      `  WARNING: config expects ${FRAME_WIDTH}x${FRAME_HEIGHT} — update lib/config.ts`,
    );
  }

  const second = await fetchSnapshot(toHttpDate(first.capturedAt));
  console.log(`  If-Modified-Since -> ${second.status}`);
  if (second.status !== "not-modified") {
    console.log("  (the feed produced a new frame between calls — acceptable)");
  }

  console.log("\n=== 2. sun model ===");
  const cases: [string, string][] = [
    ["2026-08-11T02:00:00Z", "9:00 PM CDT Aug 10, after sunset"],
    ["2026-08-11T18:00:00Z", "1:00 PM CDT Aug 11, midday"],
    ["2026-08-11T12:30:00Z", "7:30 AM CDT, well after sunrise"],
    ["2026-12-21T18:00:00Z", "12:00 PM CST, winter solstice"],
    ["2026-12-22T04:00:00Z", "10:00 PM CST, deep night"],
  ];
  for (const [iso, label] of cases) {
    const d = new Date(iso);
    const alt = solarAltitudeDeg(d);
    console.log(
      `  ${label.padEnd(36)} alt=${alt.toFixed(1).padStart(6)}deg  ${
        isDaylight(d) ? "DAY" : "NIGHT"
      }`,
    );
  }

  console.log("\n=== 3. ROI crop ===");
  const crop = await cropRoiJpeg(first.buffer);
  const cropMeta = await sharp(crop).metadata();
  console.log(`  ${cropMeta.width}x${cropMeta.height}, ${crop.length} bytes`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "verify-crop.jpg"), crop);

  console.log("\n=== 4. CV differencing ===");

  const self = await analyzeFrame(first.buffer, first.buffer);
  report("frame vs itself", self);

  // A dark bar across the ROI stands in for a wall of railcars on the road.
  const bar = Buffer.from(
    `<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}">
       <rect x="${ROI.left}" y="${ROI.top + 10}" width="${ROI.width}" height="${ROI.height - 20}" fill="#232323"/>
       <rect x="${ROI.left}" y="${ROI.top + 34}" width="${ROI.width}" height="7" fill="#8a8a8a"/>
     </svg>`,
  );
  const fakeTrain = await sharp(first.buffer)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .composite([{ input: bar, top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
  await writeFile(path.join(OUT_DIR, "verify-synthetic-train.jpg"), fakeTrain);
  const train = await analyzeFrame(fakeTrain, first.buffer);
  report("synthetic train", train);

  // Cropping and rescaling the frame stands in for an operator panning the PTZ.
  const moved = await sharp(first.buffer)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .extract({
      left: 120,
      top: 60,
      width: FRAME_WIDTH - 120,
      height: FRAME_HEIGHT - 60,
    })
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .jpeg()
    .toBuffer();
  const drift = await analyzeFrame(moved, first.buffer);
  report("simulated PTZ move", drift);

  console.log(
    `\n  thresholds: escalate > ${CV_ESCALATE_THRESHOLD}, drift > ${DRIFT_THRESHOLD}`,
  );

  // The escalation checks are the load-bearing ones — that threshold decides
  // whether a frame reaches the classifier at all. The drift checks are weaker
  // on purpose: drift is advisory metadata (see DRIFT_THRESHOLD in config), so
  // what matters is that a moved camera scores distinctly higher than a train
  // does, not that it clears one particular number.
  const checks: [string, boolean][] = [
    ["identical frame does NOT escalate", !(self.score > CV_ESCALATE_THRESHOLD)],
    ["identical frame has no drift", self.driftScore === 0],
    ["synthetic train escalates", train.score > CV_ESCALATE_THRESHOLD],
    [
      "train does not look like a camera move",
      train.driftScore < drift.driftScore,
    ],
    [
      "camera move scores >3x a train's drift",
      drift.driftScore > 3 * Math.max(train.driftScore, 0.5),
    ],
  ];

  console.log();
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  if (failed > 0) {
    console.log(
      `\n${failed} check(s) failed. Tune CV_ESCALATE_THRESHOLD / DRIFT_THRESHOLD in lib/config.ts.`,
    );
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

function report(
  label: string,
  a: { score: number; roiScore: number; driftScore: number; edgeDelta: number },
) {
  console.log(
    `  ${label.padEnd(20)} score=${a.score.toFixed(2).padStart(7)}` +
      `  roi=${a.roiScore.toFixed(2).padStart(6)}` +
      `  drift=${a.driftScore.toFixed(2).padStart(6)}` +
      `  edge=${a.edgeDelta.toFixed(2).padStart(6)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
