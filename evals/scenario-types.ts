/**
 * Eval scenario format.
 *
 * A scenario is a deterministic replay of a real (or synthetic) conversation
 * turn, asserting on the *pure* decision layer — no network, no LLM, no
 * storage externalities. Scenarios run in the same in-memory store mode as
 * the unit-test suite (SUPABASE_URL / BLOB_READ_WRITE_TOKEN unset).
 */

/** Matcher applied to a string artifact produced by a turn. */
export type TextMatcher =
  | { contains: string }
  | { notContains: string }
  | { matches: string } // RegExp source, case-insensitive
  | { equals: string };

export interface BookingSeed {
  customerName: string;
  customerPhone: string;
  serviceKind?: string;
  tripType?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
  scheduledDate: string;
  scheduledTime: string;
  assignedRider?: string;
  status?: string;
  paymentMethod?: string;
  fareAmount?: number;
}

export interface ScenarioTurn {
  /** Free-text description shown in the report. */
  label: string;
  /** The deterministic action to invoke. */
  action:
    | "customerDateLabel"
    | "isBareGreeting"
    | "isContentFreeMessage"
    | "isShortAcknowledgement"
    | "sanitizeWhatsAppText"
    | "resolveRelativeDateWord"
    | "evaluateSlotRules"
    | "textSimilarity"
    | "isNearDuplicateRecentReply"
    | "isDistinctShortReply"
    | "isIdenticalRecentReply"
    | "normalizeReplyText"
    | "routeCustomerMessage";
  /** Primary input (meaning depends on action). */
  input?: string;
  /** Secondary input (e.g. `previous` text for similarity guards). */
  previous?: string;
  /** Age of the `previous` message relative to `now` (ms). Defaults to 0 (same instant). */
  previousAgeMs?: number;
  /** Prior conversation entries for the router action: [text, minutesAgo][]. */
  history?: Array<[string, number]>;
  /** Time context for date-sensitive actions. */
  now?: string; // ISO instant
  dateIso?: string;
  /** Slot-rule inputs. */
  booking?: Partial<BookingSeed>;
  existing?: Array<Partial<BookingSeed>>;
  /** Assertions on the result. */
  expect: {
    /** Expected primitive result (string/boolean/number), if applicable. */
    result?: unknown;
    /** Text matchers applied to the string form of the result. */
    text?: TextMatcher[];
  };
}

export interface Scenario {
  id: string;
  title: string;
  /** Traceability: which incident/audit this guards. */
  incident?: string;
  turns: ScenarioTurn[];
}
