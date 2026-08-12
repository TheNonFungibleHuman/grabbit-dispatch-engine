export function statusMessageForCustomer(args: {
  event: string;
  status?: string;
  accessCode?: string;
  deliveryId?: string;
  /** From `delivery.otp_issued` → `data.otp.code` only */
  otpCode?: string;
  customerMessageHint?: string;
}): string {
  const status = (args.status ?? "").toLowerCase();
  const event = args.event.toLowerCase();

  if (event.includes("otp_issued") || args.otpCode) {
    const code = args.otpCode?.trim();
    if (!code) {
      return "Your delivery verification code is ready. Reply here if you need help.";
    }
    const idBit = args.deliveryId ? ` for ${args.deliveryId}` : "";
    return [
      `Your Grabbit delivery code${idBit} is *${code}*.`,
      "Share this code with the rider when they arrive to confirm handover.",
      "Do not share it in a public group.",
    ].join(" ");
  }

  if (event.includes("cancelled") || status.includes("cancel")) {
    return "Update: your Grabbit delivery was cancelled. Reply here if you want to book again.";
  }

  if (event.includes("completed") || status.includes("completed")) {
    return "Your delivery is complete. Thanks for choosing Grabbit Express.";
  }

  if (
    status.includes("nearby") ||
    status.includes("arrived") ||
    status.includes("at_dropoff")
  ) {
    return "Your rider is nearby / has arrived. Please be ready.";
  }

  if (
    status.includes("picked") ||
    status.includes("pickup") ||
    status.includes("in_transit") ||
    status.includes("en_route")
  ) {
    return "Your order has been picked up and is on the way.";
  }

  if (
    status.includes("matched") ||
    status.includes("assigned") ||
    status.includes("accepted")
  ) {
    return "A rider has been assigned to your delivery. We’ll keep you posted.";
  }

  if (event.includes("created") || status.includes("pending")) {
    const code = args.accessCode ? ` Code: *${args.accessCode}*` : "";
    return `Delivery booked${code}. We’ll update you here as it moves.`;
  }

  if (args.customerMessageHint?.trim()) {
    return args.customerMessageHint.trim();
  }

  if (status) {
    return `Delivery update: ${status.replaceAll("_", " ")}. We’ll keep you posted.`;
  }

  return "Quick update on your Grabbit delivery. We’ll keep you posted.";
}
