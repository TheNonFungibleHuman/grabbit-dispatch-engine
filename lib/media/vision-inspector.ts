import { formatError, logError, logInfo, logWarn } from "../log.ts";

export interface VisionAnalysisResult {
  category: "payment_receipt" | "food_menu" | "package_item" | "location_map" | "other";
  isPaymentReceipt: boolean;
  paymentDetails?: {
    bank?: string;
    amount?: number;
    currency?: string;
    referenceId?: string;
    status?: "successful" | "failed" | "pending";
    recipient?: string;
  };
  extractedItems?: string[];
  summary: string;
}

const DEEPSEEK_API_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const VISION_MODEL = process.env.DEEPSEEK_VISION_MODEL || "deepseek-flash";

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  return key;
}

/**
 * Inspect an image using DeepSeek's official multimodal vision endpoint.
 */
export async function inspectImageWithDeepSeekVision(args: {
  imageUrl?: string;
  imageBuffer?: Buffer | ArrayBuffer;
  mimeType?: string;
}): Promise<VisionAnalysisResult> {
  let dataUrl = args.imageUrl;

  if (args.imageBuffer) {
    const buf = Buffer.isBuffer(args.imageBuffer)
      ? args.imageBuffer
      : Buffer.from(args.imageBuffer);
    const mime = args.mimeType || "image/jpeg";
    dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  } else if (args.imageUrl && !args.imageUrl.startsWith("data:")) {
    try {
      const res = await fetch(args.imageUrl);
      if (res.ok) {
        const mime = res.headers.get("content-type") || args.mimeType || "image/jpeg";
        const ab = await res.arrayBuffer();
        dataUrl = `data:${mime};base64,${Buffer.from(ab).toString("base64")}`;
      }
    } catch (e) {
      logWarn("vision", "failed to convert imageUrl to base64, using raw url", formatError(e));
    }
  }

  if (!dataUrl) {
    return {
      category: "other",
      isPaymentReceipt: false,
      summary: "No valid image data provided for inspection.",
    };
  }

  const prompt = `You are the visual intake inspector for Grabbit Express, an on-demand electric delivery and passenger ride service in Mauritius.
Analyze this image.
Classify its category:
1. "payment_receipt": An MCB Juice, SBM, Absa, Blink, or Bank transfer screenshot or payment confirmation.
2. "food_menu": A restaurant menu, food chalkboard, or grocery/shopping list.
3. "package_item": A parcel, package, envelope, or item to be picked up/delivered.
4. "location_map": A Google Maps screenshot, landmark, or campus pin.
5. "other": Any other image.

If it is a payment receipt:
- Extract the bank name (e.g. "MCB Juice", "SBM", "Absa").
- Extract the numeric amount (e.g. 150) and currency ("MUR" or "Rs").
- Extract the transaction reference number (e.g. "FT262529948").
- Extract recipient name or phone if visible (e.g. "Grabbit Express" or "59323776").
- Determine if the transaction status is "successful", "failed", or "pending".

If it is a food menu or shopping list:
- Extract the list of items/dishes in extractedItems.

Return ONLY a JSON object matching this schema:
{
  "category": "payment_receipt" | "food_menu" | "package_item" | "location_map" | "other",
  "isPaymentReceipt": boolean,
  "paymentDetails": {
    "bank": string | null,
    "amount": number | null,
    "currency": string | null,
    "referenceId": string | null,
    "recipient": string | null,
    "status": "successful" | "failed" | "pending" | null
  },
  "extractedItems": string[],
  "summary": string
}`;

  try {
    const response = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logError("vision", `deepseek vision api failed (${response.status})`, errText);
      return {
        category: "other",
        isPaymentReceipt: false,
        summary: `Vision API error (${response.status})`,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return {
        category: "other",
        isPaymentReceipt: false,
        summary: "Empty response from vision model.",
      };
    }

    const parsed = JSON.parse(content) as VisionAnalysisResult;
    logInfo("vision", "successfully inspected image with deepseek vision", {
      category: parsed.category,
      isPaymentReceipt: parsed.isPaymentReceipt,
      amount: parsed.paymentDetails?.amount,
      status: parsed.paymentDetails?.status,
    });
    return parsed;
  } catch (error) {
    logError("vision", "exception during deepseek vision inspection", error);
    return {
      category: "other",
      isPaymentReceipt: false,
      summary: "Failed to inspect image.",
    };
  }
}
