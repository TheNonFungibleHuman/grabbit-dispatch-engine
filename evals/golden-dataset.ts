import type { Scenario } from "./scenario-types.ts";

/**
 * Golden dataset — deterministic regression scenarios.
 * Each scenario is traceable to a production incident, a HANDOFF phase, or a shipped fix.
 * Time-dependent scenarios pin `now` to a fixed instant so they are deterministic.
 */

const FRI_AM = "2026-09-18T06:00:00.000Z"; // Fri 18 Sept 10:00 MUT
const FRI_LATE_UTC = "2026-09-18T21:30:00.000Z"; // Sat 19 Sept 01:30 MUT
const WED = "2026-09-30T06:00:00.000Z"; // Wed 30 Sept

const CONFIRM_CARD = "Your passenger trip for today at 4:00 pm is confirmed and assigned to rider Thierry! Fare: Rs 150.";

const DATE_LABEL_SCENARIOS: Scenario[] = [
  { id: "date-label-today", title: "Same-day booking says 'today'", incident: "fix(b)", turns: [
    { label: "today's ISO resolves to 'today'", action: "customerDateLabel", dateIso: "2026-09-18", now: FRI_AM, expect: { result: "today" } },
  ] },
  { id: "date-label-tomorrow", title: "Next-day booking restates weekday and date", incident: "fix(b)", turns: [
    { label: "tomorrow restated", action: "customerDateLabel", dateIso: "2026-09-19", now: FRI_AM, expect: { result: "tomorrow, Saturday 19 Sept" } },
  ] },
  { id: "date-label-utc-boundary", title: "'tomorrow' decided on Mauritius midnight, not UTC", incident: "HANDOFF phase 3", turns: [
    { label: "after MU midnight, yesterday's UTC date is 'today'", action: "customerDateLabel", dateIso: "2026-09-19", now: FRI_LATE_UTC, expect: { result: "today" } },
    { label: "next MU day is 'tomorrow'", action: "customerDateLabel", dateIso: "2026-09-20", now: FRI_LATE_UTC, expect: { result: "tomorrow, Sunday 20 Sept" } },
  ] },
  { id: "date-label-future", title: "Beyond tomorrow gets plain weekday + date", incident: "fix(b)", turns: [
    { label: "Monday 21 Sept", action: "customerDateLabel", dateIso: "2026-09-21", now: FRI_AM, expect: { result: "Monday 21 Sept" } },
  ] },
  { id: "date-label-month-crossing", title: "Month boundary crosses safely", incident: "fix(b)", turns: [
    { label: "Sept 30 -> Oct 1", action: "customerDateLabel", dateIso: "2026-10-01", now: WED, expect: { result: "tomorrow, Thursday 1 Oct" } },
  ] },
  { id: "date-label-malformed", title: "Malformed date falls back to raw string", incident: "fix(b)", turns: [
    { label: "non-ISO passes through", action: "customerDateLabel", dateIso: "not-a-date", now: FRI_AM, expect: { result: "not-a-date" } },
  ] },
];

const DUP_CARD_SCENARIOS: Scenario[] = [
  { id: "dup-card-paraphrase", title: "Paraphrased confirmation card within 10s is suppressed", incident: "fix(c)", turns: [
    { label: "near-duplicate guard fires", action: "isNearDuplicateRecentReply", input: "Great news! Your passenger trip for today at 4:00 pm is confirmed with rider Thierry. Fare is Rs 150!", previous: CONFIRM_CARD, now: FRI_AM, expect: { result: true } },
  ] },
  { id: "dup-card-window-expiry", title: "Near-duplicate allowed after the 10s window", incident: "fix(c)", turns: [
    { label: "11s later, same text allowed", action: "isNearDuplicateRecentReply", input: "Your trip is confirmed with rider Thierry for today at 4 pm.", previous: "Your trip is confirmed with rider Thierry for today at 4 pm.", now: FRI_AM, previousAgeMs: 11_000, expect: { result: false } },
  ] },
  { id: "dup-card-short-ack-protected", title: "Short deterministic acks never suppressed", incident: "fix(c)", turns: [
    { label: "payment ack is distinct", action: "isDistinctShortReply", input: "Noted, payment in cash! Have a great ride 🛵⚡", previous: CONFIRM_CARD, expect: { result: true } },
    { label: "urgency ack is distinct", action: "isDistinctShortReply", input: "Already locked in for you! See you soon! 🛵⚡", previous: CONFIRM_CARD, expect: { result: true } },
  ] },
  { id: "dup-card-long-distinct", title: "Genuinely different long message is not a near-duplicate", incident: "fix(c)", turns: [
    { label: "weekly summary vs confirmation card", action: "isNearDuplicateRecentReply", input: "Your weekly summary: 12 trips completed this week across Grand Baie and Pamplemousses with total revenue of Rs 2,400.", previous: CONFIRM_CARD, now: FRI_AM, expect: { result: false } },
  ] },
  { id: "dup-card-token-floor", title: "Below the 8-token floor never near-duplicates", incident: "fix(c)", turns: [
    { label: "short text ignored", action: "isNearDuplicateRecentReply", input: "trip confirmed rider Thierry today", previous: "trip confirmed rider Thierry today", now: FRI_AM, expect: { result: false } },
  ] },
];

const GUARD_SCENARIOS: Scenario[] = [
  { id: "content-free-guard", title: "Content-free messages never trigger a full reply", incident: "Incident A — Pacifique '…'", turns: [
    { label: "bare ellipsis is content-free", action: "isContentFreeMessage", input: "…", expect: { result: true } },
    { label: "emoji-only is content-free", action: "isContentFreeMessage", input: "👍😊", expect: { result: true } },
    { label: "real booking request is NOT content-free", action: "isContentFreeMessage", input: "Is possible to get a trip to ssrn now", expect: { result: false } },
  ] },
  { id: "greeting-vs-intent", title: "Bare greetings separated from booking intent", incident: "Incident B — Uwase 8:45", turns: [
    { label: "'Hello' is a bare greeting", action: "isBareGreeting", input: "Hello", expect: { result: true } },
    { label: "booking request is NOT a bare greeting", action: "isBareGreeting", input: "I need a ride to Grand Baie at 2pm", expect: { result: false } },
  ] },
  { id: "short-ack-guard", title: "Short acks recognised for the burst guard", incident: "HANDOFF — post-booking acks", turns: [
    { label: "'thanks' is a short ack", action: "isShortAcknowledgement", input: "thanks", expect: { result: true } },
    { label: "'cash' is NOT a short ack (it is a payment-method answer mid-order)", action: "isShortAcknowledgement", input: "cash", expect: { result: false } },
    { label: "full question is NOT a short ack", action: "isShortAcknowledgement", input: "What time is my rider arriving tomorrow morning?", expect: { result: false } },
  ] },
  { id: "sanitizer-thought-leak", title: "Thought/self-talk leaks stripped before sending", incident: "AGENTS.md rule 4", turns: [
    { label: "'Thinking:' prefix removed", action: "sanitizeWhatsAppText", input: "Thinking: I should greet Oliver warmly.\nHello Oliver! Your trip is confirmed.", expect: { text: [{ notContains: "Thinking:" }, { contains: "Hello Oliver!" }] } },
    { label: "'[Today ...] Support:' prefix removed", action: "sanitizeWhatsAppText", input: "[Today is Friday 18 Sept] Support: Hello! How can I help?", expect: { text: [{ notContains: "Support:" }, { contains: "How can I help" }] } },
  ] },
];

// Router scenarios omit `now` — the router's freshness guard uses real Date.now().
const ROUTER_SCENARIOS: Scenario[] = [
  { id: "router-no-intake-falls-through", title: "Router falls through when no intake exists", incident: "Phase 3", turns: [
    { label: "bare greeting has no slots", action: "routeCustomerMessage", input: "Hello", history: [["Hello", 0]], expect: { text: [{ matches: "^intake_incomplete" }] } },
  ] },
  { id: "router-single-slot-ask", title: "Router answers a single missing slot with zero tokens", incident: "Phase 3", turns: [
    { label: "payment missing -> targeted ask", action: "routeCustomerMessage", input: "tomorrow at 8:15 am", history: [["I need a ride from ALCHE Campus to Mahogany tomorrow at 8:15 am", 3]], expect: { result: "ask_slot:paymentMethod", text: [{ matches: "cash|juice" }] } },
  ] },
  { id: "router-all-slots-arms-booking", title: "Fresh fully-specified conversation reports all_slots_present", incident: "Phase 3", turns: [
    { label: "all slots fresh", action: "routeCustomerMessage", input: "yes book it", history: [["I need a ride from ALCHE Campus to Mahogany at 2:30 pm, cash", 2]], expect: { result: "all_slots_present" } },
  ] },
  { id: "router-stale-intake-refused", title: "Stale intake (2h old) never arms auto-booking", incident: "Phase 3 — freshness guard", turns: [
    { label: "2h-old slots are stale", action: "routeCustomerMessage", input: "yes", history: [["I need a ride from ALCHE Campus to Mahogany at 2:30 pm, cash", 120]], expect: { result: "intake_stale" } },
  ] },
];

export const GOLDEN_DATASET: Scenario[] = [
  ...DATE_LABEL_SCENARIOS,
  ...DUP_CARD_SCENARIOS,
  ...GUARD_SCENARIOS,
  ...ROUTER_SCENARIOS,
];
