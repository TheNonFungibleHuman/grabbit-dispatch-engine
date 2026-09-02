import { listAllPreBookings, type PreBooking } from "./pre-booking.ts";
import { readJson, listJsonPaths } from "../blob/json-store.ts";
import { getSupabaseClient } from "../supabase/client.ts";
import { logInfo, logWarn, formatError } from "../log.ts";

export interface ResolvedCustomer {
  phone: string; // E.164 digits without leading +, e.g. "99900000054"
  formattedPhone: string; // E.164 with +, e.g. "+99900000054"
  name: string;
  activeBooking?: PreBooking;
}

/**
 * Normalizes phone numbers to standard Mauritian/International E.164.
 * If 8 digits (standard Mauritius mobile 5XXXXXXX), auto-prepends 230.
 */
export function normalizeCustomerPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  // 8 digits starting with 5 (Mauritius mobile) -> 2305XXXXXXX
  if (digits.length === 8 && digits.startsWith("5")) {
    return `230${digits}`;
  }
  // 7 digits starting with 5 -> 2305... (rare edge)
  if (digits.length === 7 && digits.startsWith("5")) {
    return `230${digits}`;
  }
  return digits;
}

/**
 * Comprehensive multi-source customer resolver.
 * Searches:
 * 1. Direct phone normalization (Mauritius +230)
 * 2. Active & historical pre-bookings (by customerName or customerPhone)
 * 3. Customer profile records (grabbit/customers/.../profile.json)
 * 4. Supabase grabbit_documents transcript paths
 */
export async function resolveCustomerIdentity(
  query: string,
): Promise<ResolvedCustomer | null> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return null;

  const normalizedDigits = normalizeCustomerPhone(cleanQuery);

  // 1. Check if the query is already a valid phone number (>= 8 digits)
  if (normalizedDigits.length >= 8 && /^\d+$/.test(normalizedDigits)) {
    const allBookings = await listAllPreBookings();
    const matchedBooking = allBookings.find(
      (b) => normalizeCustomerPhone(b.customerPhone) === normalizedDigits,
    );
    const name = matchedBooking?.customerName || cleanQuery;
    return {
      phone: normalizedDigits,
      formattedPhone: `+${normalizedDigits}`,
      name,
      activeBooking: matchedBooking,
    };
  }

  const queryLower = cleanQuery.toLowerCase();

  // 2. Search all pre-bookings by customerName or phone substring
  try {
    const allBookings = await listAllPreBookings();
    
    // Sort latest updated first
    const sorted = [...allBookings].sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime(),
    );

    // Exact name match
    let match = sorted.find(
      (b) => b.customerName?.toLowerCase() === queryLower,
    );

    // Substring / word match (e.g. "Customer B", "Customer D", "Customer A", "Customer F")
    if (!match) {
      match = sorted.find((b) => {
        const cName = (b.customerName || "").toLowerCase();
        return (
          cName.includes(queryLower) ||
          queryLower.includes(cName) ||
          (cName.split(/\s+/).some((part) => part.length >= 3 && queryLower.includes(part)))
        );
      });
    }

    if (match && match.customerPhone) {
      const p = normalizeCustomerPhone(match.customerPhone);
      if (p.length >= 7) {
        return {
          phone: p,
          formattedPhone: `+${p}`,
          name: match.customerName || cleanQuery,
          activeBooking: match,
        };
      }
    }
  } catch (err) {
    logWarn("resolver", "pre-bookings search failed", formatError(err));
  }

  // 3. Search customer profiles in persistent JSON store
  try {
    const profilePaths = await listJsonPaths("grabbit/customers/");
    for (const p of profilePaths) {
      if (!p.endsWith("/profile.json")) continue;
      const prof = await readJson<{ name?: string; senderPhone?: string }>(p);
      if (prof?.name) {
        const profNameLower = prof.name.toLowerCase();
        if (
          profNameLower.includes(queryLower) ||
          queryLower.includes(profNameLower) ||
          profNameLower.split(/\s+/).some((part) => part.length >= 3 && queryLower.includes(part))
        ) {
          const phoneFromPath = p.replace("grabbit/customers/", "").replace("/profile.json", "");
          const phone = normalizeCustomerPhone(prof.senderPhone || phoneFromPath);
          if (phone.length >= 7) {
            return {
              phone,
              formattedPhone: `+${phone}`,
              name: prof.name,
            };
          }
        }
      }
    }
  } catch (err) {
    logWarn("resolver", "customer profiles search failed", formatError(err));
  }

  // 4. Search Supabase grabbit_documents for transcript matches
  const supabase = getSupabaseClient();
  if (supabase) {
    try {
      const { data } = await supabase
        .from("grabbit_documents")
        .select("pathname, data")
        .like("pathname", "grabbit/sessions/%/transcript.json")
        .limit(50);

      for (const row of data || []) {
        const phone = row.pathname.replace("grabbit/sessions/", "").replace("/transcript.json", "");
        const entries = (row.data as { entries?: Array<{ text: string }> })?.entries || [];
        if (
          entries.some((e) =>
            e.text.toLowerCase().includes(queryLower),
          )
        ) {
          const normPhone = normalizeCustomerPhone(phone);
          if (normPhone.length >= 7) {
            return {
              phone: normPhone,
              formattedPhone: `+${normPhone}`,
              name: cleanQuery,
            };
          }
        }
      }
    } catch (err) {
      logWarn("resolver", "supabase transcript search failed", formatError(err));
    }
  }

  return null;
}
