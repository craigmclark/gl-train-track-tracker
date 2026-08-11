import Anthropic from "@anthropic-ai/sdk";

/**
 * Vision model used to classify crossing frames.
 *
 * Haiku 4.5 is the deliberate choice here: this is a two-field binary
 * classification on a 840x240 crop, roughly 200-300 calls a day, which lands in
 * cents per day. Swap to "claude-opus-5" if audit numbers on /stats show Haiku
 * struggling with night frames — the call shape is identical, only the cost and
 * accuracy change. (Note: Haiku 4.5 rejects `effort` and takes no adaptive
 * thinking, which is why neither appears in the request below.)
 */
export const VLM_MODEL = "claude-haiku-4-5";

const client = new Anthropic();

export type Verdict = {
  trainPresent: boolean;
  gates: "up" | "down" | "unknown";
  confidence: number;
  notes: string;
};

const SYSTEM_PROMPT = `You are analysing a fixed traffic-camera crop of a railroad grade crossing on IL 120 in Grayslake, Illinois, about 100 feet west of the IL 83 intersection. The camera never moves and always looks west along the roadway. The Canadian National tracks run across the road, roughly perpendicular to the direction of view.

Report only what is visible in this image.

A train is present when railcars, locomotives, or a continuous wall of rolling stock occupies the track bed across the roadway. Passing road traffic, pedestrians, snow, glare, and wet pavement reflections are NOT trains.

Crossing gates are the striped arms on masts beside the road. They are "down" when horizontal across the roadway, "up" when vertical or angled upward, and "unknown" when you cannot see them well enough to tell.

Night frames are dark, grainy, and blown out by streetlight and headlight glare. If the image is too degraded to judge, say so with low confidence rather than guessing — a confident wrong answer is far worse here than an admitted uncertainty.

Set confidence between 0 and 1 for how sure you are about trainPresent specifically. Keep notes under 15 words.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    trainPresent: {
      type: "boolean",
      description: "True only if railcars or a locomotive occupy the crossing.",
    },
    gates: {
      type: "string",
      enum: ["up", "down", "unknown"],
      description: "Position of the crossing gate arms.",
    },
    confidence: {
      type: "number",
      description: "0 to 1 confidence in the trainPresent value.",
    },
    notes: {
      type: "string",
      description: "Under 15 words on what drove the call.",
    },
  },
  required: ["trainPresent", "gates", "confidence", "notes"],
  additionalProperties: false,
} as const;

/**
 * Classify a single ROI crop.
 *
 * Deliberately takes the crop rather than the full frame — the full 720x480 view
 * also contains a signalised road intersection, and a model asked about "gates"
 * will happily describe the traffic lights instead.
 */
export async function classifyCrop(roiJpeg: Buffer): Promise<Verdict> {
  const response = await client.messages.create({
    model: VLM_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: roiJpeg.toString("base64"),
            },
          },
          {
            type: "text",
            text: "Is a train occupying this crossing, and what position are the gate arms in?",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("VLM declined to classify the frame");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("VLM returned no text block");
  }

  const parsed = JSON.parse(textBlock.text) as Verdict;

  return {
    trainPresent: Boolean(parsed.trainPresent),
    gates: parsed.gates ?? "unknown",
    // Clamp: a model-supplied number outside 0-1 would corrupt the stats page.
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    notes: String(parsed.notes ?? "").slice(0, 200),
  };
}

/** Human-readable reason a frame was sent to the VLM. */
export type VlmReason = "threshold" | "audit" | "forced";
