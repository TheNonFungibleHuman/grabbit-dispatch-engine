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
  const rawClean = query.trim();
  if (!rawClean) return null;

  // Clean quotes, @ handles, and trailing possessives (e.g. "@Customer A" -> "Customer A", "Customer A's" -> "Customer A")
  const cleanQuery = rawClean
    .replace(/^[@"']+|["']+$/g, "")
    .replace(/'s$/i, "")
    .trim();
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

  // 1.5. Search pending escalations (highest priority for admin relay — admin is often replying to an escalated customer)
  try {
    const { loadEscalations } = await import("../ops/store.ts");
    const escalations = await loadEscalations();
    if (escalations && escalations.length > 0) {
      // Sort open escalations first, then newest first
      const sortedEsc = [...escalations].sort((a, b) => {
        if (a.status === "open" && b.status !== "open") return -1;
        if (b.status === "open" && a.status !== "open") return 1;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });

      // Special keywords like "customer", "active_customer", "latest", "her", "him", "them"
      if (
        queryLower === "active_customer" ||
        queryLower === "customer" ||
        queryLower === "the customer" ||
        queryLower === "latest" ||
        queryLower === "her" ||
        queryLower === "him" ||
        queryLower === "them"
      ) {
        const open = sortedEsc.find((e) => e.status === "open") || sortedEsc[0];
        if (open) {
          const p = normalizeCustomerPhone(open.customerPhone);
          if (p.length >= 7) {
            return {
              phone: p,
              formattedPhone: `+${p}`,
              name: open.customerName || cleanQuery,
            };
          }
        }
      }

      // Exact name match or phone match in escalations
      let escMatch = sortedEsc.find(
        (e) => (e.customerName || "").toLowerCase() === queryLower,
      );

      // Substring match in customerName
      if (!escMatch) {
        escMatch = sortedEsc.find((e) => {
          const eName = (e.customerName || "").toLowerCase();
          return (
            eName.includes(queryLower) ||
            queryLower.includes(eName) ||
            eName.split(/\s+/).some((part) => part.length >= 3 && queryLower.includes(part))
          );
        });
      }

      if (escMatch && escMatch.customerPhone) {
        const p = normalizeCustomerPhone(escMatch.customerPhone);
        if (p.length >= 7) {
          return {
            phone: p,
            formattedPhone: `+${p}`,
            name: escMatch.customerName || cleanQuery,
          };
        }
      }
    }
  } catch (err) {
    logWarn("resolver", "escalations search failed", formatError(err));
  }

  // 2. Search all pre-bookings by customerName or phone substring
  try {
    const allBookings = await listAllPreBookings();
    
    // Sort latest updated first
    const sorted = [...allBookings].sort(
      (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime(),
    );

    // Support generic customer keywords pointing to the most recent active booking
    if (
      queryLower === "active_customer" ||
      queryLower === "customer" ||
      queryLower === "the customer" ||
      queryLower === "latest" ||
      queryLower === "her" ||
      queryLower === "him" ||
      queryLower === "them"
    ) {
      const active = sorted.find((b) => b.status === "pending_rider" || b.status === "confirmed" || b.status === "dispatched") || sorted[0];
      if (active && active.customerPhone) {
        const p = normalizeCustomerPhone(active.customerPhone);
        if (p.length >= 7) {
          return {
            phone: p,
            formattedPhone: `+${p}`,
            name: active.customerName || cleanQuery,
            activeBooking: active,
          };
        }
      }
    }

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

  // 3.5. Search session transcripts in persistent JSON store (grabbit/sessions/.../transcript.json)
  try {
    const sessionPaths = await listJsonPaths("grabbit/sessions/");
    for (const p of sessionPaths) {
      if (!p.endsWith("/transcript.json")) continue;
      const transcript = await readJson<{
        customerName?: string;
        senderPhone?: string;
        entries?: Array<{ text?: string }>;
      }>(p);
      const phoneFromPath = p.replace("grabbit/sessions/", "").replace("/transcript.json", "");
      const phone = normalizeCustomerPhone(transcript?.senderPhone || phoneFromPath);
      if (phone.length < 7) continue;

      // Check customerName on transcript
      if (transcript?.customerName) {
        const tNameLower = transcript.customerName.toLowerCase();
        if (
          tNameLower.includes(queryLower) ||
          queryLower.includes(tNameLower) ||
          tNameLower.split(/\s+/).some((part) => part.length >= 3 && queryLower.includes(part))
        ) {
          return {
            phone,
            formattedPhone: `+${phone}`,
            name: transcript.customerName,
          };
        }
      }

      // Check self-identification in transcript entries
      if (transcript?.entries && Array.isArray(transcript.entries)) {
        for (const entry of transcript.entries) {
          if (!entry.text) continue;
          const textLower = entry.text.toLowerCase();
          if (
            textLower.includes(`name is ${queryLower}`) ||
            textLower.includes(`i'm ${queryLower}`) ||
            textLower.includes(`i am ${queryLower}`) ||
            textLower.includes(`this is ${queryLower}`)
          ) {
            return {
              phone,
              formattedPhone: `+${phone}`,
              name: cleanQuery,
            };
          }
        }
      }
    }
  } catch (err) {
    logWarn("resolver", "session transcripts search failed", formatError(err));
  }

  // 3.8. Search recent chat threads in Ops State
  try {
    const { getOpsDashboard } = await import("../ops/store.ts");
    const ops = await getOpsDashboard();
    const threads = Object.values(ops.state.threads || {});
    for (const t of threads) {
      const recentPreviews = (t.recent || []).map((r) => r.preview || "").join(" ").toLowerCase();
      if (recentPreviews.includes(queryLower)) {
        const normPhone = normalizeCustomerPhone(t.phone);
        if (normPhone.length >= 7) {
          return {
            phone: normPhone,
            formattedPhone: `+${normPhone}`,
            name: cleanQuery,
          };
        }
      }
    }
  } catch {
    // Non-blocking
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
