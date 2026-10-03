# Calltime — Implementation Plan (v1)

> AI outbound calling for event companies. Short "interest check" calls, a human closes the deal.
>
> This document is written so that an engineer or a coding model can implement Calltime step by step
> without the original discussion. Follow the milestones in order (Section 22). Where this plan says
> **CONFIGURABLE**, put the value in config, never hardcode it. Where it says **VERIFY**, check the
> provider documentation or current regulation before relying on it — do not guess.

---

## Table of contents

1. Product summary
2. Scope and non-goals
3. Glossary
4. Roles (who uses what)
5. Architecture overview
6. Pool, scaling and priority (Calltime inside the Runtime pool)
7. Telephony layer and provider abstraction
8. Number pool (shared numbers, rotation, health, dedicated numbers)
9. Callback handling (people who call the number back)
10. Compliance gate (India)
11. The call: script and state machine
12. Voice pipeline (STT, VAD, turn-taking, interruptions, TTS)
13. Runtime / LLM integration (fast path)
14. Campaign configuration (what the event company fills in)
15. Contacts and lists
16. Dialer and scheduling (fair queue, retries, pacing)
17. Outcomes, summaries and the review queue
18. Calling manager dashboard
19. Follow-ups (WhatsApp / SMS)
20. Billing: add-on fee, wallet, metering, cost tracking
21. Data model
22. Milestones (build order with definition of done)
23. Testing plan and acceptance criteria
24. Observability and alerts
25. Security, privacy, retention
26. Future stages (screening assistants, agent-to-agent)
27. What the owner (human) must provide
28. Open decisions and defaults
29. Rules for the implementer

---

## 1. Product summary

**Who buys it:** event companies (concerts, gala nights, expos, workshops, parties, corporate events).

**What it does:** Calltime calls a contact list on behalf of the event company. Each call is about
**1 minute**:

1. The agent introduces itself as an **AI assistant** calling for the event company.
2. Describes the event in 15–20 seconds (name, date, venue, one hook).
3. Asks: "Would you be interested in hearing more?"
4. Branches: interested → promise a personal callback from the team; maybe → offer details on WhatsApp;
   not interested → thank and end; question → short answer from FAQ or "our team will explain".
5. Ends politely.

Every call is recorded, transcribed and summarised into a structured outcome. **Interested people go to
a human ("calling manager") who calls them personally and closes the deal.**

**Positioning (use in UI copy and sales):**

- "Your telecaller stops dialing and starts closing."
- "From telecaller to calling manager."
- "Stop chasing ghosts. Talk only to people who said yes."
- "AI makes the first call. Your best person makes the deal."

**Core principles (must hold in every feature):**

- The AI **filters**, it does not sell. It never asks for payment, never negotiates, never promises
  discounts or anything not in the campaign config.
- The AI always says it is an AI assistant and who it is calling for.
- A human always follows up on interest. The AI promises that follow-up.
- Outbound only. No inbound agent. (Only a minimal static callback flow, Section 9.)
- Events and outcomes are stored as **structured data**, not just text, so later stages
  (agent-to-agent) are an upgrade, not a rebuild (Section 26).

---

## 2. Scope and non-goals

### In scope for v1

- Outbound interest-check calls (Hindi, Hinglish, English — language set per campaign).
- Handling interruptions (barge-in) naturally.
- Campaign setup form, script generation, test call to own phone, approval.
- Contact upload (CSV), validation, de-duplication, DND scrub, do-not-call list.
- Dialer with fair queue across customers, retries, calling windows.
- Shared number pool with rotation, daily caps, health tracking; dedicated numbers as a paid tier.
- Minimal callback handling on pool numbers (message and optional forward).
- Recording, transcript, structured summary, outcome buckets.
- Review queue / calling manager dashboard with hot leads first.
- Post-call WhatsApp/SMS with event details (can be M7, see milestones).
- Prepaid wallet, per-second metering, add-on subscription, cost tracking.
- Detecting carrier announcements (switched off / not reachable) and call screening assistants.

### Not in scope for v1 (do not build)

- Inbound AI agent (answering the business's own number).
- Selling, payments, negotiation, ticket booking inside the call.
- Predictive dialing (dialing more numbers than free agents). It creates silent/abandoned calls.
- Using customers' personal mobile numbers as caller ID, SIM boxes, GSM gateways, Android phone
  gateways. These are unreliable and legally risky in India.
- Building a consumer call-screening app.
- Agent-to-agent structured exchange (Stage 3, Section 26) — only the foundations.

### Optional in v1 (behind a feature flag, build last)

- Live transfer: if the person says "I want to book now", bridge the call to the calling manager's
  phone. Flag: `feature.live_transfer`.

---

## 3. Glossary

| Term | Meaning |
| --- | --- |
| Surface instance | An existing deployment of the Surface platform. Each has its own Runtime agents. |
| Runtime | The existing agent runtime that calls the LLM for other agents. Already pooled. |
| Pool | The existing shared worker pool used by Runtime. Calltime workers run in the same pool. |
| Calltime (logical) | The calling service as seen by one Surface instance. 4 Surface instances = 4 logical Calltimes. |
| Calltime worker | A process in the pool that handles live calls (media + conversation). Shared across logical Calltimes. |
| Tenant / customer | An event company subscribed to Calltime. |
| Subscription | The tenant's Calltime add-on (plan, limits, wallet). |
| Campaign | One calling job for one event: config + contact list + schedule. |
| Offer | The structured description of the event (name, date, venue, price, hook, link). |
| Contact | One person to call (phone, name, source). |
| Attempt | One dial of one contact. A contact can have several attempts (retries). |
| Call | An attempt that the carrier connected (answered by a person, machine or assistant). |
| Outcome | Final bucket for a contact in a campaign (interested, maybe, not_interested, ...). |
| Calling manager | The tenant's staff member (former telecaller) who reviews outcomes and calls hot leads. |
| Pool number | A phone number owned by the platform, shared across tenants. |
| Dedicated number | A number assigned to one tenant only (premium). |
| DND | India's Do-Not-Disturb registry (NCPR). |
| DLT | India's Distributed Ledger Technology registration for commercial communication. |
| Barge-in | The person speaks while the agent is speaking; the agent must stop and listen. |
| Endpointing | Deciding the person has finished their turn. |
| AMD | Answering machine / announcement detection. |
| COGS | Our cost per call (telephony + STT + TTS + LLM). |

---

## 4. Roles (who uses what)

| Role | Belongs to | Can do |
| --- | --- | --- |
| Platform admin | Us | Manage providers, number pool, rate card, tenants, global DNC, view all metrics. |
| Tenant owner | Event company | Subscribe, top up wallet, set rate plan, add users, everything a manager can. |
| Calling manager | Event company | Create/approve campaigns, upload contacts, run test calls, review outcomes, call leads, mark results, edit FAQ. |
| Viewer | Event company | Read-only dashboard and reports. |

Tenant isolation is strict: a tenant can never see another tenant's contacts, calls, recordings or
outcomes, even though they share numbers and workers.

---

## 5. Architecture overview

```
                   ┌──────────────────────────── Surface instance N ────────────────────────────┐
                   │  Calltime (logical): tenants, campaigns, contacts, outcomes, wallet, UI     │
                   └───────────────┬─────────────────────────────────────────────┬──────────────┘
                                   │ campaign/contact/outcome APIs               │ review UI
                                   ▼                                             │
┌───────────────────────── Shared services (one deployment, multi-tenant) ───────┴──────────────┐
│ Campaign Service │ Contact Service │ Compliance Gate │ Dialer/Scheduler │ Number Pool Manager │
│ Wallet/Billing   │ Outcome Service │ Callback Router │ Follow-up Sender │ Provider Adapter(s) │
└────────────┬───────────────────────────────────────────────────────────────────────┬─────────┘
             │ "dial this attempt on this worker"                                     │ REST
             ▼                                                                        ▼
┌──────────── Shared pool (same pool as Runtime, Calltime has priority) ─┐   ┌─ Telephony provider ─┐
│ Calltime worker(s):                                                    │◀──│ media WebSocket      │
│   Media Gateway ─ VAD/Endpointing ─ STT stream ─ Turn Manager ─ TTS    │──▶│ (call audio)         │
│                         │                                              │   └──────────────────────┘
│                         ▼ fast path (streaming, priority=realtime)     │
│                Runtime ─▶ LLM                                          │
└────────────────────────────────────────────────────────────────────────┘
```

### Components (one line each; details in later sections)

- **Campaign Service** — CRUD for campaigns/offers, script generation, approval state.
- **Contact Service** — CSV import, phone normalisation, de-dup, source tags, DNC marks.
- **Compliance Gate** — the single place that decides "may we dial this contact now from this number".
  Every dial must pass through it. No bypass.
- **Dialer/Scheduler** — chooses the next attempt fairly across tenants, reserves a worker slot and a
  number, reserves wallet balance, asks the provider to dial.
- **Number Pool Manager** — selects caller ID, enforces daily caps, tracks health, quarantines.
- **Provider Adapter** — the only code that knows provider APIs (dial, hangup, media stream, recording,
  webhooks, transfer). One adapter per provider behind one interface.
- **Calltime worker** — handles live calls: audio in/out, VAD, STT, turn-taking, barge-in, TTS,
  conversation via Runtime, call state machine, recording marks, transcript.
- **Outcome Service** — post-call summary, outcome bucket, review queue items, retry decisions.
- **Wallet/Billing** — subscription, prepaid wallet, holds, per-second rating, ledger, COGS.
- **Callback Router** — minimal handling for people calling a pool number back.
- **Follow-up Sender** — WhatsApp/SMS with event details after the call.
- **Dashboard (UI)** — campaign setup, test call, review queue, reports, wallet.

### Technology

Use the same language, framework, database and queue as the existing Runtime. If there is no clear
choice, use TypeScript on Node.js, PostgreSQL, and Redis for queues/locks/counters. Workers must be
able to run in the existing pool (same deployment mechanism, same health checks).

Host in an **India region** (e.g. Mumbai) for low latency to the phone network and the provider.

---

## 6. Pool, scaling and priority (Calltime inside the Runtime pool)

This section is the agreed design: **Calltime scales like Runtime, in the same pool, and Calltime gets
priority over Runtime.**

### 6.1 Logical vs physical Calltime

- **Logical Calltime** = one per Surface instance. It is a namespace: its tenants, campaigns, config,
  and UI live with that Surface instance. If there are 4 Surface instances, there are 4 logical
  Calltimes.
- **Physical Calltime workers** = processes in the shared pool. Any worker can serve a call for any
  logical Calltime. A call carries `surface_instance_id` and `tenant_id` so the worker loads the right
  config and talks to the right Runtime.
- Reason: promotional campaigns spike (everyone calls in the last 3–5 days before an event). Scaling by
  call volume, not by number of Surface instances, avoids idle and overloaded Calltimes.

If a Surface instance must have hard-isolated workers (enterprise customer), support a
`dedicated_worker_group` setting on the logical Calltime. Default: shared.

### 6.2 Priority classes in the pool

| Class | Work | Rule |
| --- | --- | --- |
| P0 — realtime | Live Calltime calls (media + LLM turns of a connected call) | Never queued once a call is connected. Always gets CPU, network and LLM capacity first. |
| P1 — interactive | Runtime interactive agent requests (users waiting) | Normal Runtime behaviour. |
| P2 — background | Runtime background jobs, Calltime post-call summaries, report generation, follow-up sends | Can be delayed or slowed when P0 needs capacity. |

Rules:

1. **Admission control at dial time.** The dialer may dial only when it has reserved a P0 slot on a
   worker. A connected call must never wait for a slot. This is why we do progressive dialing
   (one dial per free slot), not predictive.
2. **Slots per worker** — CONFIGURABLE `worker.max_concurrent_calls` (start at 20; tune by load test,
   Section 23). Calls are mostly I/O (audio streams to external STT/TTS), so this can be high, but the
   limit protects latency.
3. **Preemption** — when P0 demand rises, the pool scheduler first delays P2, then reduces P1
   concurrency on the shared workers down to a floor (CONFIGURABLE `pool.p1_min_share`, default 30%)
   so Runtime is never fully starved. It never kills an in-flight P1 request; it stops accepting new
   ones on that worker and lets others take them.
4. **LLM capacity reservation** — Calltime LLM calls go through Runtime with `priority=realtime`.
   Runtime must keep a reserved share of LLM rate limit (tokens/min and requests/min) for realtime
   when any campaign is active: CONFIGURABLE `llm.realtime_reserved_share` (default 30%). Realtime
   requests skip Runtime's normal queue.
5. **Autoscaling signals** (add to the pool's existing autoscaler):
   - `calltime_slots_reserved / calltime_slots_total` > 70% for 2 min → scale out.
   - Dialer backlog (attempts that are due now but waiting for a slot) > CONFIGURABLE threshold → scale out.
   - Scheduled campaign starts in the next 15 minutes → pre-warm workers (campaigns are scheduled, so
     load is predictable).
   - Scale in only when a worker has 0 live calls (drain: stop giving it new slots, wait for calls to end).
6. **Worker drain / deploys** — a worker marked draining gets no new slots; live calls finish (max call
   length is capped, Section 11), then it stops. Deploys must use drain. Never restart a worker with
   live calls.
7. **Worker crash** — if a worker dies mid-call, the provider will hang up or the call goes silent.
   The dialer must detect missing heartbeats (CONFIGURABLE, 5 s), mark the attempt `failed_internal`,
   release the number/wallet hold correctly (bill only provider-reported duration), and schedule a
   retry for later (do not call the person back immediately).

### 6.3 Fair queue across tenants

- Each tenant has `max_concurrent_calls` from their plan (CONFIGURABLE per plan, e.g. Starter 5,
  Growth 20, Pro 50).
- Each campaign has an optional `max_concurrent_calls` ≤ tenant limit.
- The dialer picks the next attempt by **weighted round-robin across active campaigns**, weight =
  plan weight, skipping campaigns that are at their concurrency limit, outside their calling window,
  out of wallet balance, or paused.
- One huge campaign must never starve small ones: at most CONFIGURABLE `dialer.max_share_per_tenant`
  (default 40%) of total free slots go to one tenant when others are waiting.

---

## 7. Telephony layer and provider abstraction

### 7.1 Provider choice

Candidates for India: **Exotel, Plivo, Tata Tele Business, Airtel IQ**. Twilio/Telnyx for non-India
later. The owner chooses (Section 27). The provider **must** support:

- Outbound calls via API with a chosen caller ID from numbers we own.
- **Real-time bidirectional audio streaming over WebSocket** (both directions, with the ability to
  clear/stop queued playback). This is required for interruption handling. **VERIFY** before signing.
- Call status webhooks (initiated, ringing, answered, completed, failed, busy, no-answer) with durations.
- Call recording (or we record ourselves from the stream — prefer ourselves; see 12.8).
- Hangup via API.
- Inbound on our numbers for callback handling (static flow or webhook).
- Optional: transfer/bridge to another phone number (for live transfer).
- Billing detail per call (duration, pulse, cost) via API or report.

### 7.2 Provider adapter interface (implement exactly this shape, language-appropriate)

```
interface TelephonyProvider {
  name: string

  // Start an outbound call. Returns provider call id. Media will connect to mediaUrl when answered.
  dial(req: {
    attemptId: string
    to: string            // E.164, e.g. +919812345678
    from: string          // caller ID, E.164, must be a number we own on this provider
    mediaUrl: string      // our WebSocket endpoint on the reserved worker, includes a signed token
    statusCallbackUrl: string
    ringTimeoutSec: number   // CONFIGURABLE, default 30
    maxDurationSec: number   // hard cap, default 120
  }): Promise<{ providerCallId: string }>

  hangup(providerCallId: string): Promise<void>

  // Optional (feature.live_transfer)
  transfer?(providerCallId: string, to: string): Promise<void>

  // Parse provider webhooks into our normalised events
  parseStatusWebhook(httpRequest): NormalisedCallEvent
  verifyWebhookSignature(httpRequest): boolean

  // Media: adapter converts provider's WebSocket protocol to our MediaSession interface
  acceptMedia(ws): MediaSession

  // Numbers
  listNumbers(): Promise<ProviderNumber[]>

  // Inbound callback config for a number (static message / webhook)
  configureInbound(number: string, webhookUrl: string): Promise<void>
}

interface MediaSession {
  onAudio(cb: (frame: AudioFrame) => void)     // caller audio, normalised to PCM16
  sendAudio(frame: AudioFrame): void           // agent audio
  clearPlayback(): void                        // stop anything queued/playing NOW (barge-in)
  mark(name: string): void                     // ask provider to tell us when playback reaches here
  onMark(cb: (name: string) => void)
  onClose(cb: (reason) => void)
  close(): void
}

type NormalisedCallEvent = {
  providerCallId: string
  attemptId: string
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled'
  at: timestamp
  billableSeconds?: number
  providerCost?: { amountPaise: number, currency: 'INR' }
  rawPayload: json     // keep for audit
}
```

Rules:

- **Do not invent provider API details.** Read the chosen provider's docs and implement the adapter
  from them. Write a fake provider (Section 23) first and develop against it.
- All provider-specific audio formats (often 8 kHz μ-law) are converted inside the adapter to
  **16-bit PCM**, sample rate as required by STT (8 kHz or 16 kHz). TTS output is converted back.
- Webhooks must be idempotent (providers retry). Key on `(providerCallId, status)`.
- Media WebSocket URL contains a short-lived signed token (attemptId, workerId, expiry 2 min). Reject
  anything else.

---

## 8. Number pool (shared numbers, rotation, health, dedicated numbers)

### 8.1 Facts the design relies on

- A number is a **caller ID**, not a line. One number can carry many simultaneous calls. 10 numbers do
  **not** limit us to 10 concurrent calls (**VERIFY** per provider; some plans limit channels per account).
- The real limit is **reputation**: too many calls per number per day → spam flags (Truecaller,
  carrier analytics) → pickup rate collapses for every tenant on that number.
- Example from discussion: 10 pool numbers shared by 100 customers is fine to start; grow the pool
  with **call volume**, not customer count.

### 8.2 Number record

```
number:
  id, e164, provider, type: 'pool' | 'dedicated'
  tenant_id (null for pool)
  series: e.g. '140' | '1600' | 'regular' (as allotted; VERIFY rules)
  status: 'active' | 'quarantined' | 'retired'
  daily_cap_connected: int     // CONFIGURABLE default 150, tune per data
  daily_cap_dials: int         // CONFIGURABLE default 400
  health_score: 0..100
  quarantine_until: timestamp?
  branded_name: string?        // e.g. Truecaller business name for dedicated numbers
  callback_mode: 'lookup_message' | 'lookup_forward' | 'static_message'
```

Daily counters in Redis keyed by `number:{id}:{yyyy-mm-dd IST}` → dials, connected, short_hangups
(< 5 s), total_talk_seconds. Persist end-of-day to `number_daily_stats`.

### 8.3 Selection algorithm (per attempt)

Input: tenant, contact, campaign.

1. If the tenant has active dedicated number(s) → candidates = those. Else candidates = active pool numbers.
2. **Sticky rule:** if this contact was already called in this campaign, reuse the same number if it
   is still active and under cap (consistent caller ID helps callbacks and trust).
3. Remove numbers that are quarantined, retired, or at daily cap (dials or connected).
4. Remove numbers that called this same phone (any tenant) in the last CONFIGURABLE 3 days, unless
   sticky — avoids one number calling one person for several businesses.
5. Pick the candidate with the **lowest dials today**; tie-break by highest health score.
6. If no candidate → the attempt waits (do not drop it); raise the `pool_exhausted` metric and alert
   the platform admin if it persists for more than 10 minutes.

### 8.4 Health score

Compute every hour per number over a rolling 3-day window:

- `pickup_rate` = connected / dials
- `short_hangup_rate` = calls < 5 s / connected
- compare to the pool average for the same hours.

```
health = 100
  - 40 * max(0, (pool_pickup - number_pickup) / pool_pickup)      // pickup drop
  - 30 * max(0, number_short_hangup - pool_short_hangup) * 2       // early hangups
  - 30 * (spam_reported ? 1 : 0)                                   // manual flag by admin
clamp 0..100
```

- health < CONFIGURABLE 50 → quarantine for CONFIGURABLE 7 days, alert admin.
- After quarantine, the number returns at half its daily caps for 3 days ("warm-up"), then full caps.
- Admin UI: list numbers, health trend, quarantine/unquarantine, mark "spam reported", retire, add.
- Keep CONFIGURABLE 20% buffer numbers above expected need so quarantines do not stall campaigns.

### 8.5 Pool sizing guidance (put in admin docs)

`numbers_needed ≈ (expected connected calls per day) / daily_cap_connected × 1.2 buffer`.
E.g. 3,000 connected/day ÷ 150 × 1.2 = 24 numbers.

### 8.6 Dedicated numbers (premium tier)

- Assigned to one tenant. Same caps and health tracking.
- Admin registers a branded caller name (Truecaller business / carrier CNAP where available — **VERIFY**).
- Callbacks on a dedicated number always go to that tenant (no lookup needed).

### 8.7 Quality guard per tenant

One bad tenant can damage shared numbers. Track per tenant: pickup rate, short hangups, opt-out rate.
If a tenant's opt-out rate > CONFIGURABLE 8% or short-hangup rate > 2× pool average over 200+ calls:
pause their campaigns, notify the tenant and admin ("your list or script is getting poor reactions").
Admin can resume.

---

## 9. Callback handling (people who call the number back)

There is **no inbound AI agent**. But people return missed calls. A dead number looks like spam. So
pool numbers get a minimal, static callback flow:

1. Inbound call on a pool number → provider webhook → Callback Router.
2. Look up the most recent outbound attempt **from this number to the caller's phone** in the last
   CONFIGURABLE 30 days.
3. Found → tenant T:
   - `lookup_message` (default): play a short TTS/pre-generated message in the campaign language:
     "Hello, this number was used by **{tenant brand}** to tell you about **{event name}** on
     **{date}**. We'll send you the details on WhatsApp. Thank you." Then hang up and trigger a
     follow-up send (Section 19) if allowed.
   - `lookup_forward`: play "Connecting you to {tenant brand}" and forward to the tenant's configured
     callback phone number (the calling manager's mobile). If no answer → message as above.
   - Mark the contact's outcome as `called_back` (counts as a warm signal → review queue).
4. Not found → play a generic message: "This number is used for event invitations on behalf of
   our clients. If you received a call, you will get details on WhatsApp. To stop calls, press 9."
   Pressing 9 (DTMF) → add the caller to the **global** DNC list.
5. Dedicated numbers: always tenant T, use the tenant's chosen mode.
6. Messages are generated once per campaign and cached as audio files (no live TTS needed).
7. Log every callback (no recording unless the tenant's forward mode records; default off).

---

## 10. Compliance gate (India)

> Regulations change. Everything here is a **checklist to VERIFY with the provider and a legal adviser
> before go-live**. All rules are CONFIGURABLE so they can be updated without code changes.

### 10.1 Registration (owner tasks, not code)

- Business DLT registration (principal entity) via provider / operator portal.
- Correct number series for promotional voice calls (e.g. 140-series; newer series such as 1600 are
  for service/transactional calls) — **VERIFY** which series the provider allots for this use case.
- Provider KYC.

### 10.2 Rules enforced in code (Compliance Gate)

Every attempt passes `complianceGate.check(attempt)` immediately before dialing. It returns
`allow` or `deny(reason)` and is logged. Checks, in order:

1. **Campaign approved** by the calling manager and not paused.
2. **Contact has a source tag** (where we got the number: past_attendee, website_form, instagram_enquiry,
   event_registration, referral, other). `purchased_list` is **not accepted**. No tag → deny.
3. **Global DNC** (people who opted out from any tenant via "press 9" or admin) → deny.
4. **Tenant DNC** (opted out from this tenant) → deny.
5. **NCPR/DND scrub**: the contact list is scrubbed at upload and again if the scrub is older than
   CONFIGURABLE 7 days. Use the provider's scrub API or an approved scrub service (**VERIFY** what the
   provider offers). DND-registered → deny (unless the rule set allows the category; default deny).
6. **Calling window**: contact's local time (IST for India numbers) within CONFIGURABLE
   `09:00–21:00`, and within the campaign's own window, and not on CONFIGURABLE blocked dates.
7. **Frequency caps**: max CONFIGURABLE 3 attempts per contact per campaign; max 1 connected call per
   contact per campaign (do not re-pitch someone who already answered); max CONFIGURABLE 2 campaigns
   from the same tenant per contact per 30 days.
8. **Number ok**: selected number is active and allowed for promotional calls.
9. **Wallet hold** succeeded (Section 20).

### 10.3 In-call rules

- First sentence discloses **AI assistant** and **the business name**.
- Recording notice: "This call may be recorded for quality." (CONFIGURABLE text per language; **VERIFY**
  requirement.)
- Opt-out phrases in any language ("don't call me", "mat karo call", "remove my number", "band karo")
  → agent says "Sorry for the trouble, we won't call you again" → tenant DNC + outcome `opt_out`.
- No payment, card, OTP or personal ID details are ever asked or accepted. If the person offers them,
  the agent says the team will handle it and does not repeat them. Redact digits in transcripts if they
  look like card/OTP numbers.

### 10.4 Records to keep (audit)

Per attempt: gate decision and reason, number used, timestamps, DND scrub date, source tag, consent
note, recording reference. Keep CONFIGURABLE 1 year (**VERIFY**).

---

## 11. The call: script and state machine

### 11.1 Target conversation (≈ 60 s, hard cap 90 s of talk, provider cap 120 s)

```
GREETING   (≤10 s) "Namaste, main Riya bol rahi hoon, ABC Events ki AI assistant. Kya main
                    {name} ji se baat kar rahi hoon?"  (name optional)
                    + recording notice (short)
PITCH      (15–20 s) "Hum {date} ko {venue} mein {event} host kar rahe hain. {hook}."
ASK        (≤5 s)  "Kya aap iske baare mein aur jaanna chahenge?"
BRANCH     (20–30 s)
  interested → "Bahut badhiya! Hamari team se koi aapko personally call karega. Aapke liye kaunsa
                time theek rahega?" (+ optional configured questions: how many people?)
  maybe      → "Koi baat nahi. Kya main details WhatsApp par bhej doon?"
  not_interested → "Koi baat nahi, aapka samay dene ke liye dhanyavaad."
  question   → short answer from FAQ (≤2 sentences) or "Hamari team aapko call karke detail mein
                batayegi." then return to ASK once.
CLOSE      (≤5 s)  "Dhanyavaad, aapka din shubh ho!" → hang up
```

The example above is Hinglish. The real script is generated from the campaign config and language
(Section 14).

### 11.2 States

```
DIALING → RINGING → CONNECTED → DETECT (first 3 s)
DETECT → { HUMAN → GREETING, CARRIER_ANNOUNCEMENT → END(unreachable),
           SCREENING_ASSISTANT → SCREENING_MESSAGE, VOICEMAIL → END(voicemail), SILENCE → GREETING }
GREETING → CONFIRM_PERSON? → PITCH → ASK → BRANCH → (QUESTION ↺ max 2) → COLLECT? → CLOSE → END
any state → OPT_OUT → CLOSE
any state → WRONG_PERSON → apologise → END(wrong_number)
any state → BUSY_NOW ("abhi busy hoon") → ask best time → END(callback_requested)
any state → TIME_CAP reached → polite close → END(with best outcome so far)
any state → LONG_SILENCE (CONFIGURABLE 8 s after a prompt, re-prompt once, then end) → END(no_response)
any state → HANGUP by person → END(with best outcome so far)
any state → TRANSFER_REQUESTED (only if feature.live_transfer) → TRANSFER
```

The LLM drives the wording and understanding; **the state machine owns limits** (time caps, max
question loops, mandatory disclosure, close). The worker enforces these even if the LLM does not.

### 11.3 Detection in the first seconds (DETECT)

Run STT on the first CONFIGURABLE 3 s of audio after answer:

- **Carrier announcements** ("the number you are calling is switched off / not reachable / busy",
  "aap jis number par call kar rahe hain…", similar in regional languages): keyword list in config →
  hang up, outcome `unreachable`, retry later per rules. Do not bill the tenant for these
  (CONFIGURABLE; we still pay COGS).
- **Call screening assistants** (Google Call Screen, Truecaller assistant, Apple, others): phrases
  like "the person you're calling is using a screening service", "please say your name and why you're
  calling", "I'm an assistant for…". Keyword list + LLM classification on the first utterance.
  → `SCREENING_MESSAGE`: deliver a short, structured message: "Hi, this is Riya, an AI assistant for
  ABC Events. We're hosting {event} on {date} at {venue}. If {name} is interested, we'll share details
  on WhatsApp. Thank you." → outcome `message_taken` → trigger follow-up send. Keep under 20 s.
- **Voicemail** (rare in India): beep/long monologue → hang up, no message in v1, outcome `voicemail`.
- Default → HUMAN.

### 11.4 Mandatory lines (state machine inserts if missing)

- AI disclosure + business name in GREETING.
- Recording notice.
- For interested: promise of a personal callback from the team.
- Polite close.

### 11.5 Limits (all CONFIGURABLE)

| Limit | Default |
| --- | --- |
| Ring timeout | 30 s |
| Talk time soft cap (start closing) | 75 s |
| Talk time hard cap (force close) | 90 s |
| Provider max duration | 120 s |
| Question loops | 2 |
| Re-prompts on silence | 1 |
| Silence before re-prompt | 6 s |
| Agent max sentence length | 2 sentences per turn |

---

## 12. Voice pipeline (STT, VAD, turn-taking, interruptions, TTS)

### 12.1 Latency budget (person stops talking → agent starts talking)

| Step | Target |
| --- | --- |
| Endpointing (deciding they stopped) | 300–500 ms |
| STT final transcript | 100–200 ms |
| Runtime → LLM first tokens | 300–500 ms |
| TTS first audio | 150–300 ms |
| Network/provider | ~100 ms |
| **Total target** | **≤ 1.0 s p50, ≤ 1.5 s p95** |

Measure every turn (Section 24). If p95 > 1.5 s in a campaign, alert.

### 12.2 Audio

- From provider: usually 8 kHz μ-law mono → convert to PCM16. Frames of 20 ms.
- Keep a full-call stereo recording: left = person, right = agent (what was **actually played**, see 12.5).

### 12.3 STT

- Streaming STT with interim and final results.
- Must handle Hindi, Hinglish (code-mixed) and English. Candidates: Sarvam, Deepgram, Google.
  The owner picks (Section 27); implement behind an `SttProvider` interface:
  `start(lang) → stream; push(frame); onPartial(text); onFinal(text, confidence); close()`.
- Pass campaign keywords as hints (event name, venue, tenant brand) where the STT supports it.

### 12.4 VAD and endpointing

- Use a local VAD (e.g. Silero-like) on incoming frames for speech start/stop, plus STT end-of-utterance
  signals where available.
- End of turn = VAD silence ≥ CONFIGURABLE 400 ms **and** STT final received; extend to 800 ms if the
  partial text ends with a hesitation word ("umm", "matlab", "woh", "and") or is very short.

### 12.5 Interruptions (barge-in) — required

When the agent is speaking and the person starts speaking:

1. **Detect**: VAD speech ≥ CONFIGURABLE 250 ms **and** an STT partial with ≥ 1 real word.
2. **Ignore backchannels**: if the partial is only a backchannel word ("haan", "hmm", "ok", "ji",
   "achha", "yes", "right") and speech ends within 600 ms → do **not** interrupt; keep talking.
   List in config per language.
3. **Stop within 200 ms** of detection: `media.clearPlayback()`, cancel any in-flight TTS synthesis and
   the in-flight LLM stream for the current turn.
4. **Record what was actually said**: use playback `mark`s placed after each sentence/chunk sent to TTS.
   The assistant turn in history is truncated to the last mark reached + "…[interrupted]". The LLM must
   never believe the person heard text that was not played.
5. **Listen**: treat the person's speech as a new user turn (normal endpointing).
6. Respond to what they said. If they asked to stop/opt out, go to OPT_OUT immediately.
7. Echo protection: if the provider does not cancel echo, ignore VAD triggers that match the agent's own
   audio energy pattern for the first 150 ms after the agent starts a sentence (simple gate). Test with
   speakerphone calls.

### 12.6 TTS

- Streaming TTS, chunked by sentence/clause: start speaking the first clause while the LLM is still
  generating the rest.
- Candidates: Sarvam (cheap, Indian voices) as default; Cartesia / ElevenLabs as premium voices.
  Behind `TtsProvider`: `synthesize(textChunk, voiceId, lang) → audio stream`.
- Pre-generate and cache audio for fixed lines per campaign (greeting, disclosure, recording notice,
  close, callback messages). This cuts latency and cost.
- Numbers, dates and prices are normalised to speakable text before TTS ("15/11" → "pandrah November",
  "₹2,000" → "do hazaar rupaye") in the campaign language.

### 12.7 Fillers

If the LLM's first token has not arrived by CONFIGURABLE 700 ms after end of turn, play a short cached
filler ("Ji…", "Achha…", "Okay,") once per turn. Never more than one filler in a row.

### 12.8 Recording

Record ourselves from the media stream (more control than provider recording). Store as compressed
audio (e.g. Opus/MP3) in object storage under `tenant/{tenantId}/campaign/{campaignId}/{callId}.ogg`,
encrypted at rest. Link from the call record.

---

## 13. Runtime / LLM integration (fast path)

Calltime does **not** call the LLM directly. It calls Runtime, like other agents do, using a new
**realtime fast path**.

### 13.1 Fast path contract (add to Runtime)

```
POST /runtime/realtime/turn   (or the Runtime's internal RPC equivalent)
{
  "priority": "realtime",
  "surfaceInstanceId": "...",
  "tenantId": "...",
  "sessionId": "call:{callId}",            // conversation state key
  "agent": "calltime-interest-check",
  "systemContextRef": "campaign:{campaignId}:v{version}",   // cached; do not resend each turn
  "history": [ { "role": "assistant"|"user", "text": "...", "interrupted": bool } ],
  "state": "PITCH",                        // current state-machine state
  "elapsedTalkSec": 34,
  "tools": ["set_outcome","record_answer","send_details","request_callback_time","opt_out","end_call","transfer"?]
}
→ streamed response: text chunks + tool calls, as they are generated
```

Requirements:

- **Streaming** first token target ≤ 500 ms. Use a fast model tier; quality of a 1-minute call does
  not need the biggest model. Model choice is CONFIGURABLE per campaign plan.
- **Prompt caching**: the campaign system context (rules, offer, FAQ, persona, language) is built once
  per campaign version and cached in Runtime. Each turn sends only history + state.
- **Priority**: realtime requests bypass Runtime's normal queue and use the reserved LLM share (6.2).
- **Timeout**: if no first token in CONFIGURABLE 1.5 s → worker plays a cached safe line for the
  current state (e.g. "Hamari team aapko detail mein batayegi.") and moves the state machine forward.
  If 2 timeouts in one call → polite close, outcome from what we know, flag `needs_review`.

### 13.2 System context (built from campaign config)

Sections, in this order:

1. Role: "You are {agentName}, an AI assistant calling on behalf of {tenantBrand}. You make short,
   polite invitation calls. You never sell, never ask for payment, never negotiate."
2. Language and style: language, formality (ji/aap), max 2 short sentences per turn, natural spoken
   style, no lists, no markdown, no emojis.
3. Offer (structured): event name, date, time, venue, city, price range (only if tenant allows
   mentioning it), hook, link, organiser.
4. Allowed answers: the FAQ list. "If a question is not covered, say the team will explain when they
   call. Never invent details."
5. Forbidden: discounts not in config, payment, personal data collection beyond configured questions,
   promises, opinions about other events, arguing.
6. Flow: the state machine description and which tool to call when.
7. Questions to collect (if configured): e.g. group size, best callback time, area of interest.
8. Opt-out rule.

### 13.3 Tools the LLM can call

| Tool | Args | Effect |
| --- | --- | --- |
| `set_outcome` | `outcome` (interested / maybe / not_interested / wrong_number / callback_requested / opt_out / message_taken / no_response), `confidence` 0–1 | Updates current best outcome. |
| `record_answer` | `field` (from configured questions), `value` | Stores structured answers. |
| `request_callback_time` | `text` (as said) | Stored raw; resolved to a date-time in post-call (IST, relative words like "kal shaam" resolved against call time). |
| `send_details` | `channel` (whatsapp / sms) | Queues follow-up after call. |
| `opt_out` | — | Tenant DNC + outcome opt_out + go to close. |
| `end_call` | `reason` | Worker plays close line (cached) then hangs up. |
| `transfer` | — | Only if `feature.live_transfer`; worker bridges to manager's phone. |

The worker validates every tool call (e.g. `record_answer` field must exist in config). Invalid → ignore
and log.

### 13.4 Guardrail check on output

Before sending text to TTS, run a fast rule-based check per chunk:

- Contains a price/discount/date/venue that does not match the offer → replace the chunk with the
  safe line and log `guardrail_block`.
- Contains words from a CONFIGURABLE blocklist (payment, OTP, card, UPI ID request) → block.
- Longer than CONFIGURABLE 40 words in one turn → cut at sentence boundary.

---

## 14. Campaign configuration (what the event company fills in)

A simple form, not a prompt editor. The system generates the script.

### 14.1 Form fields

**Offer (structured — this is the future agent-to-agent payload, Section 26)**

| Field | Required | Validation |
| --- | --- | --- |
| Event name | yes | ≤ 80 chars |
| Event type | yes | enum: concert, gala, party, expo, workshop, conference, festival, sports, other |
| Date(s) and start time | yes | future date |
| Venue name, city | yes | |
| Short description | yes | 2–3 lines, ≤ 300 chars |
| Hook | yes | 1 line, ≤ 120 chars ("Early bird 30% off till Friday") |
| Price info | no | text + flag `may_mention_price` (default false) |
| Booking/info link | yes | valid URL (used in WhatsApp follow-up, not read aloud) |
| Organiser brand name | yes | default tenant brand |

**Agent**

| Field | Default |
| --- | --- |
| Agent name | "Riya" |
| Voice | from voice list (preview button) |
| Language | Hinglish; options Hindi, English, + others when STT/TTS support |
| Formality | formal (aap/ji) |

**Questions to collect (optional, max 3)**: choose from templates — group size, best callback time,
preferred session/day, area of interest — or a custom short question.

**FAQ (optional, max 10)**: question + short answer (≤ 200 chars each).

**Follow-up**: send WhatsApp to interested/maybe (default on), template selection (Section 19).

**Calling**: start date, end date (≤ event date), daily window inside 09:00–21:00, days of week,
max concurrent calls (≤ plan), retry policy (default from Section 16).

**Callback**: callback mode for dedicated numbers; manager's callback phone (for forward / transfer).

### 14.2 Script generation and approval

1. On save, Campaign Service builds the **system context** (13.2) and renders a **readable script preview**
   (greeting, pitch, ask, branches, close) in the chosen language using the LLM once (P2 priority).
2. Fixed lines (greeting, disclosure, recording notice, close, callback message, screening message)
   are generated and cached as audio.
3. The manager reads the preview, can edit the generated pitch text (within length limits), and must
   press **"Test call to my phone"** at least once. The test call is a real call to the manager's
   verified phone, using the same pipeline (billed at cost or free — CONFIGURABLE).
4. Manager presses **Approve**. Only approved campaigns can dial. Any edit to the offer/script after
   approval creates a new version and requires re-approval (contacts already called keep their results).

### 14.3 Campaign states

`draft → ready_for_test → approved → scheduled → running ⇄ paused → completed | canceled`
Automatic pause reasons: wallet low, quality guard (8.7), event date passed, admin action.

---

## 15. Contacts and lists

### 15.1 CSV import

Columns: `phone` (required), `name`, `source` (required: past_attendee, website_form,
instagram_enquiry, event_registration, referral, other), `language` (optional override), `notes`
(optional, shown to manager, not to LLM unless flagged), `group` (optional tag).

Import steps:

1. Parse; report row errors back to the user (downloadable error file).
2. Normalise phone to E.164 (default country +91). Reject invalid lengths, landline patterns that the
   provider cannot reach (VERIFY), duplicates within file.
3. De-duplicate against existing contacts of the tenant (merge by phone; keep the latest name).
4. Check global and tenant DNC → mark as excluded.
5. DND scrub (provider/service) → mark as excluded with reason.
6. Show summary: total, valid, duplicates, DNC excluded, DND excluded, invalid.
7. The manager attaches the list to a campaign.

### 15.2 Rules

- `purchased_list` is not an allowed source. Show a short explanation in the UI.
- Max contacts per campaign CONFIGURABLE per plan.
- A contact belongs to the tenant; the same phone in two tenants is two separate contacts (isolation),
  but global DNC and the cross-tenant frequency rule (8.3 step 4) use the phone number.

---

## 16. Dialer and scheduling (fair queue, retries, pacing)

### 16.1 Attempt lifecycle

```
pending → queued (due now) → reserved (slot + number + wallet hold) → dialing → ringing
  → answered → in_call → ended
  → busy | no_answer | failed | canceled
ended/busy/no_answer/failed → outcome decision → retry scheduled | final
```

### 16.2 Dialer loop (runs continuously; leader-elected single scheduler or partitioned by campaign)

Every CONFIGURABLE 500 ms:

1. Compute free P0 slots across workers.
2. Pick the next due attempt by weighted round-robin (6.3).
3. Run Compliance Gate (10.2). Deny → mark attempt with reason; if reason is temporary (window, cap),
   reschedule; else final excluded.
4. Select number (8.3). None → put back, wait.
5. Wallet hold (20.3). Fail → pause campaign `wallet_low`, notify.
6. Reserve slot on a worker; create signed media URL.
7. `provider.dial(...)`.
8. Release holds/slot on any failure.

### 16.3 Retry policy (default, CONFIGURABLE per campaign)

| Result | Retry? | When |
| --- | --- | --- |
| no_answer | yes, max 2 more | +4 h, then next day at a different time block (morning ↔ evening) |
| busy | yes, max 2 more | +1 h, then +1 day |
| unreachable (switched off) | yes, max 1 more | next day |
| failed (network/provider) | yes, max 2 | +15 min |
| failed_internal (our crash) | yes, max 1 | +2 h |
| callback_requested (person said call later) | yes, once | at requested time if resolvable and inside window, else next day same block. This is a **human** callback item too (review queue) — CONFIGURABLE whether AI or human calls back; default human. |
| no_response (silent) | yes, max 1 | next day |
| connected with any other outcome | no | — |
| opt_out / wrong_number | no, ever | — |

Never retry after the event date. Stop all retries when the campaign completes.

### 16.4 Pacing

- Progressive dialing only: one dial per reserved slot.
- Per-campaign max dial rate CONFIGURABLE (default 2 new dials/second) to avoid bursts on numbers.
- Spread a number's calls across the day; stop using a number for the day at its cap.

---

## 17. Outcomes, summaries and the review queue

### 17.1 Outcome buckets (final per contact per campaign)

| Bucket | Meaning | Next step |
| --- | --- | --- |
| 🔥 `interested` | Said yes / wants more info / asked about booking | Review queue (top), human calls |
| 📞 `callback_requested` | Busy now, call later | Review queue with time |
| ↩️ `called_back` | Person called the number back | Review queue |
| 🤔 `maybe` | Unsure, OK with details | WhatsApp details; review queue (lower) |
| 📨 `message_taken` | Screening assistant took a message | WhatsApp details; review queue (lower) |
| ❌ `not_interested` | Said no | Done |
| 🚫 `opt_out` | Asked not to be called | Tenant DNC, done |
| ⚠️ `wrong_number` | Not the person / not relevant | Done, flag contact |
| 📵 `unreachable` / `no_answer` / `busy` | Never connected after retries | Done (report) |
| 🤐 `no_response` | Connected but no meaningful speech | Done after retry |
| 🛑 `failed` | Technical failure after retries | Done (report) |

### 17.2 Post-call summary (P2 job, within 60 s of call end)

Input: transcript (with interruption marks), state-machine trace, tool calls, configured questions.
Output JSON (validate strictly; retry once on invalid; else `needs_review` with raw transcript):

```json
{
  "outcome": "interested",
  "confidence": 0.86,
  "summary": "Interested in the gala, coming with 3 friends, asked about parking. Prefers a call after 6 pm.",
  "answers": { "group_size": "4", "best_callback_time": "after 6 pm" },
  "callback_at": "2026-11-02T18:00:00+05:30",
  "questions_asked_by_person": ["Is parking available?"],
  "unanswered_questions": ["Is parking available?"],
  "sentiment": "positive",
  "language_used": "hinglish",
  "flags": ["asked_price"],
  "needs_review": false
}
```

Rules:

- `summary` ≤ 2 sentences, in English (CONFIGURABLE: tenant's UI language).
- If the summary model's outcome disagrees with the in-call `set_outcome` → take the more cautious one
  for automation (e.g. don't send WhatsApp if one says opt_out) and set `needs_review: true`.
- `confidence < 0.6` → `needs_review: true`.
- Resolve relative times ("kal shaam", "Monday ke baad") against call time in IST; vague words stay as
  text, never invent a date.
- `unanswered_questions` feed the FAQ suggestions (18.4).

### 17.3 Review queue item

Created for: interested, callback_requested, called_back, maybe, message_taken, and any `needs_review`.

Fields: contact name/phone, campaign, outcome, summary, answers, callback_at, priority score,
recording link, transcript link, status (`new → in_progress → done`), manager result
(see 18.2), corrections.

Priority score (higher first):
`interested 100, called_back 90, callback_requested 80 (boost +30 when callback_at within 2 h),
maybe 50, message_taken 40, needs_review +20, asked_price/asked_booking +15, older than 24 h +10`.

---

## 18. Calling manager dashboard

The manager is the daily user. The product should make them feel in control and look good to their boss.

### 18.1 Screens

1. **Today** (home): hot leads list (review queue sorted by priority), campaigns running now with live
   counters (dialed, connected, interested), wallet balance, alerts.
2. **Lead card**: name, phone, outcome, 2-line summary, answers, callback time, ▶ play recording,
   transcript (with interruption marks), buttons: **Call now** (click-to-call from manager's phone via
   tel: link or provider click-to-call — CONFIGURABLE), **Mark result**, **Correct summary**,
   **Send WhatsApp**, **Do not call**.
3. **Campaigns**: list, create (form 14.1), preview script, test call, approve, schedule, pause/resume,
   results.
4. **Campaign results**: funnel (contacts → dialed → connected → interested → manager-contacted →
   converted), outcome breakdown, pickup rate by hour, top unanswered questions, cost so far.
5. **Contacts**: lists, import, exclusions and reasons.
6. **Manager stats** ("their numbers"): leads handled, calls made, conversions, conversion rate, time
   saved (estimated dials avoided × average dial time).
7. **Wallet**: balance, top-up, usage by campaign, invoices.
8. **Settings**: users/roles, callback phone, brand name, default voice/language.

### 18.2 Manager result (after they call the lead)

`converted` (booked/paid), `follow_up` (with date), `not_converted`, `unreachable`, `wrong_info`.
Optional note and booked quantity/value. This closes the funnel and proves ROI.

### 18.3 Corrections

- Manager can change outcome and edit the summary. Store both original and corrected (for quality
  measurement and future tuning).
- "AI said something wrong" flag with a note → goes to admin quality review and lowers campaign quality
  stats.

### 18.4 FAQ improvement loop

- Unanswered questions from summaries are grouped (simple similarity) and shown as
  "People asked this — add an answer?" in the campaign. The manager adds an answer → new campaign
  version (minor; re-approval not required for FAQ-only changes — CONFIGURABLE).

### 18.5 Live monitoring (nice to have, after v1)

Listen-in to a live call (one-way), and "take over" when live transfer is enabled.

---

## 19. Follow-ups (WhatsApp / SMS)

- WhatsApp Business API via the telephony provider or Meta-approved BSP (owner sets up, Section 27).
- Pre-approved message templates (WhatsApp requires approval): e.g.
  "Hi {name}, thanks for speaking with {brand}'s assistant. Here are the details for {event} on {date}
  at {venue}: {link}. Our team will contact you soon." (interested)
  and a "maybe/message_taken" variant without the callback promise.
- Send only when: outcome in (interested, maybe, message_taken, called_back) AND `send_details`
  allowed AND not opt_out AND contact has not received this campaign's message already.
- SMS fallback if WhatsApp fails (requires DLT-registered SMS template — VERIFY).
- Stage-3 foundation: the link points to an **offer page** generated per campaign (Section 26) — a
  simple public page with the structured offer and a machine-readable JSON version.
- Bill follow-ups at cost + margin (rate card).

---

## 20. Billing: add-on fee, wallet, metering, cost tracking

### 20.1 Pricing model (numbers are placeholders — CONFIGURABLE rate card, owner decides)

- **Calltime add-on**: monthly fee per tenant (e.g. ₹1,500–3,000) — covers dashboard, pool numbers,
  compliance, review tools.
- **Prepaid minute wallet**: calls deduct from balance. Price per connected minute e.g. ₹6–10
  (≈ 2× COGS). Billed **per second** of connected time (or 30-second pulses if that matches the
  provider better — CONFIGURABLE `billing.pulse_seconds`).
- Unanswered / busy / failed / carrier announcement: free to tenant by default (CONFIGURABLE).
- Premium: dedicated number (₹/month), premium voice (+₹/min), extra languages, live transfer minutes.
- Follow-up messages: per message.
- Later: outcome-based pricing (per interested lead) once conversion data exists.

Sales comparison to show in UI/pitch (not code logic): a campaign of 2,000 contacts × 35% pickup ≈
700 conversations ≈ 840 minutes → ~70–100 warm leads for the manager to close.

### 20.2 Rate card table

`rate_card(id, plan, item, unit, price_paise, effective_from)` where item ∈
`connected_second, premium_voice_second, whatsapp_message, sms_message, transfer_second,
dedicated_number_month, addon_month`.

### 20.3 Wallet flow

1. Balance in paise. Ledger is append-only: `topup, hold, release, charge, refund, adjustment`.
2. Before dialing: **hold** = price of CONFIGURABLE 2 minutes (max call length). Fail if
   `available = balance − active holds` < hold amount.
3. After the call: compute charge from billable seconds (provider-reported if available, else ours,
   take the provider's when they differ and log the difference), **release** hold, **charge** actual.
4. Low balance threshold (CONFIGURABLE, e.g. 100 minutes worth) → notify owner/manager.
   Below the hold amount → auto-pause running campaigns with reason `wallet_low`.
5. Top-up via payment gateway (Razorpay or what Surface already uses). Invoices with GST
   (**VERIFY** tax handling with accountant).
6. Concurrency safety: holds and charges are atomic DB transactions with a row lock on the wallet.

### 20.4 COGS tracking (our cost, per call)

Record per call: telephony seconds × provider rate (or provider cost from webhook), STT seconds × rate,
TTS characters × rate, LLM input/output tokens × rate, follow-up message cost, number rental (allocated
monthly). Report margin per tenant/campaign. Alert if any campaign's margin < CONFIGURABLE 30%.

Reference rough costs from discussion (India, 2026, **VERIFY** with quotes): telephony ₹0.5–1.2/min,
STT ₹0.4–0.7/min, TTS ₹0.3–1/min (budget) or ₹5+/min (premium), LLM ₹0.2–1/min; all-in ≈ ₹2–4/min
budget stack, ₹5–8/min premium; number rental ₹500–1,500/month each.

---

## 21. Data model

PostgreSQL. All tenant tables have `tenant_id` and every query filters by it (enforce with row-level
security or a repository layer that requires tenant_id). Timestamps in UTC; display in IST.

```
surface_instances(id, name, runtime_endpoint, dedicated_worker_group?, created_at)

tenants(id, surface_instance_id, brand_name, legal_name, dlt_entity_id?, status, created_at)
users(id, tenant_id?, role: platform_admin|owner|manager|viewer, name, phone, email, created_at)

subscriptions(id, tenant_id, plan, status, max_concurrent_calls, started_at, renews_at)
wallets(tenant_id PK, balance_paise, updated_at)
wallet_ledger(id, tenant_id, type, amount_paise, ref_type, ref_id, created_at)
rate_cards(id, plan, item, unit, price_paise, effective_from)

offers(id, tenant_id, campaign_id, version, name, type, starts_at, ends_at, venue, city,
       description, hook, price_text, may_mention_price, link, organiser, json_payload, created_at)

campaigns(id, tenant_id, name, status, version, language, agent_name, voice_id, formality,
          questions_json, faq_json, followup_json, window_json, retry_policy_json,
          max_concurrent_calls, start_date, end_date, approved_by, approved_at,
          system_context_ref, created_at, updated_at)
campaign_versions(id, campaign_id, version, snapshot_json, created_at)
campaign_audio_cache(id, campaign_id, version, line_key, lang, url)

contacts(id, tenant_id, phone_e164, name, source, language?, notes, tags, created_at)
contact_lists(id, tenant_id, name, created_at)
contact_list_members(list_id, contact_id)
campaign_contacts(id, campaign_id, contact_id, status, final_outcome?, attempts_count,
                  next_attempt_at?, sticky_number_id?, excluded_reason?, updated_at)

dnc_global(phone_e164 PK, reason, source, created_at)
dnc_tenant(tenant_id, phone_e164, reason, created_at, PK(tenant_id, phone_e164))
dnd_scrub(phone_e164, status, scrubbed_at, provider_ref)

numbers(id, e164, provider, type, tenant_id?, series, status, daily_cap_connected, daily_cap_dials,
        health_score, quarantine_until?, branded_name?, callback_mode, created_at)
number_daily_stats(number_id, date_ist, dials, connected, short_hangups, talk_seconds,
                   PK(number_id, date_ist))

attempts(id, tenant_id, campaign_id, campaign_contact_id, attempt_no, number_id, worker_id?,
         provider, provider_call_id?, gate_decision, gate_reason?, status, dialed_at, answered_at?,
         ended_at?, billable_seconds?, hangup_by?, error?, created_at)

calls(id, attempt_id, tenant_id, detect_result, final_state, best_outcome, recording_url,
      transcript_url, latency_p50_ms, latency_p95_ms, interruptions_count, guardrail_blocks,
      llm_timeouts, created_at)
call_turns(id, call_id, idx, role, text, interrupted, started_ms, ended_ms, latency_ms)
call_tool_calls(id, call_id, idx, tool, args_json, accepted, created_at)

outcomes(id, call_id?, campaign_contact_id, outcome, confidence, summary, answers_json,
         callback_at?, questions_json, unanswered_json, sentiment, flags, needs_review,
         corrected_outcome?, corrected_summary?, corrected_by?, created_at)

review_items(id, tenant_id, campaign_id, campaign_contact_id, outcome_id, priority, status,
             assigned_to?, manager_result?, manager_note?, booked_qty?, booked_value_paise?,
             updated_at)

followups(id, tenant_id, campaign_contact_id, channel, template, status, provider_ref, cost_paise,
          created_at)
callbacks(id, number_id, from_phone, matched_attempt_id?, tenant_id?, action, created_at)

call_costs(call_id PK, telephony_paise, stt_paise, tts_paise, llm_paise, other_paise, total_paise)
audit_log(id, actor, tenant_id?, action, target, data_json, created_at)
```

Indexes: `campaign_contacts(campaign_id, status, next_attempt_at)`, `attempts(provider_call_id)`,
`attempts(number_id, dialed_at)`, `contacts(tenant_id, phone_e164) unique`,
`review_items(tenant_id, status, priority desc)`, `callbacks lookup: attempts(number_id, to_phone, dialed_at desc)`
(store `to_phone` on attempts for this).

---

## 22. Milestones (build order with definition of done)

Each milestone ends with its tests passing (Section 23). Do not start the next until done.

### M0 — Accounts and sandbox (owner + engineer)

- Owner: provider account + KYC, start DLT, STT/TTS keys, LLM via Runtime, India-region hosting
  (Section 27).
- Engineer: repo/module skeleton in the Surface/Runtime codebase, config system, fake provider (23.2).
- **Done:** fake provider can "dial" and stream a WAV file as caller audio over WebSocket.

### M1 — Telephony and media loop

- Provider adapter for the chosen provider (dial, status webhooks, media WebSocket, hangup, signature
  verification).
- Worker: accept media, play a fixed TTS sentence, run STT on caller audio, log transcript, hang up.
- **Done:** a real call to a test phone plays "Hello, this is a test" and logs what the person said.

### M2 — Voice pipeline with interruptions

- VAD, endpointing, streaming STT, streaming TTS with chunking and marks, barge-in (12.5), backchannel
  ignore list, fillers, recording (12.8), latency metrics per turn.
- Simple echo bot for testing: repeats what you said.
- **Done:** p50 response latency ≤ 1.0 s on test calls; interrupting the agent stops it within 200 ms
  (measured via marks); "haan/hmm" does not interrupt; stereo recording saved.

### M3 — Conversation via Runtime

- Runtime realtime fast path (13.1) with priority and LLM reservation (6.2.4).
- System context builder (13.2), tools (13.3), guardrails (13.4), state machine (11.2) with limits
  (11.5), detection (11.3), timeouts/safe lines.
- Hardcoded test campaign.
- **Done:** 30 scripted test calls (Section 23.4 scenarios) pass; no call exceeds 90 s of talk;
  disclosure always spoken.

### M4 — Campaigns, contacts, compliance, dialer, number pool, pool priority

- Campaign Service + form + script preview + test call + approval (Section 14).
- Contacts import + DNC + DND scrub (Section 15).
- Compliance Gate (Section 10).
- Dialer with fair queue, retries, pacing (Section 16).
- Number pool selection, caps, health, quarantine, admin UI (Section 8).
- Pool integration: P0 slots, admission control, autoscaling signals, drain (Section 6).
- **Done:** a campaign of 200 test contacts (fake provider) runs with 2 tenants concurrently, fair
  share respected, calling window respected, caps respected, a quarantined number is never used,
  a worker drain finishes live calls without dropping them.

### M5 — Outcomes, summaries, review queue, dashboard

- Post-call summary (17.2), outcome buckets, review items + priority, dashboard screens 18.1 (1–6),
  manager results, corrections, FAQ suggestion loop.
- **Done:** after a test campaign, the manager sees interested leads first with correct summaries;
  manager result updates the funnel.

### M6 — Wallet and billing

- Rate card, wallet, holds, charges, ledger, top-up integration, low-balance pause, COGS per call,
  margin report.
- **Done:** 100 concurrent fake calls never overdraw a wallet; ledger sums equal balance; pausing on
  low balance works.

### M7 — Callbacks and follow-ups

- Callback Router (Section 9), cached messages, press-9 opt-out.
- WhatsApp/SMS follow-ups (Section 19), offer page with JSON (26.3).
- **Done:** calling back a pool number plays the right tenant's message; interested contacts receive
  WhatsApp with the link.

### M8 — Hardening and pilot

- Load test (23.5), chaos tests (worker kill, provider webhook delays, STT outage), alerts (Section 24),
  security review (Section 25), legal checklist confirmed by owner.
- Pilot with **one event company**, real campaign, small list (200–500 contacts).
- **Done:** pilot metrics reviewed with the customer: pickup rate, interested rate, manager conversion,
  complaints = 0 unresolved, latency targets met.

### M9 — Stage 2: screening assistants (after pilot)

- Improve detection and SCREENING_MESSAGE behaviour from pilot data; `message_taken` reporting.
- Optional: live transfer (feature flag).

---

## 23. Testing plan and acceptance criteria

### 23.1 Unit tests

- Phone normalisation, CSV import edge cases, DNC/DND exclusion.
- Compliance Gate: every rule allow/deny incl. window edges (08:59, 09:00, 20:59, 21:00 IST), caps.
- Number selection: sticky, caps, quarantine, cross-tenant 3-day rule, tie-breaks.
- Health score formula and quarantine/warm-up transitions.
- Dialer fair share (simulate 3 tenants with different weights).
- Retry policy table → next_attempt_at.
- Wallet: hold/release/charge, concurrent holds, never negative.
- Guardrails: wrong price/date blocked; blocklist words blocked.
- Summary JSON validation and relative time resolution in IST.

### 23.2 Fake provider (build first, M0)

Implements `TelephonyProvider`. Configurable behaviour per test: answer after N s, busy, no answer,
fail, hang up at T, stream a given audio file or a scripted TTS "caller" voice, send webhooks late or
twice, drop media. Used in all automated tests and load tests.

### 23.3 Synthetic caller

A test harness that plays the person: uses TTS to speak scripted lines in Hindi/Hinglish/English with
timing (including interruptions mid-sentence and backchannels), and STT to record what the agent said.

### 23.4 Conversation scenarios (must all pass in M3 and before every release)

1. Interested, answers group size and callback time.
2. Not interested, polite.
3. Maybe → accepts WhatsApp.
4. Asks a FAQ question → correct answer.
5. Asks a non-FAQ question → "team will explain", no invented details.
6. Interrupts during pitch with a question.
7. Interrupts with "mujhe call mat karo" → opt-out immediately.
8. Backchannels "haan… hmm…" during pitch → agent continues.
9. Wrong person.
10. "Abhi busy hoon, kal shaam call karo" → callback_requested with resolved time.
11. Silence after answer → re-prompt once → end no_response.
12. Carrier announcement "switched off" → unreachable, no greeting played.
13. Screening assistant phrase → short message, message_taken.
14. Person asks for discount → no discount promised.
15. Person tries to give card/UPI details → agent declines; digits redacted in transcript.
16. Person talks a lot → call closes by 90 s.
17. Person speaks English when campaign is Hinglish → agent follows the person's language (within supported).
18. LLM timeout injected → safe line, call continues/ends gracefully.
19. Worker killed mid-call → attempt failed_internal, retry scheduled, billing correct.
20. Duplicate/late provider webhooks → no double charge, correct status.

### 23.5 Load test

- Fake provider + synthetic callers: ramp to CONFIGURABLE target (e.g. 200 concurrent calls) across
  N workers while Runtime P1 load runs.
- **Pass:** p95 turn latency ≤ 1.5 s at target load; Runtime P1 still served at ≥ its floor share;
  no connected call waits for a slot; autoscaler adds workers before saturation.

### 23.6 Real-call testing (friendly numbers)

5–10 team/friend phones, different networks (Jio, Airtel, Vi, BSNL), speakerphone and earphones,
noisy background, Hindi/Hinglish/English speakers. Track issues in a shared sheet; fix before pilot.

### 23.7 Acceptance criteria for v1 launch

- All scenarios 23.4 pass.
- Latency p50 ≤ 1.0 s, p95 ≤ 1.5 s on real calls.
- Barge-in stop ≤ 200 ms p95.
- Summary outcome agrees with human review on ≥ 90% of 100 sampled calls.
- 0 calls outside the calling window, 0 calls to DNC/DND-excluded contacts (audit query).
- Wallet ledger reconciles exactly.
- Owner confirmed legal/compliance checklist (Section 27).

---

## 24. Observability and alerts

### Metrics (per tenant, campaign, number, worker, as relevant)

- Dials, connected, pickup rate, outcomes by bucket, opt-out rate, short-hangup rate.
- Turn latency (p50/p95), barge-in stop time, LLM first-token time, STT/TTS errors, LLM timeouts,
  guardrail blocks.
- P0 slots used/total, dialer backlog, pool_exhausted, worker count, drains.
- Wallet holds, charges, margin.
- Number health and quarantine events.

### Logs and traces

- One trace per call: dial → answer → each turn (STT, LLM, TTS timings) → end → summary → follow-up.
- Never log raw phone numbers in plain logs; use contact/attempt IDs. Redact transcripts in logs.

### Alerts

| Alert | Condition |
| --- | --- |
| Latency high | campaign p95 > 1.5 s for 10 min |
| LLM timeouts | > 2% of turns in 10 min |
| Provider errors | dial failure rate > 10% in 5 min |
| Pool exhausted | no number available > 10 min |
| Number quarantined | any |
| Tenant quality guard | any pause |
| Slots saturated | > 90% for 5 min |
| Margin low | campaign margin < 30% |
| Compliance anomaly | any dial outside window or to excluded contact (should be 0) |

---

## 25. Security, privacy, retention

- Tenant isolation at the data layer (row-level security or enforced repository filter) + tests.
- Encrypt recordings and transcripts at rest; signed short-lived URLs for playback; access by role.
- PII: phone numbers encrypted at rest or at least in a restricted column; hashed for cross-tenant
  rules where possible.
- Webhook signature verification; media WebSocket signed tokens; rate-limit public endpoints.
- Secrets (provider keys, STT/TTS keys) in the platform secret store, never in code or logs.
- Retention (CONFIGURABLE, **VERIFY** with DPDP guidance): recordings 90 days, transcripts and
  outcomes 1 year, audit 1 year, then delete. Tenant can request deletion of a contact (erase
  recordings/transcripts, keep DNC entry as a hash).
- Data processing terms with tenants: they are responsible for the lawful source of contacts; we
  enforce source tags and DND/DNC.
- Audit log for: approvals, DNC changes, number quarantine, wallet adjustments, exports.

---

## 26. Future stages (screening assistants, agent-to-agent)

Agreed direction: we do **not** build the consumer side (call screening assistants like Truecaller,
Google, Apple). We benefit as they spread, and make Calltime the best-behaved business-side agent.

### Stage 1 (v1): AI → human

Interest-check calls; humans close.

### Stage 2: AI → screening assistant

- More calls answered by assistants. Calltime detects them (11.3), delivers a short structured
  message, sends details by WhatsApp/link, records `message_taken`.
- Track the share of calls answered by assistants per month to know when Stage 3 matters.

### Stage 3: agent ↔ agent

Example: Ravi's assistant has the standing instruction "I'm looking for events; tell me about such
calls; say maybe-interested and ask for details; I decide."

- Agents recognise each other and **skip voice**; exchange structured offers instead.
- Ravi's agent may negotiate within limits ("interested if under ₹2,500 and on a weekend");
  humans approve the final step on both sides.

### Foundations to build now (already in v1 plan)

1. **Offer as structured data** (`offers.json_payload`), voice script generated from it.
2. **Offer page per campaign** with a public URL and a machine-readable JSON version
   (`/o/{offerId}` and `/o/{offerId}.json`, schema below). Linked in every follow-up.
3. **Structured outcomes** (17.2), so agent replies (interested / maybe / no / message taken + fields)
   slot in.
4. **Honest behaviour** always (AI disclosure, who we call for), since assistants will favour
   well-behaved callers.

Offer JSON (version it; keep backward compatible):

```json
{
  "schema": "calltime.offer.v1",
  "offerId": "off_123",
  "organiser": { "name": "ABC Events", "verified": true },
  "event": {
    "name": "Winter Gala Night",
    "type": "gala",
    "startsAt": "2026-11-15T19:00:00+05:30",
    "endsAt": "2026-11-15T23:00:00+05:30",
    "venue": "Grand Hall",
    "city": "Jaipur",
    "description": "An evening of live music and dinner.",
    "hook": "Early bird 30% off till Friday"
  },
  "price": { "text": "From ₹2,000 per person", "mayMention": true },
  "links": { "info": "https://...", "booking": "https://..." },
  "responseOptions": ["interested", "maybe", "not_interested"],
  "contact": { "callbackRequestUrl": "https://.../o/off_123/respond" }
}
```

Later (not v1): `POST /o/{offerId}/respond` accepting `{ response, fields, agentId }` so an assistant
can answer without voice; follow emerging agent-to-agent standards when they settle.

---

## 27. What the owner (human) must provide

The implementer cannot do these. Start the slow ones (DLT, KYC) first.

### Must have before M1

1. **Telephony provider account** (Exotel / Plivo / Tata / Airtel IQ), company KYC, API keys,
   **2–3 numbers** to start. Confirm in writing:
   - real-time bidirectional audio streaming over WebSocket with playback clear,
   - per-minute rate and **billing pulse**, number rental, channel/concurrency limits,
   - which number series to use for promotional calls, DLT help, DND scrub API.
2. **DLT registration** as principal entity (via provider guidance) — start immediately.
3. **STT key** (Sarvam and/or Deepgram), **TTS key** (Sarvam; optional Cartesia/ElevenLabs).
4. **LLM** access through the existing Runtime with streaming; agreement to add the realtime fast path.
5. **India-region hosting** in the same pool infrastructure as Runtime, public HTTPS + WebSocket endpoints.

### Before pilot

6. A test event + script + FAQ (real or dummy).
7. 5–10 friendly test phones on different networks.
8. WhatsApp Business API (via provider/BSP) and approved templates. SMS DLT templates if SMS fallback.
9. Payment gateway for wallet top-ups.
10. Legal/compliance check by someone who knows TRAI/TCCCPR, call recording consent and DPDP.
11. One pilot event company.

---

## 28. Open decisions and defaults

The implementer uses the default unless the owner decides otherwise.

| Decision | Default |
| --- | --- |
| Launch languages | Hinglish + Hindi + English |
| Voice | Female, name "Riya"; male option available |
| AI disclosure in first line | Yes (mandatory) |
| Live transfer in v1 | No (feature flag, off) |
| Callback mode on pool numbers | lookup_message |
| Price per connected minute | ₹8 (rate card) |
| Add-on monthly fee | ₹2,000 (rate card) |
| Billing pulse | per second |
| Unanswered calls charged | No |
| Test calls charged | No (max 10 per campaign version) |
| Daily cap per number | 150 connected / 400 dials |
| Calling window | 09:00–21:00 IST |
| Max attempts per contact per campaign | 3 |
| Who calls back `callback_requested` | Human (review queue) |
| Logical Calltime per Surface instance on shared workers | Yes |
| P1 floor share when Calltime busy | 30% |
| LLM realtime reserved share | 30% |

---

## 29. Rules for the implementer

1. Follow milestones in order; each must pass its "Done" checks and tests before moving on.
2. Never hardcode values marked CONFIGURABLE. Put them in config with the defaults given here.
3. Never invent provider, STT, TTS, WhatsApp or payment API details. Read their docs; if unsure, build
   against the interface and the fake, and leave a clear TODO with the doc link to verify.
4. Every dial goes through the Compliance Gate. No code path may call `provider.dial` directly.
5. Every query on tenant data filters by `tenant_id`. Add a test for cross-tenant access.
6. The state machine, not the LLM, enforces time limits, disclosure and close.
7. The AI never sells, never asks for payment, never promises anything not in the offer. Guardrails
   must block it even if the prompt fails.
8. Keep the offer structured. The voice script is generated from it, never the other way round.
9. Measure latency on every turn from day one. Voice quality is the product.
10. Keep it small: if a feature is not in Sections 2 ("In scope") or the milestones, do not build it
    without the owner's approval.
11. When regulation, pricing or provider behaviour is unclear, mark it **VERIFY** in code comments and
    in a running `VERIFY.md` list for the owner — do not guess.
