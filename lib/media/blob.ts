import { put } from "@vercel/blob";

function requireBlobToken(): void {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }
}

export async function uploadPackageImage(args: {
  senderPhone: string;
  messageId: string;
  bytes: ArrayBuffer | Buffer;
  contentType: string;
}): Promise<string> {
  requireBlobToken();

  const digits = args.senderPhone.replace(/\D/g, "");
  const extension = mimeToExtension(args.contentType);
  const pathname = `grabbit/packages/${digits}/${args.messageId}.${extension}`;

  const blob = await put(pathname, args.bytes, {
    access: "public",
    contentType: args.contentType,
    addRandomSuffix: true,
  });

  if (!blob.url.startsWith("https://")) {
    throw new Error("Blob upload did not return an https URL");
  }

  return blob.url;
}

function mimeToExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}
