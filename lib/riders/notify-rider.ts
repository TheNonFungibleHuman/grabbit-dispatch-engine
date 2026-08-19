import { sendCustomerText } from "../wasender/send-tracked.ts";
import { formatError, logError, logInfo, logWarn } from "../log.ts";
import { FLEET_RIDERS, findRiderByName, type RiderProfile } from "./config.ts";

export interface RiderNotificationPayload {
  bookingId: string;
  customerName: string;
  customerPhone: string;
  serviceKind: "delivery" | "trip" | string;
  pickupAddress: string;
  dropoffAddress: string;
  scheduledTime: string;
  assignedRider: string;
  trackingUrl?: string;
}

export async function notifyRiderForBooking(
  payload: RiderNotificationPayload,
): Promise<{ ok: boolean; channel: string; error?: string }> {
  const rider = findRiderByName(payload.assignedRider);
  if (!rider) {
    logWarn("riders", "no rider profile found for notification", {
      assignedRider: payload.assignedRider,
    });
    return { ok: false, channel: "none", error: `Rider ${payload.assignedRider} profile not found` };
  }

  const messageText = [
    `🛵 *New Grabbit ${payload.serviceKind.toUpperCase()} Assigned!*`,
    `You have a scheduled ${payload.serviceKind} during your shift:`,
    ``,
    `👤 Customer: *${payload.customerName}* (${payload.customerPhone})`,
    `⏰ Time: *${payload.scheduledTime}*`,
    `📍 Pickup: ${payload.pickupAddress}`,
    `📍 Drop-off: ${payload.dropoffAddress}`,
    payload.trackingUrl ? `🔴 Live Tracking: ${payload.trackingUrl}` : ``,
    ``,
    `Grabbit Express 🛵⚡`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching rider notification", {
    rider: rider.name,
    channel: rider.channel,
    bookingId: payload.bookingId,
  });

  // 1. Google Chat notification (for Moses or webhook channels)
  if (rider.channel === "google_chat") {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `*Grabbit Assignment for ${rider.name}*\n${messageText}`,
          }),
        });
        if (res.ok) {
          logInfo("riders", "google chat webhook notification sent", {
            rider: rider.name,
          });
          return { ok: true, channel: "google_chat" };
        }
        logWarn("riders", "google chat webhook returned non-ok status", {
          status: res.status,
          statusText: res.statusText,
        });
      } catch (err) {
        logError("riders", "failed to send google chat webhook", err);
      }
    }
  }

  // 2. WhatsApp notification
  const targetPhone = process.env.TEST_RIDER_PHONE?.trim() || rider.phone;
  if (targetPhone && rider.channel === "whatsapp") {
    try {
      await sendCustomerText({
        to: targetPhone,
        text: messageText,
        messageId: `rider_notif_${payload.bookingId}_${Date.now()}`,
      });
      logInfo("riders", "whatsapp notification sent to rider", {
        rider: rider.name,
        phone: targetPhone,
      });
      return { ok: true, channel: "whatsapp" };
    } catch (err) {
      logError("riders", "failed to send whatsapp to rider", err);
      return { ok: false, channel: "whatsapp", error: String(formatError(err).message || err) };
    }
  }

  // 3. Email notification via Resend if configured
  if (rider.email && process.env.RESEND_API_KEY?.trim()) {
    try {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || "Grabbit Dispatch <onboarding@resend.dev>",
          to: rider.email,
          subject: `🛵 New Grabbit ${payload.serviceKind.toUpperCase()} Assigned - ${payload.scheduledTime}`,
          text: messageText,
        }),
      });
      if (emailRes.ok) {
        logInfo("riders", "email notification sent to rider via Resend", {
          rider: rider.name,
          email: rider.email,
        });
        return { ok: true, channel: "email" };
      }
    } catch (err) {
      logError("riders", "failed to send email to rider", err);
    }
  }

  // Fallback logging
  if (rider.email) {
    logInfo("riders", "rider email/chat notification logged", {
      rider: rider.name,
      email: rider.email,
      bookingId: payload.bookingId,
    });
    return { ok: true, channel: "email_or_chat" };
  }

  return { ok: false, channel: "none", error: "No viable notification channel" };
}
