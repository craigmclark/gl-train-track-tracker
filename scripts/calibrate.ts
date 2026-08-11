/**
 * Step 0: confirm the ROI actually contains the crossing, in daylight.
 *
 *   npx tsx scripts/calibrate.ts                  # fetch a frame + ROI overlay
 *   npx tsx scripts/calibrate.ts --save-reference # also store it as the baseline
 *
 * Nothing downstream is trustworthy until a human has looked at the overlay this
 * writes and confirmed the gate arms and track bed sit inside the box. The
 * default ROI in lib/config.ts was derived from map geometry, not from looking
 * at a picture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  CAMERA_URL,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  ROI,
  ROI_CALIBRATED,
} from "../lib/config";
import { fetchSnapshot } from "../lib/passage";
import { cropRoiJpeg } from "../lib/roi";
import { isDaylight, solarAltitudeDeg } from "../lib/sun";

const OUT_DIR = path.join(process.cwd(), "calibration-output");

async function main() {
  const saveReference = process.argv.includes("--save-reference");

  console.log(`Fetching ${CAMERA_URL}`);
  const result = await fetchSnapshot(null);
  if (result.status !== "new-frame") {
    throw new Error("expected a fresh frame; got 304 with no cached state");
  }

  const { buffer, capturedAt, bytes } = result;
  const altitude = solarAltitudeDeg(capturedAt);
  const daylight = isDaylight(capturedAt);

  const meta = await sharp(buffer).metadata();

  console.log(`\nCaptured at : ${capturedAt.toISOString()}`);
  console.log(`Frame size  : ${meta.width}x${meta.height} (${bytes} bytes)`);
  console.log(`Sun altitude: ${altitude.toFixed(1)}deg -> ${daylight ? "DAY" : "NIGHT"}`);
  console.log(
    `ROI         : left=${ROI.left} top=${ROI.top} w=${ROI.width} h=${ROI.height}` +
      (ROI_CALIBRATED ? "" : "   << UNCALIBRATED"),
  );

  if (meta.width !== FRAME_WIDTH || meta.height !== FRAME_HEIGHT) {
    console.warn(
      `\nWARNING: frame is ${meta.width}x${meta.height}, config expects ` +
        `${FRAME_WIDTH}x${FRAME_HEIGHT}. ROI coordinates are interpreted ` +
        `against the config size, so update lib/config.ts if the feed changed.`,
    );
  }

  await mkdir(OUT_DIR, { recursive: true });

  // Full frame with the ROI drawn on top, so the box can be judged in context.
  const overlay = Buffer.from(
    `<svg width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}">
       <rect x="${ROI.left}" y="${ROI.top}" width="${ROI.width}" height="${ROI.height}"
             fill="none" stroke="#ff2d55" stroke-width="3"/>
       <text x="${ROI.left + 6}" y="${Math.max(16, ROI.top - 8)}"
             font-family="monospace" font-size="16" fill="#ff2d55">ROI</text>
     </svg>`,
  );

  await sharp(buffer)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toFile(path.join(OUT_DIR, "overlay.png"));

  // The exact crop the model will be asked to judge — check it is legible.
  await writeFile(path.join(OUT_DIR, "roi-crop.jpg"), await cropRoiJpeg(buffer));
  await writeFile(path.join(OUT_DIR, "frame.jpg"), buffer);

  console.log(`\nWrote ${OUT_DIR}/overlay.png    <- open this one`);
  console.log(`Wrote ${OUT_DIR}/roi-crop.jpg   <- what the model sees`);
  console.log(`Wrote ${OUT_DIR}/frame.jpg`);

  if (saveReference) {
    const refDir = path.join(process.cwd(), "reference");
    await mkdir(refDir, { recursive: true });
    const name = daylight ? "day.jpg" : "night.jpg";
    await writeFile(path.join(refDir, name), buffer);
    console.log(`\nSaved reference/${name}`);
    console.log(
      "Only keep this if the crossing is clear and the gates are up — the " +
        "whole CV stage is differenced against it.",
    );
  } else {
    console.log(
      "\nRe-run with --save-reference once you have a clear, train-free frame.",
    );
  }

  if (!ROI_CALIBRATED) {
    console.log(
      "\nNext: adjust ROI in lib/config.ts until the box tightly contains the\n" +
        "gate arms and track bed, then set ROI_CALIBRATED = true.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
