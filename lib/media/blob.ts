import { put } from "@vercel/blob";
import { getSupabaseClient } from "../supabase/client.ts";
import { logInfo, logWarn } from "../log.ts";

export async function uploadPackageImage(args: {
  senderPhone: string;
  messageId: string;
  bytes: ArrayBuffer | Buffer;
  contentType: string;
}): Promise<string> {
  const digits = args.senderPhone.replace(/\D/g, "");
  const extension = mimeToExtension(args.contentType);
  const pathname = `grabbit/packages/${digits}/${args.messageId}.${extension}`;

  // 1. Try Supabase Storage bucket ('package-images') if configured
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const bucketName = "package-images";
      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(pathname, args.bytes, {
          contentType: args.contentType,
          upsert: true,
        });

      if (!error && data?.path) {
        const { data: publicUrlData } = supabase.storage
          .from(bucketName)
          .getPublicUrl(data.path);

        if (publicUrlData?.publicUrl) {
          logInfo("supabase", "uploaded package image to Supabase Storage", {
            url: publicUrlData.publicUrl,
          });
          return publicUrlData.publicUrl;
        }
      } else if (error) {
        logWarn("supabase", "supabase storage upload error", {
          error: error.message,
        });
      }
    } catch (err) {
      logWarn("supabase", "supabase storage upload exception", err);
    }
  }

  // 2. Fall back to Vercel Blob if configured
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
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

  throw new Error(
    "Neither Supabase Storage (SUPABASE_URL) nor Vercel Blob (BLOB_READ_WRITE_TOKEN) is configured",
  );
}

function mimeToExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}
