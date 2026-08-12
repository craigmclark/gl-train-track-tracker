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

Report only what you can actually see in this image.

TRAIN PRESENT MEANS VISIBLE RAILCARS. Set trainPresent true only when you can make out the physical bodies of rolling stock — boxcars, tank cars, hoppers, flatcars, or a locomotive — as a solid mass sitting on the track bed across the roadway. A real train reads as a large dark wall that occludes the far side of the road and hides the background behind it.

NEVER INFER A TRAIN FROM LIGHTS. Lights are not rolling stock. Do not report a train because you see red lights, flashing lights, glare, or coloured reflections. This crop contains ordinary road traffic signals: a red/green signal head near the LEFT edge and another near the RIGHT edge. Those are for cars, not trains, and they are lit around the clock. On wet pavement at night they bloom into large red and pink smears across the whole lower half of the frame. That appearance is extremely common here and it is NOT a train.

Activated crossing signals are also not sufficient on their own. Flashing red crossing lights or a lowered gate mean a train is expected — not that one is currently in view. If the lights are active but you cannot see railcar bodies, answer trainPresent false.

NIGHT FRAMES: these are dark, grainy, low-contrast, and dominated by glare. Most night frames here show an empty crossing with signal reflections. If you cannot positively resolve railcar bodies, the correct answer is trainPresent false — not a guess. A confident wrong "train" is far more damaging than admitting you cannot tell.

Gates are the long striped arms on masts beside the road: "down" only when an arm is clearly horizontal across the roadway, "up" when vertical or angled upward, "unknown" when you cannot resolve an arm. Note there is also a horizontal railing along the railroad right-of-way that is present at all times; do not mistake it for a gate arm.

confidence is the probability that a train is genuinely present, from 0 to 1. Use 0.9+ only when railcar bodies are unmistakable. If your reasoning depends on lights, glare, or inference rather than visible rolling stock, your confidence must be below 0.5.

notes: under 15 words, and state what you actually saw — name the rolling stock if you saw it.`;

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
