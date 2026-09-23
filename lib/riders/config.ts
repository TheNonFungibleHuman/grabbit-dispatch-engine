export interface RiderProfile {
  id: string;
  name: string;
  aliases: string[];
  kiloRiderId: string;
  phone?: string;
  email?: string;
  channel: "whatsapp" | "email" | "google_chat";
}

// ── PII policy (Phase 6) ──────────────────────────────────────────────────
// Rider phone numbers, Kilo rider UUIDs, and the payment account details are
// personal data. They are read from env first; the literals below are a
// FALLBACK so the fleet keeps running until the matching env vars are set on
// Vercel. Once GRABBIT_* env vars are set, delete the fallbacks.
let warnedPiiFallback = false;
function warnPiiFallbackOnce(): void {
  if (warnedPiiFallback) return;
  warnedPiiFallback = true;
  console.warn(
    "[config] PII env vars not set — using in-source fallback values. Set GRABBIT_RIDER_* / GRABBIT_ADMIN_PHONES / GRABBIT_PAYMENT_ACCOUNTS to remove PII from source.",
  );
}

export const FLEET_RIDERS: RiderProfile[] = [
  {
    id: "thierry",
    name: "Thierry",
    aliases: ["thierry", "thierry(delivery)"],
    kiloRiderId: process.env.GRABBIT_RIDER_THIERRY_KILO_ID || "00000000-0000-0000-0000-0000000000a1",
    phone: process.env.GRABBIT_RIDER_THIERRY_PHONE || "+999000000009",
    channel: "whatsapp",
  },
  {
    id: "sherif",
    name: "Sherif",
    aliases: ["sherif", "sherif deen"],
    kiloRiderId: process.env.GRABBIT_RIDER_SHERIF_KILO_ID || "00000000-0000-0000-0000-0000000000a2",
    phone: process.env.GRABBIT_RIDER_SHERIF_PHONE || "+999000000008",
    channel: "whatsapp",
  },
  {
    id: "moses",
    name: "Moses",
    aliases: ["moses", "moses kolaan"],
    kiloRiderId: process.env.GRABBIT_RIDER_MOSES_KILO_ID || "00000000-0000-0000-0000-0000000000a3",
    phone: process.env.GRABBIT_RIDER_MOSES_PHONE || "+999000000007",
    email: process.env.GRABBIT_RIDER_MOSES_EMAIL || "rider.three@example.com",
    // Primary delivery is now WhatsApp; Google Chat remains as a mirror for
    // full dispatch-team visibility (notification senders always post there).
    channel: "whatsapp",
  },
];
if (!process.env.GRABBIT_RIDER_THIERRY_KILO_ID) warnPiiFallbackOnce();

export function findRiderByName(name: string): RiderProfile | null {
  const query = name.trim().toLowerCase();
  for (const rider of FLEET_RIDERS) {
    if (
      rider.name.toLowerCase() === query ||
      rider.aliases.some((alias) => query.includes(alias) || alias.includes(query))
    ) {
      return rider;
    }
  }
  return null;
}

export function findRiderByPhone(identifier: string): RiderProfile | null {
  const clean = identifier.trim().toLowerCase();
  const cleanPhone = identifier.replace(/\D/g, "");
  const testPhone = process.env.TEST_RIDER_PHONE?.replace(/\D/g, "");
  if (testPhone && cleanPhone === testPhone) {
    return FLEET_RIDERS[0]; // Thierry as default test rider profile
  }
  for (const rider of FLEET_RIDERS) {
    if (rider.phone && cleanPhone.length > 5 && rider.phone.replace(/\D/g, "") === cleanPhone) {
      return rider;
    }
    if (rider.email && rider.email.toLowerCase() === clean) {
      return rider;
    }
    if (rider.id.toLowerCase() === clean || rider.name.toLowerCase() === clean) {
      return rider;
    }
  }
  return null;
}

export const ADMIN_PHONES = (
  process.env.GRABBIT_ADMIN_PHONES?.trim() ||
  "+999000000008,+9990000000003"
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .concat(process.env.ADMIN_PHONE?.trim() ? [process.env.ADMIN_PHONE.trim()] : []);

export function isAuthorizedRiderOrAdmin(identifier?: string): {
  isAuthorized: boolean;
  isAdmin: boolean;
  rider: RiderProfile | null;
} {
  if (!identifier) {
    return {
      isAuthorized: false,
      isAdmin: false,
      rider: null,
    };
  }
  const cleanPhone = identifier.replace(/\D/g, "");
  const isAdmin = ADMIN_PHONES.some((p) => p.replace(/\D/g, "") === cleanPhone && cleanPhone.length > 5);
  const rider = findRiderByPhone(identifier);
  return {
    isAuthorized: Boolean(isAdmin || rider),
    isAdmin,
    rider,
  };
}

export function getCustomTrackingUrl(deliveryId: string, accessCode?: string | null): string {
  // Custom tracking URL format: https://delivery.grabbit-express.com/track/{deliveryId}/{accessCode}
  const base = (
    process.env.TRACKING_URL_BASE?.trim() || "https://delivery.grabbit-express.com/track"
  ).replace(/\/+$/, "");

  const id = deliveryId?.trim();
  const code = accessCode?.trim();

  if (id && code) {
    return `${base}/${id}/${code}`;
  }
  return `${base}/${id || code}`;
}
