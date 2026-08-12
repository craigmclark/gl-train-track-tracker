import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { FRAME_HEIGHT, FRAME_WIDTH, ROI, TRAINING_CROP } from "./config";

/** Working resolution for differencing. Small enough to be cheap, big enough to
 *  keep a train-sized object obvious. */
const ANALYSIS_WIDTH = 240;
const ANALYSIS_HEIGHT = 160;

const SCALE_X = ANALYSIS_WIDTH / FRAME_WIDTH;
const SCALE_Y = ANALYSIS_HEIGHT / FRAME_HEIGHT;

const ROI_SCALED = {
  left: Math.round(ROI.left * SCALE_X),
  top: Math.round(ROI.top * SCALE_Y),
  right: Math.round((ROI.left + ROI.width) * SCALE_X),
  bottom: Math.round((ROI.top + ROI.height) * SCALE_Y),
};

export type FrameAnalysis = {
  /** Mean absolute luminance difference inside the ROI (0-255). */
  roiScore: number;
  /** Change in edge density inside the ROI — a train wall adds a lot of structure. */
  edgeDelta: number;
  /** Mean absolute difference *outside* the ROI. High means the camera moved. */
  driftScore: number;
  /** Combined score compared against CV_ESCALATE_THRESHOLD. */
  score: number;
};

/**
 * Normalise any incoming frame to a fixed-size grayscale plane.
 *
 * A light blur is applied first: these are noisy low-bitrate JPEGs, and at night
 * the sensor grain alone can move a raw mean-abs-diff by several counts.
 */
async function toGrayPlane(buffer: Buffer): Promise<Uint8Array> {
  const data = await sharp(buffer)
    .resize(ANALYSIS_WIDTH, ANALYSIS_HEIGHT, { fit: "fill" })
    .grayscale()
    .blur(1.2)
    .raw()
    .toBuffer();
  return new Uint8Array(data);
}

function idx(x: number, y: number): number {
  return y * ANALYSIS_WIDTH + x;
}

function inRoi(x: number, y: number): boolean {
  return (
    x >= ROI_SCALED.left &&
    x < ROI_SCALED.right &&
    y >= ROI_SCALED.top &&
    y < ROI_SCALED.bottom
  );
}

/** Sum of local gradient magnitude — a cheap stand-in for "how much structure". */
function edgeDensity(plane: Uint8Array): number {
  let total = 0;
  let n = 0;
  for (let y = ROI_SCALED.top + 1; y < ROI_SCALED.bottom - 1; y++) {
    for (let x = ROI_SCALED.left + 1; x < ROI_SCALED.right - 1; x++) {
      const gx = plane[idx(x + 1, y)] - plane[idx(x - 1, y)];
      const gy = plane[idx(x, y + 1)] - plane[idx(x, y - 1)];
      total += Math.abs(gx) + Math.abs(gy);
      n++;
    }
  }
  return n === 0 ? 0 : total / n;
}

/**
 * Compare a new frame against the reference for the current lighting condition.
 *
 * Splitting ROI difference from outside-ROI difference is what lets us tell a
 * train (big change in the crossing box, scene otherwise stable) apart from a
 * repositioned PTZ camera (everything changes at once).
 */
export async function analyzeFrame(
  frame: Buffer,
  reference: Buffer,
): Promise<FrameAnalysis> {
  const [a, b] = await Promise.all([
    toGrayPlane(frame),
    toGrayPlane(reference),
  ]);

  let roiSum = 0;
  let roiCount = 0;
  let outSum = 0;
  let outCount = 0;

  for (let y = 0; y < ANALYSIS_HEIGHT; y++) {
    for (let x = 0; x < ANALYSIS_WIDTH; x++) {
      const i = idx(x, y);
      const d = Math.abs(a[i] - b[i]);
      if (inRoi(x, y)) {
        roiSum += d;
        roiCount++;
      } else {
        outSum += d;
        outCount++;
      }
    }
  }

  const roiScore = roiCount === 0 ? 0 : roiSum / roiCount;
  const driftScore = outCount === 0 ? 0 : outSum / outCount;
  const edgeDelta = Math.abs(edgeDensity(a) - edgeDensity(b));

  // Subtract the global term: if the whole frame got brighter (headlights, sun,
  // a passing cloud) that is not evidence of a train. Only ROI change *in excess
  // of* the scene-wide change counts.
  const excess = Math.max(0, roiScore - driftScore * 0.6);

  return {
    roiScore,
    edgeDelta,
    driftScore,
    score: excess + edgeDelta * 0.5,
  };
}

/**
 * Crop the ROI for the VLM.
 *
 * Sending the crop rather than the full 720x480 frame is both cheaper and more
 * accurate — the full frame contains an unrelated signalised intersection, and
 * models will happily describe the traffic lights when asked about gates.
 * Upscaled 2x because the crop is small and these JPEGs are soft.
 */
export async function cropRoiJpeg(frame: Buffer): Promise<Buffer> {
  // Two pipelines on purpose: sharp allows only one resize per pipeline, and a
  // second .resize() call silently replaces the first rather than chaining. The
  // normalise-then-extract and the 2x upscale therefore cannot share one.
  const extracted = await sharp(frame)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .extract({
      left: ROI.left,
      top: ROI.top,
      width: ROI.width,
      height: ROI.height,
    })
    .toBuffer();

  return sharp(extracted)
    .resize(ROI.width * 2, ROI.height * 2, { kernel: "lanczos3" })
    .normalise() // stretch contrast; night frames are otherwise near-black
    .jpeg({ quality: 88 })
    .toBuffer();
}

/**
 * Tiny grayscale ROI crop for the training archive.
 *
 * Grayscale on purpose: colour is what fooled the vision model at night (red
 * signals reading as train activity), and a local classifier should be learning
 * the shape of a railcar wall occluding the roadway, not the presence of red
 * pixels.
 */
export async function trainingCropJpeg(frame: Buffer): Promise<Buffer> {
  const extracted = await sharp(frame)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
    .extract({
      left: ROI.left,
      top: ROI.top,
      width: ROI.width,
      height: ROI.height,
    })
    .toBuffer();

  return sharp(extracted)
    .resize(TRAINING_CROP.width, TRAINING_CROP.height, { fit: "fill" })
    .grayscale()
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Load the day or night baseline. Returns null if it hasn't been captured yet. */
export async function loadReference(daylight: boolean): Promise<Buffer | null> {
  const file = daylight ? "day.jpg" : "night.jpg";
  try {
    return await readFile(path.join(process.cwd(), "reference", file));
  } catch {
    return null;
  }
}
