export interface RiderProfile {
  id: string;
  name: string;
  aliases: string[];
  kiloRiderId: string;
  phone?: string;
  email?: string;
  channel: "whatsapp" | "email" | "google_chat";
}

export const FLEET_RIDERS: RiderProfile[] = [
  {
    id: "thierry",
    name: "Thierry",
    aliases: ["thierry", "thierry(delivery)"],
    kiloRiderId: "00000000-0000-0000-0000-0000000000a1",
    phone: "+999000000009",
    channel: "whatsapp",
  },
  {
    id: "sherif",
    name: "Sherif",
    aliases: ["sherif", "sherif deen"],
    kiloRiderId: "00000000-0000-0000-0000-0000000000a2",
    phone: "+999000000008",
    channel: "whatsapp",
  },
  {
    id: "moses",
    name: "Moses",
    aliases: ["moses", "moses kolaan"],
    kiloRiderId: "00000000-0000-0000-0000-0000000000a3",
    email: "rider.three@example.com",
    channel: "google_chat",
  },
];

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

export function findRiderByPhone(phone: string): RiderProfile | null {
  const cleanPhone = phone.replace(/\D/g, "");
  const testPhone = process.env.TEST_RIDER_PHONE?.replace(/\D/g, "");
  if (testPhone && cleanPhone === testPhone) {
    return FLEET_RIDERS[0]; // Thierry as default test rider profile
  }
  for (const rider of FLEET_RIDERS) {
    if (rider.phone && rider.phone.replace(/\D/g, "") === cleanPhone) {
      return rider;
    }
  }
  return null;
}

export const ADMIN_PHONES = [
  "+999000000008",
  "+9990000000003",
  process.env.ADMIN_PHONE,
].filter(Boolean) as string[];

export function isAuthorizedRiderOrAdmin(phone: string): {
  isAuthorized: boolean;
  isAdmin: boolean;
  rider: RiderProfile | null;
} {
  const cleanPhone = phone.replace(/\D/g, "");
  const isAdmin = ADMIN_PHONES.some((p) => p.replace(/\D/g, "") === cleanPhone);
  const rider = findRiderByPhone(phone);
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
