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

export interface RiderReschedulePayload {
  bookingId: string;
  customerName: string;
  customerPhone: string;
  serviceKind: "delivery" | "trip" | string;
  pickupAddress: string;
  dropoffAddress: string;
  oldScheduledTime: string;
  newScheduledTime: string;
  assignedRider: string;
  trackingUrl?: string;
  kiloDeliveryId?: string;
}

export async function notifyRiderOfReschedule(
  payload: RiderReschedulePayload,
): Promise<{ ok: boolean; channel: string; error?: string }> {
  const rider = findRiderByName(payload.assignedRider);
  if (!rider) {
    return { ok: false, channel: "none", error: `Rider ${payload.assignedRider} profile not found` };
  }

  const messageText = [
    `🔄 *${payload.serviceKind.toUpperCase()} TIME UPDATE / RESCHEDULED*`,
    `Attention ${rider.name}: A customer has moved their scheduled ${payload.serviceKind} time.`,
    ``,
    `👤 Customer: *${payload.customerName}* (${payload.customerPhone})`,
    `⏱️ Time Change: ~${payload.oldScheduledTime}~ ➔ *${payload.newScheduledTime}*`,
    `📍 Pickup: ${payload.pickupAddress}`,
    `📍 Drop-off: ${payload.dropoffAddress}`,
    payload.trackingUrl ? `🔴 Live Tracking: ${payload.trackingUrl}` : ``,
    ``,
    `ℹ️ *Note:* This is an update to your existing assigned trip ${payload.kiloDeliveryId || ''}, NOT a new booking.`,
    `Grabbit Express 🛵⚡`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching rider reschedule update", {
    rider: rider.name,
    channel: rider.channel,
    bookingId: payload.bookingId,
    newTime: payload.newScheduledTime,
  });

  // 1. Google Chat
  if (rider.channel === "google_chat") {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `*Grabbit Dispatch Update for ${rider.name}*\n${messageText}`,
          }),
        });
        if (res.ok) {
          logInfo("riders", "google chat webhook reschedule notification sent", {
            rider: rider.name,
          });
          return { ok: true, channel: "google_chat" };
        }
      } catch (err) {
        logError("riders", "failed to send google chat webhook", err);
      }
    }
  }

  // 2. WhatsApp
  const targetPhone = process.env.TEST_RIDER_PHONE?.trim() || rider.phone;
  if (targetPhone && rider.channel === "whatsapp") {
    try {
      await sendCustomerText({
        to: targetPhone,
        text: messageText,
        messageId: `rider_reschedule_${payload.bookingId}_${Date.now()}`,
      });
      return { ok: true, channel: "whatsapp" };
    } catch (err) {
      return { ok: false, channel: "whatsapp", error: String(formatError(err).message || err) };
    }
  }

  return { ok: true, channel: "logged" };
}

export async function notifyRiderCustomerInquiry(args: {
  assignedRider: string;
  customerName: string;
  customerPhone: string;
  inquiry: string;
  bookingId?: string;
  kiloDeliveryId?: string;
  trackingUrl?: string;
}): Promise<{ ok: boolean; channel: string }> {
  const rider = findRiderByName(args.assignedRider);
  if (!rider) return { ok: false, channel: "none" };

  const messageText = [
    `⚠️ *CUSTOMER STATUS INQUIRY*`,
    `Customer *${args.customerName}* (${args.customerPhone}) is asking for an update on their order/ride:`,
    `"${args.inquiry}"`,
    ``,
    args.trackingUrl ? `🔴 Live Tracking: ${args.trackingUrl}` : ``,
    `Please check your live map or reach out if there are any delays!`,
    `Grabbit Express 🛵⚡`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching customer inquiry to rider", { rider: rider.name, inquiry: args.inquiry });

  if (rider.channel === "google_chat") {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*Grabbit Customer Alert for ${rider.name}*\n${messageText}` }),
        });
        return { ok: true, channel: "google_chat" };
      } catch (err) {
        logError("riders", "failed to send inquiry to google chat", err);
      }
    }
  }

  return { ok: true, channel: "logged" };
}

export async function notifyAdminEscalation(args: {
  customerPhone: string;
  customerName: string;
  reason: string;
  recentContext?: string;
}): Promise<{ ok: boolean }> {
  const adminPhone = "+999000000008";
  const messageText = [
    `🚨 *GRABBIT DISPATCH ADMIN ESCALATION*`,
    `Customer: *${args.customerName}* (${args.customerPhone})`,
    `Reason: ${args.reason}`,
    args.recentContext ? `Context: ${args.recentContext}` : ``,
    `Please check the dashboard or WhatsApp thread to assist.`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching admin escalation", { phone: args.customerPhone, reason: args.reason });

  // 1. Google Chat
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: messageText }),
      });
    } catch (err) {
      logError("riders", "failed to send escalation to google chat", err);
    }
  }

  // 2. WhatsApp to Admin
  try {
    await sendCustomerText({
      to: adminPhone,
      text: messageText,
      messageId: `admin_esc_${Date.now()}`,
    });
  } catch (err) {
    logWarn("riders", "failed to send whatsapp to admin", formatError(err));
  }

  return { ok: true };
}

export async function notifyRiderRideReminder(args: {
  assignedRider: string;
  customerName: string;
  customerPhone: string;
  scheduledTime: string;
  pickupAddress: string;
  dropoffAddress: string;
  serviceKind: string;
  trackingUrl?: string;
}): Promise<{ ok: boolean }> {
  const rider = findRiderByName(args.assignedRider);
  if (!rider) return { ok: false };

  const messageText = [
    `⏰ *UPCOMING ${args.serviceKind.toUpperCase()} IN 25 MINUTES!*`,
    `Attention ${rider.name}: Your scheduled run starts at *${args.scheduledTime}*.`,
    ``,
    `👤 Customer: *${args.customerName}* (${args.customerPhone})`,
    `📍 Pickup: ${args.pickupAddress}`,
    `📍 Drop-off: ${args.dropoffAddress}`,
    args.trackingUrl ? `🔴 Live Tracking: ${args.trackingUrl}` : ``,
    `Please prepare for pickup! 🛵⚡`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching 25-min reminder to rider", { rider: rider.name, time: args.scheduledTime });

  if (rider.channel === "google_chat") {
    const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*Reminder for ${rider.name}*\n${messageText}` }),
        });
      } catch (err) {
        logError("riders", "failed to send reminder to google chat", err);
      }
    }
  }

  return { ok: true };
}
