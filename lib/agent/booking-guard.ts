export type BookingFailureDetails = {
  error: string;
  code?: string | null;
  fieldErrors?: Record<string, string[]> | null;
};

function failureText(details: BookingFailureDetails | string): string {
  if (typeof details === "string") return details;

  const fieldBits = Object.entries(details.fieldErrors ?? {}).flatMap(
    ([field, messages]) => [field, ...(messages ?? [])],
  );
  return [details.error, details.code, ...fieldBits].filter(Boolean).join("\n");
}

/**
 * Safety net when Gemini ignores a failed book_kilo_delivery result.
 * Always ask for one concrete next step — never vague "missing detail".
 */
export function customerReplyForFailedBooking(
  details: BookingFailureDetails | string,
): string {
  const raw = failureText(details);
  const lower = raw.toLowerCase();
  const code =
    typeof details === "string"
      ? ""
      : (details.code ?? "").toLowerCase();
  const fields = Object.keys(
    typeof details === "string" ? {} : details.fieldErrors ?? {},
  ).map((key) => key.toLowerCase());

  // Internal Kilo image-host allowlist / CDN config — not the customer's fault.
  if (
    code === "image_host_rejected" ||
    lower.includes("image_host_rejected") ||
    lower.includes("allowed image host") ||
    lower.includes("image hosts configured") ||
    lower.includes("cdn/media hostname")
  ) {
    return "One sec, having a small hiccup placing this on our side. Please try again in a moment 💚";
  }

  if (
    code === "outside_service_hours" ||
    lower.includes("outside_service_hours") ||
    lower.includes("closed for on-demand") ||
    lower.includes("no rider in this slot")
  ) {
    const nextMatch = raw.match(
      /Next open slot today:\s*([^.]+)\./i,
    );
    const nextSlot = nextMatch?.[1]?.trim();
    if (nextSlot) {
      return `We’re outside rider hours right now. Next open window is ${nextSlot}. Want me to note this for the team for then? 💚`;
    }
    return "We’re outside rider hours right now, and there’s no open slot left today. Want me to note this for the team for the next available window? 💚";
  }

  if (
    fields.includes("packageimages") ||
    lower.includes("packageimages") ||
    lower.includes("package photo") ||
    lower.includes("reference photo") ||
    (/\bphotos?\b/.test(lower) && !lower.includes("image host"))
  ) {
    return "Almost there. Please send a clear photo of the order/package, then I’ll place it right away 💚";
  }

  if (
    fields.includes("errandlinks") ||
    lower.includes("errandlinks") ||
    lower.includes("errandmode=link") ||
    lower.includes("product link") ||
    lower.includes("shop/product link")
  ) {
    return "Almost there. Can you send the shop or product link so I can place this?";
  }

  const needLabel = lower.match(
    /need\s+([a-z0-9 /_-]{1,40})\s+for\s+(.+?)(?:\.|$)/i,
  );
  if (needLabel) {
    const label = needLabel[1]?.trim();
    const place = needLabel[2]?.trim().replace(/\.$/, "");
    if (label && place) {
      return `Almost there. What’s the ${label} for ${place}?`;
    }
  }

  if (
    lower.includes("pick a valid") ||
    lower.includes("unit") ||
    lower.includes("room") ||
    lower.includes("follow-up")
  ) {
    return "Almost there. What’s the room/unit for drop-off so I can place this?";
  }

  if (lower.includes("multiple service locations matched")) {
    return "A few places matched that name. Which exact one should I use?";
  }

  if (
    lower.includes("unknown service location") ||
    lower.includes("match a known place")
  ) {
    return "Which drop-off or pickup place should I use? You can send the name or a Maps pin.";
  }

  if (lower.includes("missing pickup") || lower.includes("pickup address")) {
    return "Where should we pick this up from? Shop name, landmark, or Maps pin works.";
  }

  if (
    lower.includes("missing dropoff") ||
    lower.includes("missing delivery") ||
    lower.includes("delivery address") ||
    lower.includes("dropoff address") ||
    lower.includes("drop-off")
  ) {
    return "Where should we deliver this? Place name, room/unit if needed, or a Maps pin.";
  }

  if (
    lower.includes("geocode") ||
    lower.includes("could not geocode") ||
    lower.includes("clearer pickup") ||
    lower.includes("clearer")
  ) {
    return "I couldn’t pin that location yet. Mind sending a clearer address or Google Maps pin?";
  }

  if (
    fields.includes("receiverphone") ||
    fields.includes("receivername") ||
    lower.includes("receiver name") ||
    lower.includes("receiver phone") ||
    lower.includes("need receiver")
  ) {
    return "Quick check: delivering to this WhatsApp number, right? If not, send the receiver’s name and number.";
  }

  if (lower.includes("warehouse")) {
    return "One sec, having a small hiccup on our side. Mind resending your confirmation and I’ll place it?";
  }

  if (
    lower.includes("not enabled") ||
    lower.includes("payment method") ||
    lower.includes("no errand modes")
  ) {
    return "That option isn’t available right now. Want me to help with a regular pickup and delivery instead?";
  }

  // Last resort: ask them to restate the order clearly — never “missing detail”.
  return "I couldn’t place that just yet. Please resend in one line: what to get, pickup place, and drop-off (with room/unit if needed) 🙂";
}

export function looksLikeFalseBookingSuccess(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(order|delivery|booking)\b/.test(lower) &&
    /\b(received|placed|booked|confirmed|on (its|the) way|rider assigned)\b/.test(
      lower,
    )
  );
}
