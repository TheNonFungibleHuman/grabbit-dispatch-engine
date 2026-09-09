import zlib from "node:zlib";
import { formatError, logInfo, logWarn } from "../log.ts";
import { inspectImageWithDeepSeekVision, type VisionAnalysisResult } from "./vision-inspector.ts";

export interface PdfAnalysisResult {
  isTextPdf: boolean;
  extractedText: string;
  isPaymentReceipt: boolean;
  paymentDetails?: {
    bank?: string;
    amount?: number;
    currency?: string;
    referenceId?: string;
    status?: "successful" | "failed" | "pending";
    recipient?: string;
  };
  summary: string;
}

/**
 * Extracts embedded text streams from a PDF buffer (supporting uncompressed and FlateDecode streams).
 */
export function extractTextFromPdfBuffer(pdfBuffer: Buffer): string {
  try {
    const content = pdfBuffer.toString("binary");
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match: RegExpExecArray | null;
    let fullText = "";

    while ((match = streamRegex.exec(content)) !== null) {
      const rawStream = Buffer.from(match[1], "binary");
      let decompressed: string;
      try {
        decompressed = zlib.inflateSync(rawStream).toString("utf8");
      } catch {
        decompressed = rawStream.toString("utf8");
      }

      // Extract text enclosed in Tj operator: (string) Tj
      const textMatches = decompressed.matchAll(/\(([^)]+)\)\s*Tj/g);
      for (const tm of textMatches) {
        fullText += tm[1] + " ";
      }

      // Extract text enclosed in TJ array: [(part1) 10 (part2)] TJ
      const tjMatches = decompressed.matchAll(/\[(.*?)\]\s*TJ/g);
      for (const tj of tjMatches) {
        const parts = tj[1].matchAll(/\(([^)]+)\)/g);
        for (const p of parts) fullText += p[1];
        fullText += " ";
      }
    }

    return fullText.replace(/\s+/g, " ").trim();
  } catch (err) {
    logWarn("pdf_inspector", "native pdf text extraction failed", formatError(err));
    return "";
  }
}

/**
 * Extracts embedded image streams from a PDF buffer if it is an image-based scanned PDF.
 */
export function extractFirstImageFromPdfBuffer(pdfBuffer: Buffer): Buffer | null {
  try {
    const content = pdfBuffer.toString("binary");
    // Look for JPEG stream (starts with 0xFF 0xD8)
    const jpegStart = pdfBuffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (jpegStart !== -1) {
      const jpegEnd = pdfBuffer.indexOf(Buffer.from([0xff, 0xd9]), jpegStart);
      if (jpegEnd !== -1) {
        return pdfBuffer.subarray(jpegStart, jpegEnd + 2);
      }
    }
  } catch (err) {
    logWarn("pdf_inspector", "failed to extract embedded image from pdf", formatError(err));
  }
  return null;
}

/**
 * Inspect a PDF document: uses instant native text extraction for digital receipts,
 * falling back to DeepSeek Vision for scanned/photo PDFs.
 */
export async function inspectPdfDocument(
  pdfBuffer: Buffer,
  pdfUrl?: string,
): Promise<PdfAnalysisResult> {
  const text = extractTextFromPdfBuffer(pdfBuffer);

  // Track A: Digital vector PDF with text streams
  if (text.length > 20) {
    const textLower = text.toLowerCase();
    const isReceipt =
      (textLower.includes("receipt") ||
        textLower.includes("transfer") ||
        textLower.includes("payment") ||
        textLower.includes("mcb") ||
        textLower.includes("sbm") ||
        textLower.includes("juice") ||
        textLower.includes("absa")) &&
      (textLower.includes("ref") ||
        textLower.includes("mur") ||
        textLower.includes("rs") ||
        textLower.includes("successful") ||
        textLower.includes("amount"));

    if (isReceipt) {
      // Extract Reference ID
      const refMatch =
        text.match(/\b(FT[0-9A-Z]{8,14})\b/i) ||
        text.match(/\b(?:Reference|Ref|Transaction ID|Txn Ref)[:\s]+([0-9A-Z]{6,16})/i);
      const referenceId = refMatch ? refMatch[1].trim() : undefined;

      // Extract Amount
      const amountMatch =
        text.match(/(?:MUR|Rs\.?)\s*([0-9,]+(?:\.[0-9]{2})?)/i) ||
        text.match(/([0-9,]+(?:\.[0-9]{2})?)\s*(?:MUR|Rs)/i) ||
        text.match(/(?:Amount|Total)[:\s]+([0-9,]+(?:\.[0-9]{2})?)/i);
      const amount = amountMatch
        ? parseFloat(amountMatch[1].replace(/,/g, ""))
        : undefined;

      // Bank detection
      let bank = "Bank Transfer";
      if (textLower.includes("mcb") || textLower.includes("juice")) bank = "MCB Juice";
      else if (textLower.includes("sbm")) bank = "SBM";
      else if (textLower.includes("absa")) bank = "Absa";

      const isFailed = textLower.includes("failed") || textLower.includes("declined") || textLower.includes("cancelled");
      const status = isFailed ? ("failed" as const) : ("successful" as const);

      logInfo("pdf_inspector", "extracted digital banking pdf text in ~5ms (0 tokens)", {
        bank,
        amount,
        referenceId,
        status,
      });

      return {
        isTextPdf: true,
        extractedText: text,
        isPaymentReceipt: true,
        paymentDetails: {
          bank,
          amount,
          currency: "MUR",
          referenceId,
          status,
        },
        summary: `Digital ${bank} receipt of MUR ${amount || "unknown"} (Ref: ${referenceId || "unknown"})`,
      };
    }

    return {
      isTextPdf: true,
      extractedText: text,
      isPaymentReceipt: false,
      summary: text.slice(0, 300),
    };
  }

  // Track B: Scanned / Image-based PDF
  const embeddedImage = extractFirstImageFromPdfBuffer(pdfBuffer);
  if (embeddedImage) {
    logInfo("pdf_inspector", "scanned pdf detected; extracting embedded image for deepseek vision");
    const visionRes = await inspectImageWithDeepSeekVision({
      imageBuffer: embeddedImage,
      mimeType: "image/jpeg",
    });

    return {
      isTextPdf: false,
      extractedText: visionRes.summary,
      isPaymentReceipt: visionRes.isPaymentReceipt,
      paymentDetails: visionRes.paymentDetails,
      summary: visionRes.summary,
    };
  }

  return {
    isTextPdf: false,
    extractedText: "",
    isPaymentReceipt: false,
    summary: "Scanned PDF with no extractable text or images.",
  };
}
