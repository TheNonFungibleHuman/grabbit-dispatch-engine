export interface FareQuote {
  amountRs: number;
  roundTrip: boolean;
  zone: string;
  matched: boolean;
}

interface TripZoneFare {
  zone: string;
  keywords: string[];
  oneWayRs: number;
  roundTripRs: number;
}

const TRIP_ZONES: TripZoneFare[] = [
  { zone: "Calebasses", keywords: ["calebasse", "calabasse"], oneWayRs: 130, roundTripRs: 260 },
  { zone: "Pamplemousses Garden", keywords: ["pamplemousses garden", "pamplemousse garden", "botanical garden"], oneWayRs: 50, roundTripRs: 100 },
  { zone: "Grand Baie", keywords: ["grand baie", "grand-baie"], oneWayRs: 50, roundTripRs: 100 },
  { zone: "SSRN Hospital", keywords: ["ssrn", "hospital"], oneWayRs: 40, roundTripRs: 80 },
  { zone: "Mahogany", keywords: ["mahogany"], oneWayRs: 40, roundTripRs: 80 },
  { zone: "Pamplemousses Town", keywords: ["pamplemousses", "pamplemousse"], oneWayRs: 100, roundTripRs: 200 },
];

const DELIVERY_FEE_PAMPLEMOUSSES_RS = 200;
const DELIVERY_FEE_DEFAULT_RS = 100;

function normalizeFareText(text?: string | null): string {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function quoteTripFare(destinationText: string, tripType?: "one_way" | "round_trip"): FareQuote | null {
  const haystack = normalizeFareText(destinationText);
  if (!haystack) return null;

  for (const zone of TRIP_ZONES) {
    if (zone.keywords.some((k) => haystack.includes(k))) {
      const roundTrip = tripType === "round_trip";
      return {
        amountRs: roundTrip ? zone.roundTripRs : zone.oneWayRs,
        roundTrip,
        zone: zone.zone,
        matched: true,
      };
    }
  }
  return null;
}

export function quoteDeliveryFee(pickupText?: string, deliveryText?: string): number {
  const combined = `${normalizeFareText(pickupText)} ${normalizeFareText(deliveryText)}`;
  if (combined.includes("pamplemousses") || combined.includes("pamplemousse")) {
    return DELIVERY_FEE_PAMPLEMOUSSES_RS;
  }
  return DELIVERY_FEE_DEFAULT_RS;
}

interface FareEstimateInput {
  serviceKind?: string;
  tripType?: string;
  packageDescription?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
}

export function estimateBookingFare(booking: FareEstimateInput): number {
  const desc = (booking.packageDescription || "").toLowerCase();
  const route = `${booking.pickupAddress || ""} ${booking.deliveryAddress || ""}`.toLowerCase();
  const isTrip = booking.serviceKind === "trip" || desc.includes("passenger") || desc.includes("trip") || desc.includes("ride");
  const isRound = booking.tripType === "round_trip" || desc.includes("round");

  if (isTrip) {
    const quote = quoteTripFare(route, isRound ? "round_trip" : "one_way");
    if (quote) return quote.amountRs;
    return isRound ? 80 : 40;
  }

  return quoteDeliveryFee(booking.pickupAddress, booking.deliveryAddress);
}

export function formatFareTableForPrompt(): string {
  const trips = TRIP_ZONES.map((z) => {
    const label =
      z.zone === "Grand Baie"
        ? "Grand Baie Express bus / Grand Baie"
        : z.zone === "Calebasses"
          ? "Calebasses / Calabasses"
          : z.zone;
    return `${label}: Rs ${z.oneWayRs} (Round: Rs ${z.roundTripRs})`;
  }).join(" | ");
  return [
    `- Delivery Fees (fixed by system): Mahogany / ALCHE: Rs ${DELIVERY_FEE_DEFAULT_RS} | Pamplemousses: Rs ${DELIVERY_FEE_PAMPLEMOUSSES_RS}.`,
    `- Trip Fares (fixed by system): ${trips}.`,
  ].join("\n");
}
