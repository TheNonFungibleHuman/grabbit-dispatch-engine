# 🛵 Grabbit Express — AI Dispatch & Fleet Operations Engine

[![Next.js](https://img.shields.io/badge/Next.js-16.3.4-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-249%20Passing-brightgreen?logo=node.js)](https://nodejs.org/)
[![DeepSeek](https://img.shields.io/badge/AI%20Brain-DeepSeek%20V4.1%20Flash-purple)](https://deepseek.com/)
[![Storage](https://img.shields.io/badge/Storage-Supabase%20Blob-emerald?logo=supabase)](https://supabase.com/)

> Autonomous WhatsApp Dispatcher, Fleet Operations Engine, and Live Admin Dashboard for **Grabbit Express** — Mauritius' first 100% electric on-demand delivery, errand, and passenger ride-hailing service.

---

## 📖 Overview

**Grabbit Express** primarily serves the **ALCHE Campus (African Leadership College)**, **Mahogany Shopping Promenade**, **Pamplemousses**, **SSRN Hospital**, and **Grand Baie** corridors.

This repository (`grabbit-agent`) powers the 24/7 intelligent operations backbone:
1. **Conversational WhatsApp Dispatcher**: Books passenger rides, food deliveries (Eaters, KFC, Pappagallo, PanAsian), and custom errands powered by **DeepSeek V4.1 Flash** with clean context separation and zero prompt leaks.
2. **Multimodal Vision & Native PDF Ingress**: 
   - **DeepSeek V4.1 Flash Native Vision** (`deepseek-flash`): Unified multimodal understanding that visually parses restaurant menus, food lists, parcels, and payment screenshots with separate `reasoning_content`.
   - **Native 0-Token PDF Stream Decompressor**: Extracts MCB Juice, SBM, and Absa transfer receipts in ~5ms using native `node:zlib` streams with 0 LLM token cost.
3. **Advance Payment Proof Memory**: Auto-detects and preserves receipts sent *before* ride details are provided, auto-confirming the booking once scheduled.
4. **Multi-Booking Receipt Matching**: Disambiguates multiple active bookings on the same day by matching receipt amounts against specific booking fares.
5. **Deterministic Anti-Double-Booking Guard**: Mathematically enforces 15m/30m safety buffers and hourly capacity limits across 7-day rider schedules in pure TypeScript.
6. **Distributed Cross-Container Session Lock**: Serializes rapid-fire WhatsApp bursts across parallel serverless instances so the bot never talks over itself.
7. **Zero-Token Fleet Rider Commands**: Riders manage active runs via simple 1-word WhatsApp texts (`Done`, `Break 15m`, `Back`) requiring 0 LLM tokens.
8. **Admin-First Operations & Pending Actions**: the lead admin account is isolated as Admin-First; rundown and weekly report approvals execute deterministically with 0 tokens.
9. **Fleet Visibility & Space Alerts**: Automatically dispatches rich booking cards to Google Chat space webhooks for every confirmed run while alerting riders on WhatsApp.
10. **Admin Web Dashboard**: Real-time slots calendar, walk-in quick dispatch with custom fare allocation, live chat transcript viewer, and safe audience broadcast campaigns.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    Customer["Customer on WhatsApp"] -->|"Webhook POST"| Ingress["/webhook (WASender Receiver)"]
    Admin["Admin (+999000000008 / +9990000000003)"] -->|"Webhook POST"| Ingress
    Rider["Rider (Thierry / Sherif / Moses)"] -->|"Webhook POST"| Ingress

    Ingress --> Verify["HMAC Signature Verification & Inbound Claim Store"]
    Verify --> SessionLock["lib/wasender/session-lock.ts<br>(Distributed Cross-Container Lock)"]
    SessionLock --> Handler["lib/wasender/handlers.ts"]

    Handler --> CheckAdminAction{"Is Pending Admin Action?<br>(Rundown / Report Approval)"}
    CheckAdminAction -->|"YES (0 Tokens)"| AdminActionEngine["lib/admin/admin-actions.ts<br>(Posts to Google Chat & Confirms)"]

    Handler --> CheckRiderCmd{"Is Rider 1-Word Command?<br>(Done / Break / Back)"}
    CheckRiderCmd -->|"YES (0 Tokens)"| RiderCmdEngine["lib/riders/commands.ts<br>(Completes Run & Frees Rider)"]

    Handler --> MediaCheck{"Is Image or PDF Document?"}
    MediaCheck -->|"YES"| MediaEngine["lib/media/ (Vision & PDF Inspector)<br>• Native zlib PDF extractor (0 Tokens)<br>• DeepSeek Vision (Menus & Receipts)"]
    MediaEngine -->|"Valid Receipt"| PaymentProof["lib/orders/pre-booking.ts<br>• Match Fare to Booking<br>• Or Save Advance Proof (30m TTL)"]

    MediaCheck -->|"NO / Text Turn"| AgentCheck{"Is Human Admin Active?<br>(Kill Switch / Manual Takeover)"}
    AgentCheck -->|"Agent Paused"| RecordOnly["Append Transcript & Log Ops"]

    AgentCheck -->|"Agent Active"| Agent["lib/agent/deepseek.ts<br>(DeepSeek LLM Dispatch Brain)"]

    Agent --> ContextBuilder["lib/agent/tools.ts: buildAgentContextNote<br>• System Context Injection (Pure User Turns)<br>• 7-Day Live Availability Matrix<br>• Customer Profile Memory"]
    ContextBuilder --> Tools["DEEPSEEK_AGENT_TOOLS<br>• schedule_trip_or_delivery<br>• add_item_to_active_booking<br>• reschedule_trip_or_delivery<br>• admin_reply_to_customer"]

    Tools --> PreBooking["lib/orders/pre-booking.ts<br>• Anti-Double Booking Guard<br>• Hourly Capacity Limit (3 max)<br>• Buffer Rules (15m one-way / 30m round-trip)<br>• Auto-Link Advance Payment Proofs"]

    PreBooking --> Dispatcher["lib/riders/notify-rider.ts<br>• WhatsApp to Assigned Rider<br>• Live Card to Google Chat Space<br>• WhatsApp Live Tracking to Customer"]

    Agent --> Sanitizer["lib/agent/format.ts: sanitizeWhatsAppText<br>• Strips Chain-of-Thought Leaks<br>• Strips Role & Timestamp Prefixes<br>• Formats WhatsApp *bold* & lists"]

    Sanitizer --> DispatchOut["lib/wasender/send-tracked.ts<br>Dispatches WhatsApp Reply & Logs Outbound ID"]
```

---

## ⚡ Core Subsystems & Features

### 1. WhatsApp Booking & Anti-Double-Booking Guard (`lib/orders/`)
* **Deterministic Capacity**: Max 3 deliveries + 1 passenger trip per hour (or up to 3 passenger trips if 0 deliveries exist). Max 3 total bookings per hour per rider.
* **Buffer Safety Rules**:
  * **One-Way Trips & Deliveries**: Enforces a strict minimum **15-minute gap** for the same rider.
  * **Round-Trips**: Enforces a strict **30-minute gap** before and after (15 min travel + 15 min customer waiting time).
* **Smart Route Batching**: Orders along the same corridor (e.g. both picking up from Mahogany within 15 minutes) are grouped to the same rider without triggering safety buffer violations.
* **Advance Payment Memory**: Auto-detects and preserves receipts sent before booking, linking them into newly created orders.

### 2. Multimodal Vision & Native PDF Processing (`lib/media/`)
* **DeepSeek V4.1 Flash Native Vision (`deepseek-flash`)**: Classifies images into receipts, food menus, parcel items, or maps using structured JSON output. Extracts dishes and grocery items directly into the dispatch conversation with separated `reasoning_content`.
* **Zero-Token PDF Text Extractor**: Uses Node's built-in `node:zlib` to extract and parse MCB Juice, SBM, and Absa transfer receipts in **~5ms** with **0 LLM tokens**.
* **TrueType CID Fallback**: Automatically checks for embedded image streams and passes them to visual OCR if print-to-PDF text contains unmapped font glyphs.

### 3. Fleet Notifications & Space Visibility (`lib/riders/`)
* **Google Chat Space Webhook**: Every booked trip and delivery **always** posts a rich card to the fleet Google Chat space for 100% dispatch team visibility.
* **Direct Rider Alerts**: Sherif and Thierry receive instant WhatsApp assignment notifications with customer details and route information.
* **Live Tracking Links**: Customers receive instant links to track their assigned rider in real time.

### 4. Admin Web Dashboard (`app/admin/`)
* **Slots Calendar (`/admin/slots`)**: Filterable 4-day view (Today, Tomorrow, Yesterday, 2 Days Ago) with live status badges.
* **Walk-In Quick Dispatch**: Instant booking modal with custom fare allocation (Rs), direct rider dispatch, and customer WhatsApp confirmation.
* **Financial Overview (`/admin`)**: Live gross fares calculations, cash vs. Juice breakdowns, and operational metrics.
* **Promotional Broadcast Engine**: Previews audience reach, deduplicates phone numbers, and safely executes with 1.2s pacing delays upon admin `"YES"` confirmation.

### 5. Automated Fleet Cron Engines (`lib/schedule/`)
* **07:30 AM Morning Briefing** (`morning-briefing.ts`): Summarizes daily shifts and advance bookings to WhatsApp and Google Chat (0 LLM tokens).
* **25-Min Pre-Ride Reminders** (`reminders.ts`): Alerts customers and riders ahead of scheduled pickup slots.
* **8:30 PM Daily Rundowns** (`daily-rundown.ts`): Delivers revenue rollups to Sherif on WhatsApp.
* **Sunday 9:00 PM Weekly Executive Reports** (`weekly-report.ts`): Generates comprehensive weekly revenue analysis.

---

## 🛠️ Tech Stack & Integrations

| Service / Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Framework** | **Next.js 16 (App Router)** | TypeScript, Turbopack, Server Actions, API Routes |
| **WhatsApp Ingress / Egress** | **WasenderAPI** | Webhook receiver (`/webhook`) & message tracker |
| **AI LLM Brain** | **DeepSeek V4.1 Flash** (`deepseek-flash`) | Unified CED MoE model: high-speed text reasoning with native tool calling |
| **Multimodal Vision** | **DeepSeek V4.1 Flash** (`deepseek-flash`) | Native visual menu parsing, parcel inspection, receipt OCR |
| **PDF Stream Engine** | **Node.js `node:zlib`** | Native 5ms zero-token digital PDF receipt extraction |
| **Database & JSON Store** | **Supabase JSON Store** | Persistent booking records, transcripts, and fleet status |
| **Fleet Notifications** | **WhatsApp & Google Chat Webhook** | Dispatches to riders on WhatsApp and space alerts to Google Chat |
| **Testing** | **Node.js Native Test Runner** | 249 automated unit and integration tests |

---

## 🔑 Environment Variables Reference

Create a `.env.local` file in the root directory:

```ini
# --- AI Engine (DeepSeek V4.1 Flash) ---
DEEPSEEK_API_KEY=your_deepseek_api_key
# Optional overrides (defaults to deepseek-flash)
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VISION_MODEL=deepseek-flash

# --- WhatsApp Ingress & Egress (WASender) ---
WASENDER_API_KEY=your_wasender_api_key
WASENDER_SIGNING_SECRET=your_webhook_hmac_secret
WASENDER_SESSION_ID=your_session_id

# --- Database & Persistent Store (Supabase) ---
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# --- Fleet Space Visibility ---
GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...

# --- Admin & Cron Security ---
CRON_SECRET=your_secure_cron_secret
ADMIN_PASSWORD=your_admin_dashboard_password
SESSION_SECRET=your_cookie_signing_secret

# --- Optional / Staging Overrides ---
TEST_RIDER_PHONE=
RESEND_API_KEY=
```

---

## 🧪 Development & Testing

```bash
# Install dependencies
npm install

# Run complete test suite (249 unit & integration tests)
npm test

# Run Next.js production build (Turbopack + TypeScript validation)
npm run build

# Start local development server
npm run dev
```

---

## 📁 Repository Structure

```text
grabbit-agent/
├── app/
│   ├── admin/                 # Web Admin Dashboard (Knowledge base editor, slots, metrics)
│   │   ├── slots/             # Real-time slots calendar & walk-in dispatch modal
│   │   ├── messages/          # Customer chat transcript inspector
│   │   └── knowledge/         # Operational knowledge base editor
│   ├── api/
│   │   ├── health/            # System health check
│   │   ├── kilo/webhook/      # Logistics delivery webhook receiver
│   │   ├── reminders/         # Cron endpoint (briefings, 25m reminders, daily rundowns)
│   │   ├── schedule/          # Admin API for updating availability schedule
│   │   ├── slots/             # Admin API for pre-booking creation and cancellation
│   │   └── test-dispatch/     # Sandbox dispatch endpoint
│   └── webhook/route.ts       # Main WASender WhatsApp webhook ingress (maxDuration = 60)
├── lib/
│   ├── admin/                 # Admin auth, pending actions store, sessions, broadcast engine
│   ├── agent/                 # DeepSeek agent core, system prompt, tools, sanitizers
│   ├── blob/                  # Supabase persistent JSON document store
│   ├── kilo/                  # Kilo API client, location discovery, webhook parsers
│   ├── media/                 # DeepSeek Vision inspector, native PDF zlib extractor, Wasender media
│   ├── ops/                   # Operations event store and escalation manager
│   ├── orders/                # Pre-booking engine, advance payment proofs, dialog state FSM
│   ├── pricing/               # Canonical fare pricing engine and zone calculator
│   ├── riders/                # Fleet configuration (Thierry, Sherif, Moses), 1-word commands
│   ├── schedule/              # 7-day availability evaluator, morning briefings, weekly reports
│   └── wasender/              # WASender client, HMAC verification, distributed session lock
├── data/
│   └── rider-schedule.csv     # Default weekly rider shift matrix
├── AGENTS.md                  # Complete technical architecture & agent guide
├── README.md                  # Project overview & documentation
└── package.json               # Dependencies & scripts
```

---

## 📄 License

Proprietary and Confidential. Copyright © Grabbit Express Mauritius. All rights reserved.
