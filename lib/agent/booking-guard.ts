/**
 * Safety net when Gemini ignores a failed book_kilo_delivery result.
 */
export function customerReplyForFailedBooking(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes("photo") || lower.includes("packageimages")) {
    return "Almost there. Please send a clear photo of the order/package first, then I’ll place it right away 💚";
  }

  if (lower.includes("errandlinks") || lower.includes("link")) {
    return "Almost there. Can you send the shop/product link so I can place this?";
  }

  if (
    lower.includes("unit") ||
    lower.includes("room") ||
    lower.includes("follow-up")
  ) {
    return "Almost there. What’s the room/unit for drop-off so I can place this?";
  }

  if (lower.includes("geocode") || lower.includes("address")) {
    return "Almost there. Could you share a clearer pickup or drop-off location (or a Maps pin)?";
  }

  return "I couldn’t place that just yet. Mind sending the missing detail and I’ll sort it right away 💚";
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
