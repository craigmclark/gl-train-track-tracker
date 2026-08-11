/**
 * Build a traffic-free baseline image by taking the per-pixel median of many
 * frames.
 *
 *   npx tsx scripts/build-reference.ts            # 6 frames (~30-50 min)
 *   npx tsx scripts/build-reference.ts 10         # more frames, cleaner result
 *
 * Why not just save one frame: this is a busy signalised intersection, and the
 * ROI almost always has a car, a truck, or a queue somewhere in it. Baking that
 * traffic into the baseline means the CV stage is forever differencing against
 * one arbitrary afternoon's cars. Vehicles move between frames while the road,
 * rails, gates, and crossbuck do not, so the median across enough frames is the
 * empty scene — no frame has to be traffic-free by luck.
 *
 * Run it once in daylight and once after dark; it picks the filename from the
 * sun angle. Collection is slow only because the camera itself is: at one new
 * frame every 5-8 minutes, six frames is roughly 30-50 minutes of waiting.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { FRAME_HEIGHT, FRAME_WIDTH } from "../lib/config";
import { fetchSnapshot, toHttpDate } from "../lib/passage";
import { isDaylight } from "../lib/sun";

const POLL_INTERVAL_MS = 30_000;
const CHANNELS = 3;

async function main() {
  const target = Math.max(3, Number(process.argv[2] ?? "6") || 6);
  console.log(`Collecting ${target} distinct frames (polling every 30s)...\n`);

  const frames: Buffer[] = [];
  const timestamps: Date[] = [];
  let lastModified: string | null = null;
  const deadline = Date.now() + 3 * 60 * 60 * 1000;

  while (frames.length < target) {
    if (Date.now() > deadline) {
      throw new Error(
        `gave up after 3 hours with ${frames.length}/${target} frames`,
      );
    }

    const result = await fetchSnapshot(lastModified);

    if (result.status === "new-frame") {
      lastModified = toHttpDate(result.capturedAt);
      // Normalise now so every frame contributes the same pixel grid, even if
      // the feed ever changes resolution mid-collection.
      const raw = await sharp(result.buffer)
        .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer();
      frames.push(raw);
      timestamps.push(result.capturedAt);
      console.log(
        `  [${frames.length}/${target}] ${result.capturedAt.toISOString()}`,
      );
    }

    if (frames.length < target) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.log("\nComputing per-pixel median...");
  const pixels = FRAME_WIDTH * FRAME_HEIGHT * CHANNELS;
  const median = Buffer.allocUnsafe(pixels);
  const scratch = new Uint8Array(frames.length);
  const mid = frames.length >> 1;
  const even = frames.length % 2 === 0;

  for (let i = 0; i < pixels; i++) {
    for (let f = 0; f < frames.length; f++) scratch[f] = frames[f][i];
    scratch.sort();
    median[i] = even
      ? (scratch[mid - 1] + scratch[mid]) >> 1
      : scratch[mid];
  }

  const daylight = isDaylight(timestamps[timestamps.length - 1]);
  const name = daylight ? "day.jpg" : "night.jpg";
  const refDir = path.join(process.cwd(), "reference");
  await mkdir(refDir, { recursive: true });

  const jpeg = await sharp(median, {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: CHANNELS },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

  await writeFile(path.join(refDir, name), jpeg);

  const span = Math.round(
    (timestamps[timestamps.length - 1].getTime() - timestamps[0].getTime()) /
      60000,
  );
  console.log(`\nWrote reference/${name}`);
  console.log(`  ${frames.length} frames spanning ${span} min`);
  console.log(
    "  Open it — the roadway should look empty. Any vehicle still visible was " +
      "parked across most of the frames; collect more frames if so.",
  );

  if (daylight) {
    console.log("\nNow run this again after dark to build reference/night.jpg.");
  } else {
    console.log("\nNow run this again in daylight to build reference/day.jpg.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
