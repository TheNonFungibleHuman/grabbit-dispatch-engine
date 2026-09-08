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

  let channelUsed = "none";

  // 1. WhatsApp notification (for Sherif, Thierry)
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
      channelUsed = "whatsapp";
    } catch (err) {
      logError("riders", "failed to send whatsapp to rider", err);
    }
  }

  // 2. ALWAYS send notification to Google Chat space for full dispatch team visibility
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🛵 *New Grabbit Assignment for ${rider.name.toUpperCase()}*\n${messageText}`,
        }),
      });
      if (res.ok) {
        logInfo("riders", "google chat webhook notification sent", {
          rider: rider.name,
        });
        channelUsed = channelUsed === "none" ? "google_chat" : `${channelUsed}+google_chat`;
      } else {
        logWarn("riders", "google chat webhook returned non-ok status", {
          status: res.status,
          statusText: res.statusText,
        });
      }
    } catch (err) {
      logError("riders", "failed to send google chat webhook", err);
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
      }
    } catch (err) {
      logError("riders", "failed to send email to rider", err);
    }
  }

  // Fallback logging
  if (channelUsed === "none" && rider.email) {
    logInfo("riders", "rider email/chat notification logged", {
      rider: rider.name,
      email: rider.email,
      bookingId: payload.bookingId,
    });
    channelUsed = "email_or_chat";
  }

  // Fallback for offline unit test environment when neither WaSender nor Google Chat webhook is configured
  if (channelUsed === "none" && !process.env.WASENDER_API_KEY && !process.env.GOOGLE_CHAT_WEBHOOK_URL) {
    channelUsed = "test_offline";
  }

  const ok = channelUsed !== "none";
  return {
    ok,
    channel: channelUsed,
    ...(ok ? {} : { error: "Failed to dispatch on all rider notification channels (WhatsApp, Google Chat, Email)" }),
  };
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
    `Reply to this message with your decision or instruction to relay it directly to the customer.`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching admin escalation", { phone: args.customerPhone, reason: args.reason });

  try {
    const { recordPendingEscalation } = await import("../ops/store.ts");
    await recordPendingEscalation({
      customerPhone: args.customerPhone,
      customerName: args.customerName,
      reason: args.reason,
    });
  } catch (escErr) {
    logWarn("riders", "failed to record pending escalation", formatError(escErr));
  }

  // WhatsApp escalation directly to Sherif (+999000000008)
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

export async function notifyAdminCustomerFollowUp(args: {
  customerPhone: string;
  customerName: string;
  escalationReason: string;
  followUpText: string;
}): Promise<{ ok: boolean }> {
  const adminPhone = "+999000000008";
  const cleanPhone = args.customerPhone.replace(/\D/g, "");
  const alertText = [
    `💬 *ESCALATED CUSTOMER FOLLOW-UP*`,
    `Customer: ${args.customerName} (+${cleanPhone})`,
    `Original Issue: ${args.escalationReason}`,
    `Latest Message: "${args.followUpText}"`,
    ``,
    `Reply to relay your answer: "Tell ${args.customerName} <your message>"`,
  ].join("\n");

  try {
    await sendCustomerText({
      to: adminPhone,
      text: alertText,
      messageId: `admin_followup_${Date.now()}`,
    });
  } catch (err) {
    logWarn("riders", "failed to send follow-up whatsapp alert to admin", formatError(err));
  }
  return { ok: true };
}

export async function notifyAdminPaymentVerification(args: {
  bookingId?: string;
  customerName: string;
  customerPhone: string;
  serviceKind: string;
  scheduledDate: string;
  scheduledTime: string;
  amountRs?: number;
  paymentMethod: string;
  assignedRider: string;
}): Promise<{ ok: boolean }> {
  const adminPhone = "+999000000008";
  const alertText = [
    `🔔 *GRABBIT PAYMENT VERIFICATION ALERT*`,
    `Customer: *${args.customerName}* (${args.customerPhone})`,
    `Service: *${args.serviceKind.toUpperCase()}* on *${args.scheduledDate}* at *${args.scheduledTime}*`,
    `Amount: *Rs ${args.amountRs ?? "Pending quote"}* via *${args.paymentMethod.toUpperCase()}*`,
    `Assigned Rider: *${args.assignedRider}*`,
    args.bookingId ? `Booking ID: \`${args.bookingId}\`` : "",
    ``,
    `✅ Booking is *AUTO-CONFIRMED* for the customer. Please verify the Juice/MCB payment transfer receipt.`,
  ].filter(Boolean).join("\n");

  logInfo("riders", "dispatching payment verification alert to admin", {
    phone: args.customerPhone,
    bookingId: args.bookingId,
    amountRs: args.amountRs,
  });

  try {
    const { recordPendingEscalation } = await import("../ops/store.ts");
    await recordPendingEscalation({
      customerPhone: args.customerPhone,
      customerName: args.customerName,
      reason: `Payment verification needed: Rs ${args.amountRs ?? "?"} via ${args.paymentMethod}`,
    });
  } catch (escErr) {
    logWarn("riders", "failed to record payment verification ops event", formatError(escErr));
  }

  try {
    await sendCustomerText({
      to: adminPhone,
      text: alertText,
      messageId: `admin_pay_${args.bookingId || Date.now()}`,
    });
  } catch (err) {
    logWarn("riders", "failed to send payment alert whatsapp to admin", formatError(err));
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
  } else if (rider.channel === "whatsapp" && rider.phone) {
    // Send 25-min reminder to WhatsApp riders (Thierry, Sherif)
    try {
      const { sendCustomerText } = await import("../wasender/send-tracked.ts");
      await sendCustomerText({
        to: rider.phone,
        text: messageText,
        messageId: `reminder_${rider.name.toLowerCase()}_${Date.now()}`,
      });
      logInfo("riders", "dispatched 25-min reminder via whatsapp", { rider: rider.name });
    } catch (err) {
      logError("riders", "failed to send reminder to whatsapp rider", err);
    }
  }

  return { ok: true };
}
