import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  extractTextFromPdfBuffer,
  extractFirstImageFromPdfBuffer,
  inspectPdfDocument,
} from "./pdf-inspector.ts";
import { inspectImageWithDeepSeekVision } from "./vision-inspector.ts";

describe("Native PDF Text Extractor & Inspector", () => {
  it("extracts text from uncompressed PDF Tj operators", () => {
    const rawPdf = `
%PDF-1.4
1 0 obj
<< /Length 50 >>
stream
(MCB Juice Transfer Successful) Tj
(Amount: Rs 150) Tj
(Ref: FT262529948) Tj
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
    const buffer = Buffer.from(rawPdf, "utf8");
    const extracted = extractTextFromPdfBuffer(buffer);
    assert.match(extracted, /MCB Juice Transfer Successful/);
    assert.match(extracted, /Amount: Rs 150/);
    assert.match(extracted, /Ref: FT262529948/);
  });

  it("extracts text from flate-compressed PDF streams with TJ arrays", () => {
    const streamContent = Buffer.from("[(MCB) 10 ( Juice) -5 ( Payment)] TJ [( Rs 250.00)] TJ");
    const deflated = zlib.deflateSync(streamContent);

    const header = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\r\n");
    const footer = Buffer.from("\r\nendstream\nendobj\ntrailer\n<<>>\n%%EOF");
    const pdfBuffer = Buffer.concat([header, deflated, footer]);

    const extracted = extractTextFromPdfBuffer(pdfBuffer);
    assert.match(extracted, /MCB Juice Payment/);
    assert.match(extracted, /Rs 250\.00/);
  });

  it("inspects digital PDF receipt and parses payment details with 0 tokens", async () => {
    const rawReceiptPdf = `
%PDF-1.4
1 0 obj
<< /Length 120 >>
stream
(MCB Juice Instant Payment) Tj
(Transfer To: Grabbit Express 59323776) Tj
(Amount: MUR 175) Tj
(Ref: MCB883920194) Tj
(Status: Successful) Tj
endstream
endobj
trailer
<<>>
%%EOF`;
    const buffer = Buffer.from(rawReceiptPdf, "utf8");
    const result = await inspectPdfDocument(buffer);

    assert.equal(result.isTextPdf, true);
    assert.equal(result.isPaymentReceipt, true);
    assert.equal(result.paymentDetails?.bank, "MCB Juice");
    assert.equal(result.paymentDetails?.amount, 175);
    assert.equal(result.paymentDetails?.currency, "MUR");
    assert.equal(result.paymentDetails?.referenceId, "MCB883920194");
    assert.equal(result.paymentDetails?.status, "successful");
  });

  it("extracts embedded JPEG bytes from scanned photo PDFs", () => {
    const fakeJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\nstream\n"),
      fakeJpeg,
      Buffer.from("\nendstream\n%%EOF"),
    ]);

    const extractedImage = extractFirstImageFromPdfBuffer(pdf);
    assert.ok(extractedImage);
    assert.equal(extractedImage[0], 0xff);
    assert.equal(extractedImage[1], 0xd8);
    assert.equal(extractedImage[extractedImage.length - 2], 0xff);
    assert.equal(extractedImage[extractedImage.length - 1], 0xd9);
  });
});

describe("DeepSeek Vision Inspector", () => {
  it("returns fallback for empty or invalid image parameters", async () => {
    const result = await inspectImageWithDeepSeekVision({});
    assert.equal(result.category, "other");
    assert.equal(result.isPaymentReceipt, false);
    assert.match(result.summary, /No valid image data/);
  });

  it("formats base64 data url properly from imageBuffer", async () => {
    const fakeBuffer = Buffer.from("fake-image-bytes");
    const originalFetch = global.fetch;
    try {
      let requestedBody: any = null;
      (global as any).fetch = async (url: string, init: any) => {
        if (url.includes("api.deepseek.com")) {
          requestedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      category: "food_menu",
                      isPaymentReceipt: false,
                      extractedItems: ["Burger", "Fries", "Coke"],
                      summary: "Restaurant takeaway menu with burgers and fries",
                    }),
                  },
                },
              ],
            }),
          };
        }
        return originalFetch(url, init);
      };

      const result = await inspectImageWithDeepSeekVision({
        imageBuffer: fakeBuffer,
        mimeType: "image/png",
      });

      assert.equal(result.category, "food_menu");
      assert.deepEqual(result.extractedItems, ["Burger", "Fries", "Coke"]);
      assert.ok(requestedBody);
      const userMessage = requestedBody.messages[0];
      const imagePart = userMessage.content.find((c: any) => c.type === "image_url");
      assert.ok(imagePart);
      assert.ok(imagePart.image_url.url.startsWith("data:image/png;base64,"));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
