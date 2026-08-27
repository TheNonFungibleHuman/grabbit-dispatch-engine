# Grabbit Express — Session Handoff

**Date:** 2026-08-25 (Mauritius, UTC+4)  
**Repo:** https://github.com/TheNonFungibleHuman/grabbit-whatsapp-agent  
**Branch:** `main` · **Last commit:** `b0be6a5` — `feat(cron): schedule /api/reminders heartbeat every 5 minutes`  
**Working tree:** clean · **Remote:** `origin` already points at the repo above · **.env.local:** gitignored, verified  
**Gates (last run):** 133/133 tests · `tsc --noEmit` clean · lint **0 errors / 28 warnings** · `npm run build` green (15 routes)

---

## 1. What this system is

Mauritius 100% electric on-demand delivery + passenger ride-hailing around ALCHE / Mahogany / Pamplemousses / Grand Baie.  
Fully autonomous **WhatsApp dispatcher**: Wasender webhook → DeepSeek agent with tool-calling → Kilo Business API (fleet) + Google Chat (Moses), Supabase JSON store (state), Vercel Blob fallback.

Core business rules are deterministic TypeScript, not prompt-only:
- 15-min one-way / 30-min round-trip gaps per rider
- 3 deliveries + 1 trip / hour (or 3 trips if 0 deliveries), max 3 bookings/hour
- Smart route-batching along ALCHE ⇄ Mahogany corridor

Read `AGENTS.md` for the full architecture diagram and `node_modules/next/dist/docs/` notes (Next 16 has breaking changes).

---

## 2. What was done — 13-phase hardening plan (all completed & pushed)

All commits are on `main` on GitHub (13 commits from `f919fd1` to `b0be6a5`):

| Phase | Commit message prefix | Summary |
|---|---|---|
| 1 | `feat(orders): booking store v2` | Summary-index: hot paths do 1 index read (was N+1). Optimistic CAS + in-instance mutex with double-checked re-evaluate → concurrent double-bookings impossible on Supabase. Legacy `ids-only` indexes auto-migrate. Terminal bookings archive after 45 days (`GRABBIT_BOOKING_ARCHIVE_DAYS`). Daily orphan sweep re-admits files missing from index. |
| 1b | same commit | `listJsonPaths` primitive (Supabase/Blob/memory tri-mode). Broadcast harvest now merges active + archived summaries (no full-record hydration). |
| 2 | `feat(pricing):` | `lib/pricing/fares.ts` — typed zone table (garden ≠ town), delivery fee tiers. `schedule_trip_or_delivery` returns `fareRs/deliveryFeeRs/pricePending`. Prompt table renders from code (`formatFareTableForPrompt`). Rundown revenue delegates to same table. |
| 3 | `refactor(time):` | `lib/time.ts` — canonical Mauritius helpers (`mauritiusDateIso`, `addDaysIso`, `mauritiusMinutesOfDay`, `mauritiusClockLabel`, `mauritiusWeekday`, `resolveRelativeDateWord`). Replaced 17 `+4h` hacks. Fixed `getRiderForTargetSlot` resolving `today/tomorrow` with UTC dates (wrong 20:00–24:00 UTC). Transcript retention 12→40. |
| 4 | `fix(kilo):` | Rider YES on an already-synced booking **reuses** the existing Kilo delivery (no duplicate). `resolveDefaultCollectionMethod` unifies cash/checkout policy. `mapKiloEventToPreBookingStatus` + `applyKiloDeliveryStatus` sync Kilo webhook statuses into `PreBooking` (forward-only). |
| 5 | `feat(wasender):` + `fix(agent): fabricated tracking links` | Two-phase message claims (`processing → done`, 60s stale reclaim — crash-safe, no silent drops). Cross-instance dedup freshness 30s merge-on-read (`GRABBIT_DEDUP_FRESH_MS`). Rider YES/NO cascade wired live with approval-intent guard (`SHOULD_INTERCEPT` skips `google/chat/report/broadcast` keywords). Agent override for fabricated tracking links (`fabricatedTrackingLinks`). |
| 6 | same | Dedup freshness re-sync env-tunable; merge respects `done` > `processing`, legacy numbers → done. |
| 7 | `feat(compliance):` | Strict bare-token `STOP/UNSUBSCRIBE/OPT OUT/REMOVE ME` + resubscribe twins. Suppression index at `grabbit/admin/suppressed-phones.json`. Handler processes opt-outs before rider commands/kill-switch. Broadcasts consulted at preview + per-send. |
| 8 | `feat(metrics,health):` | Day-file recorder (`grabbit/metrics/YYYY-MM-DD.json`) — inbound, agent calls, outbound sent/failed, booking outcomes, token sums. `GET /api/metrics?days=N` (admin/CRON authed). 3 consecutive outbound failures auto-page Sherif via escalation (1h cooldown). Deep `/api/health` (storage/Kilo/WhatsApp streak/agent). |
| 9 | same | Deep health checks added; `getRiderForTargetSlot` gained injectable `now` for tests. |
| 10 | same | Customer profiles gain `lastBookingAt`; context note includes repeat-customer history token-leanly. |
| 11 | tests | Reminder window helper `shouldSendRideReminder` (15–30 min inclusive). Kilo webhook extraction suite. Fabricated-link detector suite. |
| 12 | `chore:` | Lint **10 errors → 0**. `any` casts replaced with real types (incl. discovering `"trip"` isn't a Kilo type — trips dispatch as errands). `reminderSent`/`paymentStatus` typed, theme-toggle cascading-render fixed, `scratch/**` quarantined, BOM stripped from `.env.local`. |
| — | `feat(bookings): payment method required` | `schedule_trip_or_delivery` now **requires** `paymentMethod (cash|transfer)`; missing → `PAYMENT_METHOD_REQUIRED` so agent asks first, never books. Confirmation templates per method; fabricated-link guard unit-tested. |
| — | `feat(cron):` | `vercel.json` — `*/5 * * * *` heartbeat for `/api/reminders` (did not exist before; without it reminders/briefings never fire in prod). Shared `lib/cron/auth.ts` accepting Bearer or `x-vercel-cron`. Fix: Kilo probe timeout 3s→8s after live smoke. |

New/changed routes: `/api/metrics` (admin/CRON), `/api/health` deepened, `/webhook`, `/api/kilo/webhook` now syncs `PreBooking`.

---

## 3. Production secrets & env

`.env.local` is **BOM-free UTF-8, gitignored** (verified `git check-ignore`). Keys present (names only):

```
ADMIN_PASSWORD, DEEPSEEK_API_KEY/BASE_URL/MODEL, GOOGLE_CHAT_WEBHOOK_URL,
KILO_API_KEY, KILO_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
WASENDER_API_KEY, WASENDER_WEBHOOK_SECRET, TEST_RIDER_PHONE=+99900000027, CRON_SECRET
```

Wasender keys plus `CRON_SECRET` were handled in-chat. Current `CRON_SECRET` is a strong 64-hex random value generated locally and written BOM-free. **It must be copied to Vercel → Settings → Environment Variables (Production + Preview)**. All other keys likewise.

`.env.local` was rewritten with `UTF8Encoding(false)` after a BOM was discovered (`239,187,191` → `65,68,77`). If you ever `Set-Content -Encoding UTF8` again in PowerShell 5.1, re-strip the BOM.

`vercel.json` now exists and must deploy with the project.

---

## 4. How to verify quickly in a new session

```powershell
# 1. Integrity
git status --short          # expect clean
npm test                    # expect 133/133 (now may be 133; adjust if new tests added)
npx tsc --noEmit            # clean
npm run lint                # 0 errors / ~28 warnings
npm run build               # green, 15 routes

# 2. Live smoke (requires .env.local + dev server)
npm run dev                 # http://localhost:3000
# In another shell — mint admin cookie via Node using lib/admin/session.ts:
# node --experimental-strip-types -e "for(const l of ...) ... import('./lib/admin/session.ts')..."
# Then:
# Invoke-RestMethod http://localhost:3000/api/health
# Invoke-RestMethod http://localhost:3000/api/metrics  # expect 401 unauthenticated
```

Full booking E2E via dev sandbox (requires TEST_RIDER_PHONE set):

```js
// 1) Book (include paymentMethod — required since last fix):
// POST /api/test-dispatch  Cookie: grabbit_admin_session=<minted>
// { text: "Book a trip from ALCHE main gate to Mahogany Promenade tomorrow at 5:00 PM. I will pay cash.", phone: "+9990000000003" }
// Reasoning: 5 PM Wed → Sherif (WhatsApp channel; TEST_RIDER_PHONE override hits WhatsApp)

// 2) Accept from rider:
// POST /api/test-dispatch?action=rider_confirm&reply=YES  (also admin-cookie; senderPhone == TEST_RIDER_PHONE in test mode)

// Customer WhatsApps → admin number (+9990000000003), rider WhatsApps → TEST_RIDER_PHONE.
// Moses bookings route to Google Chat, not WhatsApp — expected.
```

---

## 5. Deployment checklist (still to do on next prod deploy)

1. **Vercel env:** add every key from `.env.local` above (especially `CRON_SECRET`, `WASENDER_*`, `KILO_*`, `SUPABASE_*`, `ADMIN_PASSWORD`, `GOOGLE_CHAT_WEBHOOK_URL`, `TEST_RIDER_PHONE`).  
2. **Webhook URLs:** re-point Wasender dashboard → `https://<prod>/webhook`, Kilo dashboard → `https://<prod>/api/kilo/webhook` (both require signature secrets matching the Vercel envs).  
3. **First live message:** WhatsApp the bot number → Vercel logs should show `[wasender] message received` + agent reply (the `/webhook` path has never been exercised against prod Wasender in this session — only the dev sandbox).  
4. **Cron fires:** `vercel.json` handles it once deployed; confirm in Vercel Cron logs or wait for tomorrow 07:30 briefing. External schedulers can still hit `/api/reminders` with `Authorization: Bearer <CRON_SECRET>` or `x-vercel-cron: 1`.  
5. **Kilo dashboard:** void the two leftover `matched` test deliveries (`DEL_2026_058`, `DEL_2026_059`) — Grabbit store bookings are already `cancelled`.  
6. **Optional live re-test on prod:** same two-step flow as above via `/api/test-dispatch` (dev-only route is disabled in production — use the real WhatsApp number instead).

---

## 6. Known gotchas & decisions baked in

- **Pricing is code-enforced.** `schedule_trip_or_delivery` returns structured `fareRs`/`deliveryFeeRs`; unknown destinations return `null` and the tool defers to dispatch rather than inventing a price.
- **Payment gate:** missing `paymentMethod` → `PAYMENT_METHOD_REQUIRED` — agent asks `Cash or Bank Transfer / Juice?` first, never bundles the question with a tracking link.
- **Pre-booking bypass:** the store supports `allowUnknownShopLocation` for geocode-failed shops; `scratch/test-prebooking-workflow.mjs` exercises it. Keep the `pickup_delivery` vs `errand` `serviceKind` distinction correct (trips → Kilo `errand`).
- **Routing test quirk:** `findRiderByPhone` digit-compares; `TEST_RIDER_PHONE` is handled via `isTestMode` in `handleRiderReply` (accepts any pending booking) and `targetPhone = TEST_RIDER_PHONE || rider.phone` in `notify-rider.ts` (WhatsApp branch only).
- **In-memory L1 caches:** dedup registry + booking index have per-instance memory; cross-instance safety comes from Supabase CAS. `GRABBIT_DEDUP_FRESH_MS` defaults 30s, tunable via env.
- **Lint baseline:** 28 warnings remain (unused vars like `getKnowledgeBundle`, `FLEET_RIDERS` in some files). Errors are zero — warnings are intentional noise left alone to avoid churn.
- **Scratch scripts:** `scratch/` is eslint-ignored, not deleted — contains `simulate-chat.mjs`, `test-prebooking-workflow.mjs`, etc. Keep or remove at will.
- **Recent bug recovered:** `lib/agent/booking-guard.test.ts` was overwritten; restored from `HEAD~1` and merged with fabricated-link cases — current suite is canonical.

---

## 7. Open items / next suggested work

None required for launch — the 13-phase plan is complete as of `b0be6a5`. Natural next steps if you want to keep building:

- Production smoke of the fabricated-link guard (hallucinated confirmation was caught by unit tests; re-prove with a fresh "cash please" follow-up on prod).
- Optional archive window tuning (`GRABBIT_BOOKING_ARCHIVE_DAYS`).
- Optional: lift `schedule_trip_or_delivery` payment handling to defer rider dispatch until bank-transfer receipt verification (currently booking confirms immediately with a receipt prompt).

---

## 8. Agent notes — why a handoff helps

Past 2 days saw intermittent agent issues (tool-call truncation, context compression dropping guide text, stale in-memory caches across tool calls). This document is the single source of truth for a new session — have the next agent do:

1. `read HANDOFF.md` + `read AGENTS.md` + `git log --oneline -12` + `git status --short`
2. `npm test` quick gate before touching anything
3. Work from this file's phase table rather than re-discovering the codebase

If the next agent proposes re-doing phases, point them here — everything through Phase 12 is committed, built, and pushed.

---

## 9. Quick command reference

```bash
npm test                    # 133 tests (Node --test --experimental-strip-types)
npx tsc --noEmit            # typecheck
npm run lint                # eslint (next core-web-vitals + typescript)
npm run build               # Turbopack prod build
npm run dev                 # http://localhost:3000  (reads .env.local)
```

Vercel deploy is automatic on `git push origin main`.

---

*Generated for session handoff — safe to commit this file or keep it local; it contains no secret values, only key names.*
