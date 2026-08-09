import { generateAgentReply } from "./gemini";
import { sendTextMessage } from "../wasender/client";
import type { IncomingUserMessage } from "../wasender/types";

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Cannot send reply: sender phone is missing");
  }
  return phone.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
}

/**
 * Run the Grabbit Gemini agent and reply on WhatsApp.
 */
export async function processIncomingUserMessage(
  message: IncomingUserMessage,
): Promise<void> {
  if (!message.text) {
    await sendTextMessage({
      to: toE164(message.sender),
      text: "Thanks for your message! Please share your delivery or trip details in text and I’ll help right away 💚",
    });
    return;
  }

  const reply = await generateAgentReply({
    sender: message.sender,
    text: message.text,
  });

  await sendTextMessage({
    to: toE164(message.sender),
    text: reply.text,
  });

  console.info("[agent] replied", {
    to: message.sender,
    messageId: message.messageId,
    model: reply.model,
    interactionId: reply.interactionId,
    replyPreview: reply.text.slice(0, 120),
  });
}

export { generateAgentReply } from "./gemini";
export { buildGrabbitSystemInstruction } from "./prompt";
