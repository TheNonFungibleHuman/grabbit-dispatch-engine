import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedRiderOrAdmin } from "@/lib/riders/config";
import { handleRiderCommand } from "@/lib/riders/commands";
import { generateAgentReply } from "@/lib/agent/deepseek";
import { formatError, logInfo, logWarn, logError } from "@/lib/log";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "grabbit-google-chat-webhook",
    time: new Date().toISOString(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Optional token verification
    const expectedToken = process.env.GOOGLE_CHAT_VERIFICATION_TOKEN?.trim();
    if (expectedToken && payload.token && payload.token !== expectedToken) {
      logWarn("gchat_webhook", "rejected request with mismatched verification token");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const eventType = payload.type || "MESSAGE";
    logInfo("gchat_webhook", "received google chat event", {
      type: eventType,
      space: payload.space?.name,
      senderEmail: payload.user?.email || payload.message?.sender?.email,
    });

    // 1. Added to Space / Direct Message
    if (eventType === "ADDED_TO_SPACE") {
      return NextResponse.json({
        text: "👋 *Grabbit Dispatch Bot is online!*\nFleet riders (like Moses) and admins can chat with me here or in private 1-on-1 DMs to manage dispatches, check shift schedules, or use 1-word commands (*Delivered*, *Break 15m*, *Back*). 🛵💨",
      });
    }

    // 2. Message Event
    if (eventType === "MESSAGE") {
      const email = String(payload.user?.email || payload.message?.sender?.email || "").trim().toLowerCase();
      const displayName = String(payload.user?.displayName || payload.message?.sender?.displayName || "Teammate").trim();
      const rawText = String(payload.message?.argumentText || payload.message?.text || "").trim();
      
      // Strip @mention prefix if invoked in a group space
      const text = rawText.replace(/^@\S+\s*/, "").trim();

      if (!text) {
        return NextResponse.json({
          text: `Hello ${displayName}! How can dispatch help you today? 🛵`,
        });
      }

      const auth = isAuthorizedRiderOrAdmin(email);

      // Check 1-word commands from Fleet Rider (e.g. Moses)
      if (auth.rider) {
        const cmdResult = await handleRiderCommand({
          senderPhone: email,
          messageText: text,
          rider: auth.rider,
        });

        if (cmdResult.handled && cmdResult.replyText) {
          logInfo("gchat_webhook", "executed rider 1-word command via google chat", {
            rider: auth.rider.name,
            action: cmdResult.action,
          });
          return NextResponse.json({ text: cmdResult.replyText });
        }
      }

      // Generate Agent Reply
      const reply = await generateAgentReply({
        messageId: `gchat_${payload.message?.name?.replace(/\//g, "_") || Date.now()}`,
        sender: email || `gchat_${displayName}`,
        text,
        pushName: displayName,
      });

      return NextResponse.json({
        text: reply.text,
      });
    }

    return NextResponse.json({ text: "Acknowledge" });
  } catch (err) {
    logError("gchat_webhook", "failed to process google chat event", err);
    return NextResponse.json(
      { text: "Sorry, I had a brief issue processing that request. Please try again in a moment." },
      { status: 200 },
    );
  }
}
