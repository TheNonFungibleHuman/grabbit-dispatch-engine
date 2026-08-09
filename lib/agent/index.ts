import { generateAgentReply } from "./gemini";
import { persistIncomingPackageImage } from "../media/wasender";
import { addPackageImageToDraft } from "../orders/store";
import { sendTextMessage } from "../wasender/client";
import type { IncomingUserMessage } from "../wasender/types";

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Cannot send reply: sender phone is missing");
  }
  return phone.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
}

function hasImageMessage(message: IncomingUserMessage): boolean {
  return Boolean(
    message.raw.message &&
      typeof message.raw.message === "object" &&
      "imageMessage" in message.raw.message,
  );
}

/**
 * Run the Grabbit Gemini agent and reply on WhatsApp.
 */
export async function processIncomingUserMessage(
  message: IncomingUserMessage,
): Promise<void> {
  const to = toE164(message.sender);

  if (hasImageMessage(message)) {
    try {
      const imageUrl = await persistIncomingPackageImage({
        senderPhone: message.sender,
        messageId: message.messageId,
        message: message.raw.message,
      });

      if (imageUrl) {
        const draft = await addPackageImageToDraft(message.sender, imageUrl);
        const caption = message.text?.trim();

        if (caption) {
          const reply = await generateAgentReply({
            sender: message.sender,
            text: caption,
            messageId: message.messageId,
            pushName: message.pushName,
          });
          await sendTextMessage({ to, text: reply.text });
        } else {
          const name = message.pushName?.trim();
          await sendTextMessage({
            to,
            text: name
              ? `Got it ${name}. Photo saved (${draft.packageImages.length}/6). Send another if needed, or tell me pickup and drop-off 🙂`
              : `Got your photo (${draft.packageImages.length}/6). Send another if needed, or tell me the pickup and drop-off details 🙂`,
          });
        }

        console.info("[agent] stored package image", {
          to: message.sender,
          messageId: message.messageId,
          count: draft.packageImages.length,
        });
        return;
      }
    } catch (error) {
      console.error("[agent] failed to persist package image", error);
      await sendTextMessage({
        to,
        text: "I couldn’t save that photo. Please send it again as an image 💚",
      });
      return;
    }
  }

  if (!message.text) {
    await sendTextMessage({
      to,
      text: "Happy to help. Tell me what you need delivered, or send a package photo to start 💚",
    });
    return;
  }

  const reply = await generateAgentReply({
    sender: message.sender,
    text: message.text,
    messageId: message.messageId,
    pushName: message.pushName,
  });

  await sendTextMessage({
    to,
    text: reply.text,
  });

  console.info("[agent] replied", {
    to: message.sender,
    messageId: message.messageId,
    model: reply.model,
    interactionId: reply.interactionId,
    usedHistory: Boolean(reply.previousInteractionId),
    replyPreview: reply.text.slice(0, 120),
  });
}

export { generateAgentReply } from "./gemini";
export { sanitizeWhatsAppText } from "./format";
export { buildGrabbitSystemInstruction } from "./prompt";
