import { listAllPreBookings, type PreBooking } from "./pre-booking.ts";
import { readBookingFile } from "./booking-store.ts";
import { mauritiusDateIso } from "../time.ts";

export type CustomerDialogState =
  | "idle"
  | "awaiting_payment"
  | "active_trip";

export interface CustomerSessionContext {
  state: CustomerDialogState;
  activeBooking?: PreBooking;
}

export async function getCustomerSessionContext(phone: string): Promise<CustomerSessionContext> {
  const cleanPhone = phone.replace(/\D/g, "");
  const all = await listAllPreBookings();
  const todayIso = mauritiusDateIso(new Date());

  const activeSummary = all.slice().reverse().find((b) => {
    if (b.customerPhone.replace(/\D/g, "") !== cleanPhone) return false;
    if (b.status !== "confirmed" && b.status !== "pending_rider" && b.status !== "dispatched") return false;
    const bDate = (b.scheduledDate && b.scheduledDate !== "today" && b.scheduledDate !== "tomorrow")
      ? b.scheduledDate
      : (b.slotKey?.split("_")[0] || b.createdAt.slice(0, 10));
    return bDate >= todayIso;
  });

  if (!activeSummary) {
    return { state: "idle" };
  }

  const fullRecord = (await readBookingFile<PreBooking>(activeSummary.id)) || activeSummary;

  // If booking is waiting for payment proof (Juice transfer screenshot)
  const isAwaitingPaymentProof =
    fullRecord.serviceKind !== "trip" &&
    (!fullRecord.paymentMethod || fullRecord.paymentMethod === "juice") &&
    fullRecord.paymentMethod !== "transfer" &&
    fullRecord.paymentMethod !== "cash";

  return {
    state: isAwaitingPaymentProof ? "awaiting_payment" : "active_trip",
    activeBooking: fullRecord,
  };
}
