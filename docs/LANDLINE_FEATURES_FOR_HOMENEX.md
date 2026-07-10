# Landline → HomeNex: Feature Transfer Analysis

**Status:** Research only. Nothing in this document has been implemented.
**Date:** 2026-07-10
**Author:** Claude (codebase analysis)

---

## 1. Scope and method

This document analyses the **Landline** codebase and identifies which of its features are worth porting into **HomeNex**, HomeNex being a WhatsApp-native CRM for Indian real estate agents.

**Landline location.** Landline is not a single repo. It is split across two:

- `/Users/dev/projects/apprend_tech/landline-backend` — Python 3.11, FastAPI, async SQLAlchemy, PostgreSQL, Redis, Celery Beat, Anthropic Claude API
- `/Users/dev/projects/apprend_tech/landline-frontend` — React + Vite

(There is also a stray `/Users/dev/projects/landline-frontend`, which appears to be a duplicate/older checkout. The `apprend_tech` pair is the live one.)

**What Landline is.** A B2B lead-generation and client-management platform for Apprend Technologies, which sells AI quality-management software to US/Canadian manufacturers (injection molding, CNC machining, metal stamping, food & beverage). Its two outbound channels are **cold email** and **cold calling**. Its distinguishing asset is not the CRM plumbing — it is the *encoded sales methodology*: ~4,100 lines of researched sales-strategy documentation, distilled into ~1,000 lines of Python constants that get injected into AI prompts.

**What I read.** Every file under `app/models/`, `app/routers/`, `app/services/`, `app/tasks/`; `app/main.py`; all seven documents in `docs/`; the frontend page and hook inventory; the test suite manifest. Test suite is currently **47 test files / 724 test functions** (the "465+ tests" figure in older notes is stale).

**HomeNex baseline** (so recommendations target real gaps). Already built: multi-agent WhatsApp webhook routing, auto-captured contacts, leads with pipeline stages, BLTC extraction + AI hot/warm/cold scoring, properties/inventory, site visits, follow-ups (CRUD only), commissions, Meta message templates, audit logs, EMI calculator, property micro-pages with view counters, festive greeting scheduling, 24-hour service-window tracking (`leads.last_inbound_at`), suggested replies, PWA. Backend is Node + Express + PostgreSQL with SQL migrations in `server/migrations/`.

**Related HomeNex docs.** `docs/FEATURE_RESEARCH.md` and `docs/IMPROVEMENTS_RESEARCH.md` already propose drip sequences (2.8), content view tracking (2.9), click-to-call (2.7), and portfolio pacing compliance (1.2). Where this document overlaps, it does not restate the *what* — it supplies the *how*, drawn from Landline's working implementation. Overlaps are flagged inline.

---

## 2. The central translation problem

Landline's two channels are **cold email** and **cold calling**, into a market where unsolicited contact is legal and cheap. HomeNex's channel is **WhatsApp Business API**, into a market where:

- Outside a 24-hour window from the buyer's last inbound message, you may only send **Meta-approved template messages**, not free text.
- Message volume and quality are policed by Meta's **quality rating** and per-number messaging tiers. A block is existential, not a nuisance.
- The lead is **inbound by construction** — the buyer messaged first. There is no cold list.

This inverts several of Landline's assumptions, and it means a naive port would be actively harmful. Three consequences run through everything below:

1. **"Cold email cadence" does not translate. "Multi-channel cadence" does.** Landline's 5-touch, 21-day email sequence assumes you may email a stranger repeatedly. HomeNex cannot. But Landline's *sequence state machine* — steps, delays, channels, exit-on-reply — translates perfectly to a compliant WhatsApp drip built from approved templates, with the phone call as a second channel.

2. **Cold calling is not dead weight — it is HomeNex's most under-served workflow.** Indian real estate agents call their leads constantly. WhatsApp is the capture and nurture channel; the phone is the closing channel. Landline's call queue, pre-call briefing, and script system have no HomeNex counterpart at all, and they map onto a real, daily, unautomated agent task.

3. **Landline's anti-spam machinery maps onto Meta quality protection.** `send_limiter.py` (per-contact frequency caps, daily caps, warmup ramp, business-hours send window) exists to protect email domain reputation. The identical machinery protects a WhatsApp number's quality rating. This is the same problem wearing a different hat, and `docs/IMPROVEMENTS_RESEARCH.md` §1.2 already names it as critical.

---

## 3. Recommendations at a glance

Ranked by (value to an Indian real-estate agent) × (portability) ÷ (effort).

| # | Feature | Landline source | HomeNex gap | Tier |
|---|---|---|---|---|
| 1 | Prioritised daily call queue | `services/call_queue.py` | No worklist exists | **A** |
| 2 | Pre-call briefing | `services/call_briefing.py` | No briefing exists | **A** |
| 3 | Next-best-action suggestions | `routers/suggestions.py` | Only per-lead reply hints | **A** |
| 4 | Signal recency decay + engagement velocity | `services/scoring.py` | Score never decays | **A** |
| 5 | Structured script/talk-track library | `services/call_scripts_data.py` | None | **A** |
| 6 | Objection-handling library + trend analytics | `call_scripts_data.py`, `routers/calls.py` | None | **A** |
| 7 | Autonomous background jobs (Celery Beat) | `tasks/celery_app.py` | One `setInterval` for festive sends | **A** |
| 8 | Send limiter / frequency caps / warmup | `services/send_limiter.py` | None | **A** |
| 9 | Sentiment + intent + buying-signal analysis | `services/sentiment_service.py` | None | **B** |
| 10 | Sequence/drip state machine | `models/sequence.py`, `models/outreach.py` | None | **B** |
| 11 | Client health scoring | `services/health.py` | None | **B** |
| 12 | Framework-structured AI generation | `services/ai_script_generator.py` | Flat prompts | **B** |
| 13 | Encoded domain knowledge as prompt constants | `services/outreach/ai_sales_guidelines.py` | Prompt strings inline | **B** |
| 14 | Notification queue | `models/call.py::CallNotification` | None | **B** |
| 15 | Trigger-event monitoring | `services/news_monitor.py` | None | **C** |
| 16 | Business-card OCR (Claude vision) | `services/ai_service.py::extract_business_card` | None | **C** |
| 17 | Groups / segmentation + bulk action | `routers/groups.py` | `contacts.labels` unused | **C** |
| 18 | Editable knowledge base | `models/knowledge.py` | None | **C** |
| 19 | A/B testing with significance | `services/ab_testing_service.py` | None | **D** |
| 20 | Reports suite | `routers/reports.py` | Basic stats only | **D** |

Tier A = port early, high leverage, low risk. B = strong, needs design work. C = valuable but narrower. D = defer.

---

## 4. Tier A — port these first

### 4.1 Prioritised daily call queue

**In Landline.** `app/services/call_queue.py` turns the lead database into a ranked call list. `generate_call_queue_for_session()` selects contacts at companies in active pipeline stages, then scores each with `score_lead()`:

- **Priority bucket** (drives the hot/warm/cold label): replied → hot; clicked → hot; 3+ opens → hot; 1+ open → warm; contacted within 14 days → warm; else cold.
- **Ordering score**: `replies×100 + clicks×40 + opens×15 + fit_score×0.3`, plus a flagship-industry bonus, plus an overdue boost (`min(days_since × 0.5, 20)`) so quiet leads resurface without ever outranking live engagement, plus `+15` for never-contacted leads.
- **Role-based timing bonus**: `+20` if the current hour falls inside the contact's role-optimal call window, `+10` if within an hour of it. Windows are keyed off job title — plant managers 7–9 AM and 4–5 PM, quality managers 10 AM–12 PM, executives 8–9 AM and 4–6 PM.
- **Cooling periods** (`_COOLING_PERIODS`): after a connected call, wait 3 days; voicemail 2; no-answer 1; gatekeeper 2; scheduled callback 7.
- **Idempotency**: a contact with an open `pending`/`rescheduled` call task is never double-queued.

Each result becomes a `CallTask` row carrying `priority`, `scheduled_at`, a human-readable `notes` reason ("Auto-queued (hot): replied to an email; fit score 82; optimal call window (10:00-12:00)"), and `optimal_call_window`.

**Adapted for HomeNex.** This is the single highest-value port. Indian agents wake up and ask "who do I call today?" and answer it from memory or a WhatsApp scroll. Replace Landline's signals with HomeNex's:

| Landline signal | HomeNex equivalent | Source |
|---|---|---|
| Email reply | Buyer sent a WhatsApp message | `messages` where `role='buyer'` |
| Link click | Opened a property micro-page | `property_page_views` |
| 3+ email opens | Viewed the same micro-page repeatedly | `property_page_views` grouped |
| Fit score | `leads.ai_score` / `leads.score` (BLTC) | `leads` |
| Industry priority | Budget band, or matched inventory available | `leads` × `properties` |
| Days since last touch | `now - leads.last_inbound_at` | `leads` |
| Never contacted | Lead created, agent never replied | `messages` |

Two HomeNex-native signals have no Landline counterpart and should rank *above* everything: **the 24-hour service window is about to close** (free-text reply still possible for N hours — call or message now, or you are locked into a template), and **a site visit is scheduled within 48 hours** (confirm attendance; no-shows are the dominant failure mode).

The role-timing table becomes a **buyer-availability table**. Landline's premise — that a plant manager is reachable at 7:30 AM — has a direct analogue: salaried Indian buyers are reachable at lunch (1–2 PM) and evenings (7–9:30 PM); weekends are prime for site-visit calls; calling a working buyer at 11 AM Tuesday wastes a dial. This table should be per-agent-configurable, because a broker working NRI investors has an entirely different clock (and `agents` already has a preferences surface via `PreferencesCard.jsx`).

Cooling periods translate unchanged, with WhatsApp-specific additions: after a lead explicitly asks you to stop, or after two consecutive unanswered calls, back off hard. Meta punishes what it reads as harassment.

**Why valuable.** It converts HomeNex from a passive record of what happened into a system that tells the agent what to do next, ranked, every morning. That is the difference between a database and a CRM the agent opens daily. It also directly monetises signals HomeNex *already collects and currently wastes* — `property_page_views` is written on every micro-page hit and read by nothing.

**Caveat.** Landline's queue is global (single-tenant-ish, with a `user_id` bolted on). HomeNex is multi-tenant by `agent_id` on every table. Queue generation must be per-agent and must never leak across tenants.

---

### 4.2 Pre-call briefing

**In Landline.** `app/services/call_briefing.py::build_briefing()` assembles, on one screen, everything a rep needs before dialling: who they're calling and their title, the phone number (falling back contact → company), engagement summary (emails sent/opens/clicks/replies, days since last contact), the industry's pain points, the last five interactions, and the right industry call script.

Its cleverest part is `talking_points`, which is **rule-based, not AI**, and therefore instant and free:

> - replies > 0 → "They've replied before — reference the conversation and pick it back up."
> - clicks > 0 → "They clicked a link recently — ask what caught their eye on the dashboard."
> - opens ≥ 3 → "They've opened your emails N times — there's interest; name it directly."
> - opens ≥ 1 → "They've opened an email but not engaged — open with curiosity, not a pitch."
> - else → "Cold — no email engagement yet; lead with the industry pain, not the product."

Then it appends `Open with: {opening_hook}`, three qualifying questions, and `Close with: {call_to_action}`.

**Adapted for HomeNex.** A "Before you call" panel on the lead detail screen (`src/components/LeadDetail.jsx` is the natural host). It should show: BLTC state and what's still missing; the last three buyer messages verbatim; which properties were sent and which micro-pages were actually opened (and how many times); the site-visit history and outcome; whether the 24-hour window is open and for how long; the AI score with its `score_reason`; and rule-based talking points.

The talking-point rules translate almost line for line:

- Opened the micro-page 3+ times → "They keep coming back to this flat. Ask what's holding them back — price, floor, or possession date."
- Opened it once, no reply → "They looked and went quiet. Don't re-pitch; ask one question."
- Budget known, timeline unknown → "You know the budget. Get the timeline: 'When do you want to be holding the keys?'"
- Site visit completed, no follow-up in 3 days → "They visited and you've gone quiet. That's the deal dying. Call today."
- Financing = `undecided` → "Loan is unresolved. Offer the EMI number before they ask."

**Why valuable.** Cheap to build (pure functions over data HomeNex already stores, no LLM call), immediately legible to a non-technical broker, and it makes the AI's scoring *auditable* — the agent sees why the lead is Hot, not just that it is. That is what earns trust in the score.

---

### 4.3 Next-best-action suggestions

**In Landline.** `app/routers/suggestions.py` is a deliberately **deterministic, rule-based** ranker (the docstring is explicit: "so the panel is fast and predictable"). It composes four signals into one ranked feed, each carrying the signal that produced it and a concrete `action` string the frontend wires to a button:

1. `overdue_follow_up` (priority high) — a pending follow-up whose `due_date` has passed. Action: `complete_follow_up`.
2. `stale_lead` (medium) — company in an active stage with no email in N days (default 30). Action: `resume_outreach`.
3. `recent_news` (high) — an actionable, un-actioned news item within N days. Action: `reach_out`.
4. `high_score` (high) — latest fit score ≥ threshold (default 75) but the company is still in `new_lead`/`researching`. Action: `prioritize_outreach`.

Sorted by priority rank then signal recency, capped, and returned with `counts_by_type`.

**Adapted for HomeNex.** HomeNex has `GET /api/leads/:id/suggestions`, but that returns *suggested reply text for one lead*. This is a different, more valuable thing: a portfolio-wide "what should I do right now" feed for the Today tab (`src/components/DashboardTab.jsx`).

HomeNex signal set:

- **Overdue follow-up** — `followups` past `due_at`, `completed_at IS NULL`. The table exists; nothing surfaces overdue rows.
- **Closing service window** — `last_inbound_at` is 20–24 hours old. Highest priority in the whole system: it is the only suggestion with a hard deadline, after which the interaction gets more expensive and more formal.
- **Hot lead, never called** — `ai_score = 'hot'` and no outbound agent activity.
- **Site visit tomorrow, unconfirmed** — `site_visits.status = 'scheduled'`, `scheduled_at` within 48h.
- **Site visit completed, no follow-up** — the deal-killer.
- **Micro-page re-opened** — `property_page_views` shows a repeat hit in the last 24h.
- **Stale lead** — active pipeline stage, no message either way in N days.
- **Commission overdue** — `commissions.status = 'expected'` and `expected_payout_date` has passed. Landline has no equivalent, but HomeNex's schema already supports it and unpaid brokerage is the agent's most emotionally salient problem.

**Why valuable.** Rule-based means zero LLM cost, sub-100ms, deterministic, and explainable — you can tell the broker exactly why a card appeared. It is the highest-value-per-line-of-code feature in Landline and it needs no AI at all.

---

### 4.4 Signal recency decay and engagement velocity

**In Landline.** `app/services/scoring.py` implements two ideas that HomeNex's scoring lacks entirely.

**Recency decay** (`signal_recency_weight`) — a step function on how long ago the last engagement happened:

| Age of signal | Weight |
|---|---|
| ≤ 30 min | 1.00 |
| ≤ 1 h | 0.85 |
| ≤ 2 h | 0.70 |
| ≤ 4 h | 0.50 |
| ≤ 8 h | 0.30 |
| ≤ 24 h | 0.15 |
| ≤ 48 h | 0.05 |
| older | 0.02 |

The comment in the source captures the intent: *"a click 30 minutes ago is worth 20× more than one from two days ago."*

**Engagement velocity** (`_engagement_velocity`) — counts distinct engagement events in the last 24 hours and awards a bonus for clustering: 4+ events → +0.30, 3 → +0.20, 2 → +0.10. Clustered signals mean the buyer is *in the middle of deciding right now*.

Both feed the composite `fit_score` (capped at 100), and `factors` records the full breakdown as JSONB so the score is explainable.

**Adapted for HomeNex.** HomeNex's `leads.score` / `leads.ai_score` are set by the LLM at extraction time and then **never change until the next message**. A lead scored Hot at 11 PM on Tuesday is still Hot on Friday, having said nothing since. That is wrong, and it silently poisons any queue or suggestion built on top of the score.

Split scoring into two components, as Landline does:

- **Fit** (slow-moving): BLTC completeness, budget realism against the agent's actual inventory, intent (`buy` > `invest` > `browse`), financing clarity. Recompute on new information.
- **Engagement** (fast-moving, decaying): recency of last buyer message, micro-page views, velocity of activity in the last 24h, site-visit attendance.

A property micro-page opened three times in one evening is the exact WhatsApp-era analogue of Landline's "opened the email 4 times in the last hour" — and it is HomeNex's single strongest buying signal. It currently triggers nothing.

**Why valuable.** Without decay, "Hot" degrades into "was hot once," and the agent stops believing the label. Decay is ~40 lines of pure function and it is what makes every downstream ranking honest.

---

### 4.5 Structured script / talk-track library

**In Landline.** `app/services/call_scripts_data.py` (480 lines) defines a `CallScriptTemplate` dataclass with a fixed **anatomy of a call**:

- `opening_hook` — what the rep says in the first 15–20 seconds
- `qualifying_questions` — 3–5 open discovery questions
- `pain_points` — the industry's real problems
- `value_proposition`
- `objection_handling` — a list of `{objection, rebuttal}` pairs
- `call_to_action` — the specific close

Templates exist for four industries × three script types (`initial_cold_call`, `follow_up`, `voicemail`). Copy lives in Python so it can be consumed by the seed migration, the API (`GET /calls/scripts`, which falls back to the in-code template when the DB is empty), the briefing service, and the tests. `resolve_script()` maps a company's free-text industry onto a vertical, always returning *something* — it defaults rather than failing.

The writing is specific and non-generic. From the injection-molding opener:

> "Hi {first_name}, this is {rep_name} with Apprend Technologies — I'll be quick. I work with injection molders on cutting scrap and short shots, and most shops I call have one tool that quietly eats their margin. Did I catch you at an okay time for thirty seconds?"

**Adapted for HomeNex.** The anatomy is the transferable artifact, not the manufacturing copy. HomeNex's script dimensions are **intent × stage × language**, not industry:

- Intent: `buy` / `rent` / `invest` / `sell` (already an enum on `leads.intent`)
- Stage: first contact, post-micro-page, site-visit invite, post-visit, negotiation, gone-quiet revival
- Language: English / Hindi / Marathi / Hinglish — the AI already handles Hinglish input (`ai.js` `EXTRACT_PROMPT`), but there is no library of *outbound* phrasing per language

A `call_scripts` equivalent seeded per (intent, stage) with real Pune broker phrasing, kept in a data file so it seeds migrations, serves the API, powers the briefing, and is unit-testable. `message_templates` already exists but is a Meta-template registry (`meta_template_id`, `meta_status`) — a different thing. Scripts are for what the agent *says on the phone* or types free-hand inside the 24h window; templates are what Meta lets you send outside it. Keep them separate.

**Why valuable.** New agents onboard by copying. It is also the substrate the AI generator needs: Landline's AI never writes from a blank page — it is handed the base template as a scaffold (see 4.12).

---

### 4.6 Objection handling library and trend analytics

**In Landline.** `_COMMON_OBJECTIONS` in `call_scripts_data.py` holds the five objections reps hear on nearly every call, each with a written rebuttal. Industry scripts prepend their own. Example:

> **"Send me some information / an email."**
> "Happy to — I'll send the live dashboard link so you can click around yourself. While I've got you, can I ask one thing so I send the right thing: which line or machine causes you the most scrap headaches?"

Beyond the library, `CallTask.objections_encountered` (JSONB) records what actually came up, and `GET /calls/analytics/objections` (`routers/calls.py`) aggregates the last N days into ranked objections overall and broken down by industry — closing the loop from "here are the objections we predicted" to "here are the objections we actually hit."

**Adapted for HomeNex.** Indian real estate has its own canonical objection set, and every agent handles it ad hoc:

- "Price zyada hai" / rate is too high
- "Loan approve nahi hua" — financing fell through
- "Builder possession late karta hai" — the developer's delivery record
- "RERA registered hai kya?"
- "Vastu theek nahi hai"
- "Brokerage kitna?" — the fee objection
- "Family ko dikhana hai" — the real decision-maker isn't in the chat
- "Resale value kya hogi?"

Seed a rebuttal library, surface the relevant ones inside the pre-call briefing, and let the agent tick which objections came up after the call. Aggregate them per locality, per builder, per budget band. An agent who learns that *possession delay* is the top objection on one builder's project across forty leads has learned something no CRM has ever told them — and that insight is HomeNex's, not the agent's, which makes it defensible product value.

**Why valuable.** Two-for-one: the library helps the individual call; the analytics create an intelligence asset that compounds across the agent's whole book and, eventually, across the network.

**Caveat.** Landline also has `CallTask.discovery_scorecard` (a Gap Selling 7-element self-assessment). It is stored by `PUT /calls/tasks/{id}` and read by nothing. Don't port the dead field; port the pattern that works (`objections_encountered` → analytics).

---

### 4.7 Autonomous background jobs

**In Landline.** `app/tasks/celery_app.py` defines a Celery Beat schedule — this is where Landline stops being a passive CRM:

| Job | Cadence | Purpose |
|---|---|---|
| `process-outreach-queue` | 5 min | Advance due sequence steps |
| `check-email-replies` | 10 min | Detect replies |
| `sync-email-replies` | 5 min | Reconcile reply state |
| `check-company-news` | 6 h | Trigger-event monitoring |
| `auto-enrich-companies` | 1 h | Fill in missing firmographics |
| `auto-score-new-leads` | 30 min | Score newcomers |
| `rescore-active-leads` | 12 h | Keep scores current |
| `generate-stale-lead-followups` | 4 h | Resurface quiet leads |
| `generate-morning-call-queue` | daily 08:00 | Build the day's call list + pre-warm AI scripts |
| `send-precall-reminders` | 5 min | 15-minute look-ahead |
| `send-call-followup-reminders` | 15 min | Due callbacks |
| `detect-hot-leads` | 30 min | Alert on strong engagement |
| `flag-missed-calls` | daily 18:00 | End-of-day accountability |

Each job's logic lives in a `*_for_session(db)` coroutine, with the Celery task as a thin wrapper. That separation is why they are all unit-testable against any session — worth copying as a *convention*, independent of the scheduler.

Two are worth reading closely:

- `tasks/followups.py::generate_stale_lead_followups_for_session` — for every active-pipeline contact with no email in N days and **no already-open follow-up** ("don't nag twice"), create a pending follow-up with a written reason. Batch-limited.
- `tasks/calls.py::detect_hot_leads_for_session` — contacts with a click or 3+ opens get a `hot_lead_alert`; if they have no open call task, one is **created** at `hot` priority so the signal cannot be lost.

**Adapted for HomeNex.** HomeNex has exactly one background loop: `setInterval(deliverDueFestiveSchedules, 60_000)` in `server/index.js`. Everything else is request-driven, which means nothing happens while the agent isn't looking — and agents aren't looking, they're at site visits.

A minimal HomeNex job set, in priority order:

1. **Service-window watch** (every 15 min) — leads whose `last_inbound_at` is 20–23h old. Push a notification. This is the highest-value automated job in the product; miss the window and a free-text conversation becomes a template request.
2. **Stale-lead follow-up generation** (every 4h) — port `generate_stale_lead_followups` nearly verbatim; HomeNex's `followups` table already has `type = 'ai_suggested'` waiting for exactly this.
3. **Hot-lead detection** (every 30 min) — repeat micro-page views, or a buyer message on a lead the agent hasn't answered.
4. **Score decay recompute** (twice daily) — see 4.4.
5. **Site-visit reminders** — to the agent the evening before; and, if a Meta template is approved, to the buyer.
6. **Daily worklist generation** (early morning, per agent timezone).
7. **Commission overdue sweep** (daily).

**Implementation note (not a recommendation to build yet).** HomeNex is Node, not Celery. The `*_for_session` convention still applies: write each job as a plain async function taking a DB handle, schedule it separately. That keeps them testable — HomeNex's test suite already creates scratch databases per test file.

**Why valuable.** This is the difference between software the agent must remember to check and software that reaches out. Given a PWA with push notifications already scoped (`IMPROVEMENTS_RESEARCH.md` §4.3), the jobs are the missing half of that feature.

---

### 4.8 Send limiter, frequency caps, warmup

**In Landline.** `app/services/send_limiter.py` guards email reputation with four independent checks:

- `can_send_to_contact()` — a per-contact monthly cap, and a minimum gap between consecutive emails to the same person.
- `can_send_today()` — a global daily cap.
- `_get_daily_limit()` — a **warmup ramp**: distinct daily limits for weeks 1, 2, 3, then full volume. New sending identities start small and scale.
- `within_send_window()` — refuses to send outside configured business hours or on weekends, in a configured timezone, and **fails open** if the timezone name is unparseable (a bad config must not halt all sending).

`ANTI_SPAM_RULES` in `ai_sales_guidelines.py` records the targets these enforce: max 50 cold emails per mailbox per day (recommended 35), bounce rate < 2%, spam-complaint rate < 0.1% against Google's 0.3% hard ceiling, three-week minimum domain warmup.

**Adapted for HomeNex.** Rename the nouns, keep the machine. WhatsApp's equivalents:

- Meta **quality rating** (green/yellow/red) per business number, and **messaging tier** limits (1K/10K/100K/unlimited unique recipients per 24h).
- A red-flagged number gets throttled, then restricted. There is no appeal worth relying on.

The mapping is nearly one-to-one:

| Landline concept | HomeNex concept |
|---|---|
| Daily mailbox cap | Messaging-tier cap per business number |
| Per-contact monthly cap | Per-contact template-message frequency cap |
| Minimum gap between emails | Minimum gap between marketing templates |
| Warmup ramp (weeks 1–3) | New-agent-number ramp before bulk festive/marketing sends |
| Business-hours send window | Do-not-disturb window — no 2 AM festive greetings |
| Global suppression list | `contacts.opt_in_status = 'opted_out'`, honoured everywhere |

HomeNex's `festive_schedules` feature is the immediate risk surface: it fans a message out to *all* of an agent's contacts at once. That is precisely the pattern Meta's quality rating penalises, and `IMPROVEMENTS_RESEARCH.md` §1.2 flags portfolio pacing as CRITICAL. A `send_limiter` equivalent should sit in front of it before that feature meets a real contact list.

`contacts.opt_in_status` already exists with an `opted_out` value and no enforcement path. Landline's `consent.py` (CASL/CAN-SPAM regime modelling) shows the shape: a single service that every send path must call, returning `(can_send, reason, regime)`.

**Why valuable.** Purely defensive, and the downside it defends against is the loss of the agent's WhatsApp number — which is the loss of their business. Highest ratio of consequence to effort in this document.

---

## 5. Tier B — strong, needs design work

### 5.1 Sentiment, intent, and buying-signal analysis

**In Landline.** `app/services/sentiment_service.py` runs a single well-shaped Claude prompt over each inbound reply and returns far more than polarity:

- `sentiment_score` 1–10, mapped to a label band (negative / mixed / neutral / positive / very_positive)
- `intent`: one of `interested`, `meeting_request`, `question`, `not_now`, `not_interested`, `objection`, `referral`, `auto_reply`, `out_of_office`
- `intent_confidence` 0–1
- `emotions`: interest, urgency, frustration, satisfaction, curiosity, skepticism, politeness — each 0–1
- `buying_signals`: free-text list ("asked about pricing", "mentioned timeline", "requested demo")
- `objections`: free-text list
- `recommended_action`: one of `schedule_demo`, `send_case_study`, `send_pricing`, `follow_up_later`, `address_objection`, `nurture_sequence`, `connect_referral`, `mark_not_interested`, `no_action`
- `action_reasoning`

The prompt's calibration instructions are the craft:

> "Be precise and calibrated. A polite decline is not_interested (score ~3), not neutral. A question about features is curious/interested (score ~7), not just neutral. An auto-reply or out-of-office is truly neutral (score 5). 'Let's set up a call' is meeting_request with high interest (score ~9)."

Every failure path returns a valid neutral object with an `error` key — analysis never breaks the caller.

**Adapted for HomeNex.** HomeNex's `EXTRACT_PROMPT` already pulls BLTC facts and a Hot/Warm/Cold rating from the conversation. It does not extract *emotional state, objections, or a recommended action*. Adding these to the existing extraction (one call, not two — HomeNex's cost discipline matters more than Landline's) would give:

- `recommended_action` drawn from a real-estate enum: `schedule_site_visit`, `send_property_match`, `send_emi_breakdown`, `address_price_objection`, `involve_family_decision_maker`, `nurture`, `mark_lost`.
- `objections` feeding the objection analytics of 4.6.
- `urgency` as a direct input to the queue ranking of 4.1.

The Hinglish handling is the hard part and HomeNex already solves it — sentiment calibration on "thoda mehnga lag raha hai" (a soft price objection, not a rejection) is not something Landline's English-only prompt teaches. That calibration work is HomeNex's own.

**Why valuable.** It converts every inbound message from a string into a routed decision. Marginal cost is near zero because HomeNex already makes an extraction call per message.

**Caveat.** Landline runs sentiment as a *separate* Claude call per reply, with `max_tokens=1024`. At HomeNex's message volume and on OpenRouter free-tier models, fold it into the existing extraction call rather than adding a second.

---

### 5.2 Sequence / drip state machine

**In Landline.** Three tables:

- `OutreachSequence` — name, industry, status, `cadence_pattern` (`single_channel` / `triple` / `quad` / `quint`, from Tony Hughes's Combo Prospecting).
- `SequenceStep` — `step_number`, `delay_days`, `subject_template`, `body_template`, and crucially **`channel`** (`email` / `call` / `linkedin` / `video` / `direct_mail`).
- `OutreachEnrollment` — the per-contact state machine: `current_step`, `status` (`active` / `paused` / `completed` / `replied` / `bounced` / `unsubscribed`), `next_send_at`, plus Gmail threading ids so follow-ups chain into one thread.
- `OutreachEvent` — the immutable event log: `sent` / `delivered` / `opened` / `clicked` / `replied` / `bounced` / `unsubscribed`.

Exit-on-reply is enforced in `smart_reply.py`: when a reply lands, the active enrollment flips to `replied`, `completed_at` is stamped, and a `replied` event is written. The prospect stops receiving the cadence *immediately*. `FOLLOW_UP_CADENCE` in `ai_sales_guidelines.py` states the rule plainly: *"If prospect replies at any point, exit the sequence and respond personally."*

**Adapted for HomeNex.** `FEATURE_RESEARCH.md` §2.8 already proposes drip sequences. Landline supplies the data model to build them correctly, plus two constraints that a naive implementation will get wrong:

1. **Every step must know its channel and its window.** A WhatsApp step must branch on whether `last_inbound_at` is within 24 hours: inside, send free text; outside, send an approved template or fall back to a call step. This is a HomeNex-specific branch with no Landline analogue, and it is the whole ballgame.
2. **Exit-on-reply is not optional.** If a buyer replies and the drip keeps drip-ping, the agent looks like a bot and Meta's quality rating notices. Landline's enrollment-status transition is the pattern to copy exactly.

The multi-channel step type is the genuinely useful import: a HomeNex sequence for a gone-quiet lead might be *Day 0 template message → Day 2 phone call task → Day 5 template with a new property match → Day 9 breakup message*. Steps 2 is a `CallTask` (4.1), not a message. Landline's `channel` column makes that expressible in one schema.

**Why valuable.** It automates the follow-up discipline that agents know they should have and don't. And unlike email drips, WhatsApp templates cost money per send — so the exit conditions and frequency caps aren't merely polite, they are cost control.

---

### 5.3 Client health scoring

**In Landline.** `app/services/health.py` computes a 0–100 score from three weighted components (weights sum to 100):

- **Recency** (40) — a step function on days since last contact: ≤7d full marks, ≤14d ×0.85, ≤30d ×0.65, ≤60d ×0.40, ≤90d ×0.20, beyond that zero.
- **Responsiveness** (30) — `replies / emails_sent`, clamped to 1.0.
- **Engagement** (30) — meetings in the last 90 days, plateauing at 3.

Bands: ≥70 `healthy`, ≥40 `at_risk`, below `churned`. `record_health_snapshot()` persists a `ClientHealthSnapshot` so health is tracked *over time*, and `GET /reports/retention` derives monthly retention from those snapshots.

**Adapted for HomeNex.** Landline scores *prospects becoming clients*. HomeNex should score *closed clients staying warm*, because Indian real estate brokerage lives on repeat business and referral: the buyer who closed in 2024 refers a cousin in 2026, or sells and re-buys. Today, HomeNex forgets a lead the moment `leads.closed_at` is set.

Components: days since last contact (post-close), responsiveness to festive/anniversary messages, referrals given, and possession-milestone touchpoints (registration, possession, first anniversary — all knowable dates in an Indian property transaction, none currently tracked).

The snapshot table is the important structural idea. A score you can only read *now* answers no interesting question. A score you can plot answers "which of my past clients are going cold?"

**Why valuable.** It creates a reason to open HomeNex when you have no active leads — the hardest retention problem a CRM for commission-based agents has. It also pairs naturally with the existing festive-greeting feature, which is currently a broadcast with no targeting.

---

### 5.4 Framework-structured AI generation

**In Landline.** `app/services/ai_script_generator.py` is the most sophisticated AI code in either repo, and its architecture is worth stealing wholesale even if none of its content is.

**It never writes from a blank page.** `_build_prompt()` assembles: the prospect (name, title, detected role level, company, size bucket, location), *how to talk to this role* (executives hear ROI; quality managers hear compliance; plant managers hear uptime), an engagement summary in natural language, recent company news, recent interactions, the lead score, industry emotional triggers (both `effective` and `avoid` lists), likely certifications, key metrics, technical vocabulary, five selected sales-psychology principles — **and then the canonical industry template, serialised to JSON, as an explicit scaffold**, with the instruction "a scaffold to personalise — do not copy verbatim."

**It has an explicit negative-constraint list**, which is why its output doesn't read like AI:

> "Write a script the rep will actually say out loud on the phone — natural, concrete, conversational (contractions fine). NOT marketing copy. No buzzwords (leverage, synergy, cutting-edge, revolutionary, transform, streamline). No 'I hope this finds you well'."

**It can restructure the entire output around a chosen sales methodology.** `_FRAMEWORK_PROMPTS` holds seven, each a compact instruction set: Challenger (6-step commercial teaching pitch), Gap Selling (current state → future state → the gap), SPIN (situation/problem/implication/need-payoff), Voss tactical empathy (accusation audit, mirroring, labelling, calibrated questions), Blount's 5-step telephone framework, Weinberg's power statement, Sobczak's smart-call opening. Passing `sales_framework="voss_tactical"` produces a structurally different script from the same inputs.

**It never fails.** No API key, an error, or a 30-second timeout all fall back to the canonical template rendered into the same response shape, with `source="template"` and a human-readable `note`. Output is parsed field-by-field with per-field fallback (`_parse_ai_script`), and objection lists are normalised across the several shapes the model might emit (`_coerce_objections` accepts `objection`/`concern` and `rebuttal`/`response`/`answer`).

**It caches with a staleness signature.** Generated scripts are stored on `CallTask.custom_script`, alongside `script_context` — a compact signature of the signals the script was built from (`{engagement: {opens, clicks, replies}, news_count, interaction_count, role_level, fit_score}`). When the signature drifts, the script is known to be stale. `pregenerate_for_tasks()` warms scripts for the day's hot/warm leads at 8 AM so the rep never waits.

**Adapted for HomeNex.** HomeNex's prompts (`server/ai.js`) are single flat strings. Three specific upgrades, in order of value:

1. **Scaffold, don't originate.** Pass the relevant seeded script (5.5 / 4.5) into the prompt as a base to personalise. Smaller models — and HomeNex runs free-tier OpenRouter models — degrade far more gracefully when editing than when inventing. This directly mitigates the risk the current prompt tries to handle with the rule *"Never invent a specific flat you were not told about."*
2. **Cache with a staleness signature.** Suggested replies are regenerated on every load. Cache them against a signature of (last message id, BLTC state, score) and regenerate only on drift.
3. **Structured fallback, always.** `ai.js::chat()` returns `null` when OpenRouter is unreachable, and callers must each handle it. Landline's pattern — always return the full response shape, with `source: "template" | "ai"` and a `note` — is cleaner, and lets the UI honestly show "AI unavailable, showing a standard reply."

The seven sales frameworks are **not** worth porting as-is. They are B2B enterprise-sale methodologies aimed at a procurement committee. An Indian family buying a 2 BHK is a different psychology (family consensus, vastu, possession risk, resale value, loan anxiety). But the *mechanism* — a library of named approaches, each a prompt fragment that restructures the output, tagged onto the record so you can later ask which approach converts — is entirely portable, and 4.6's objection analytics is what makes it measurable.

**Why valuable.** It is the difference between "AI writes something" and "AI writes something an experienced broker would actually say," and it degrades safely when the model is unavailable or weak.

---

### 5.5 Encoded domain knowledge as prompt constants

**In Landline.** `app/services/outreach/ai_sales_guidelines.py` (997 lines) is the crown jewel. It converts ~4,100 lines of researched sales strategy into structured Python data that gets injected into prompts:

- `OUTREACH_PRINCIPLES` — ten named principles with a paragraph each (reciprocity, social proof, authority, scarcity, tactical empathy, challenger teaching, referral wedge, permission marketing, SPIN questioning, micro-commitments).
- `EMAIL_STRUCTURE` — hard numbers (max 75 body words, ideal 50, max 5 sentences, 8th-grade reading level, a **2:1 "you"-to-"I" ratio**, exactly 1 CTA), plus opening patterns, pain-agitation patterns, ranked CTA patterns, and a **CTA blacklist** ("Let me know your thoughts", "Looking forward to hearing from you").
- `SUBJECT_LINE_FORMULAS` — three tiers, each entry carrying a template, an example, the psychological principle it leverages, and usage notes. Plus a blacklist.
- `FOLLOW_UP_CADENCE` — a 5-touch, 21-day sequence, each touch with a purpose and written guidance, plus post-sequence nurture rules and the hard rule *"Each follow-up MUST contain new value — never 'just following up'."*
- `ANTI_SPAM_RULES` — must/must-not content rules, sending limits, domain rules, authentication requirements, compliance checklist.
- `INDUSTRY_PROFILES` — per vertical: emotional triggers (`effective` **and** `avoid`), a decision-maker map (role → what they care about → how to email them → tier priority), approach-by-company-size, subject lines, a full sample email, personalization triggers, certifications, metrics, and technical vocabulary.

The `avoid` lists are as valuable as the `effective` ones:

> "Talking down to their expertise — these are technical people with decades of experience."
> "Implying their current process is broken — frame as 'better documented' or 'more visible'."

**Adapted for HomeNex.** The structure is the asset; every word of the content is wrong for India. HomeNex's equivalents:

- **`LOCALITY_PROFILES`** replacing `INDUSTRY_PROFILES` — per Pune locality (Wakad, Kharadi, Baner, Balewadi, Hinjewadi, Koregaon Park, Kalyani Nagar…): typical price band per sqft, dominant buyer persona (IT salaried / investor / NRI / end-user upgrader), the real objections, the genuine advantages, active builders, RERA-registered projects, commute realities. An agent's local knowledge, made queryable — and injectable into every AI reply.
- **`BUYER_PERSONAS`** replacing `decision_makers` — first-time buyer, upgrader, investor, NRI, tenant. Each with what they care about, how to talk to them, and what to avoid. Landline's insight that the *same* product needs different language per role maps precisely onto persona.
- **`MESSAGE_STRUCTURE`** replacing `EMAIL_STRUCTURE` — WhatsApp-native constraints. HomeNex's prompt already says "under 120 words"; formalise that alongside emoji policy, when to send a voice note, when to send a photo instead of prose, and a phrase blacklist for Indian real estate ("Dear Sir/Madam", "Kindly do the needful", "Greetings of the day", "premium luxurious abode").
- **`OBJECTION_LIBRARY`** — see 4.6.
- **`FESTIVE_CALENDAR`** — partially exists in `server/festivals.js`; deserves the same treatment (which festivals matter to which buyer segment; Gudi Padwa and Akshaya Tritiya are *auspicious buying days* in Maharashtra, not merely greeting occasions — that is a sales trigger, not a pleasantry).

**Why valuable.** This is where a real-estate CRM becomes defensible. Any competitor can call an LLM. Encoded, structured, locality-specific broker knowledge is the moat — and Landline proves the pattern works at 997 lines of plain data with no infrastructure.

**Caveat — read this one carefully.** Landline has a `knowledge_documents` table storing these same docs as editable markdown, exposed by `routers/knowledge.py`. **It is not connected to the AI.** I grepped: no service reads `KnowledgeDocument` except the CRUD router. The prompts are fed from the *Python constants*, not the database. There is no RAG here, despite appearances. Don't port the illusion — port the constants, and treat any database-backed knowledge base (see 6.4) as a separate, later decision.

---

### 5.6 Notification queue

**In Landline.** `CallNotification` (`models/call.py`) is a persisted, rep-facing queue with four types — `upcoming_call`, `missed_call`, `follow_up_due`, `hot_lead_alert` — each carrying a written message, `sent_at`, and `read_at`. Background jobs write rows; `GET /calls/notifications` reads them; `PUT /calls/notifications/{id}/read` marks them. Every producer dedupes via `_existing_notification_task_ids()` so the same task never notifies twice for the same reason.

The messages are written for a human, not a log:

> "Hot lead: Dave Kumar at Precision Plastics clicked a link. Call while it's fresh."
> "Missed call: Apex Molding (hot) was scheduled today and isn't done. Reschedule or mark it."

**Adapted for HomeNex.** HomeNex has `audit_logs` (a machine record) and no notification concept. A `notifications` table keyed by `agent_id`, written by the background jobs of 4.7, read by the Today tab, and — once the PWA push work in `IMPROVEMENTS_RESEARCH.md` §4.3 lands — pushed to the phone.

HomeNex types: `service_window_closing`, `hot_lead_waiting`, `site_visit_tomorrow`, `followup_due`, `commission_overdue`, `micro_page_reopened`.

**Why valuable.** It is the delivery mechanism for every automation in 4.7. Without it, the jobs compute insights nobody sees. The dedupe discipline is the non-obvious part — an agent notified twice about the same lead stops reading notifications entirely.

---

## 6. Tier C — valuable, narrower

### 6.1 Trigger-event monitoring

**In Landline.** `services/news_monitor.py` polls **Google News RSS** (free, no API key) per tracked company, dedupes by title, and passes each article to Claude, asking: is this really about this company; how relevant 1–10; what category (funding, expansion, leadership_change, acquisition, product_launch, partnership, award, hiring); is it actionable; what should we do; and *"how to reference this in outreach."* Results below relevance 3 are dropped. Actionable items become `CompanyNews` rows with `is_actionable`, which then feed both the lead score (`_NEWS_ACTIONABLE_BONUS = 5`) and the `recent_news` suggestion type (4.3).

`digital-sales-strategy.md` frames the underlying idea: a new leader's first 90 days is the strongest buying window in B2B.

**Adapted for HomeNex.** The trigger events that matter in Indian real estate are public and RSS-reachable: RERA registration of a new project, possession-date announcements and delays, infrastructure news (metro line extensions, ring-road approvals — the single biggest driver of locality price movement), builder financial distress, and stamp-duty or circle-rate changes.

Attach these to `properties` and to `leads.preferred_localities`. A buyer who went quiet on Kharadi is worth calling the week the metro extension is approved — that is a genuine, timely reason to reach out, which is exactly what the 24-hour-window problem demands (you need a *reason* to justify a template message).

**Why valuable.** It generates non-annoying reasons to re-contact a cold lead. That is the scarcest resource in a channel where every outbound message costs money and reputation.

**Caveat.** Landline's Google News approach is cheap and unreliable — company-name collisions are handled by asking the model "is this actually about this company," which is a real cost per article. Locality and builder names in India collide worse. Scope narrowly (RERA feeds, a short builder watchlist) rather than generically.

---

### 6.2 Business-card OCR via Claude vision

**In Landline.** `ai_service.py::extract_business_card()` sends a base64 image to Claude with `temperature=0` ("deterministic transcription, not creative writing") and a strict JSON schema. It handles multilingual cards, captures **every** phone number into a labelled `phones` array (Office / Mobile / Fax / Direct / Toll-free / WhatsApp) while also filling the scalar `phone`/`mobile`/`fax` fields, preserves international formats verbatim including the `+` and country code, and returns a per-field `_confidence` map plus `_overall_confidence` so the UI can flag fields needing human review. Backed by `pages/CardScanner.jsx` and `tests/test_card_scanner.py`.

**Adapted for HomeNex.** Indian agents collect cards at site visits, builder meetings, and property expos, and lose them. A PWA camera capture → contact row, with the extracted WhatsApp number pre-filled and low-confidence fields highlighted, fits HomeNex's mobile-first form exactly.

The per-field confidence map is the detail most implementations skip and the one that makes OCR trustworthy — an agent who has been burned by one silently wrong phone number stops using the feature.

**Why valuable.** Small, self-contained, immediately delightful, and it feeds contacts into the system that would otherwise never arrive. Note it requires a vision-capable model; HomeNex's current default (`meta-llama/llama-3.3-70b-instruct:free`) is not one, so this carries a real per-use cost.

---

### 6.3 Groups, segmentation, and bulk action

**In Landline.** Worth correcting a likely misconception first: **`services/contact_grouping.py` is not segmentation.** It is 45 lines that classify a contact as `test` or `genuine` for data hygiene, based on test-email markers and a delimited-token regex on "test" (so that `granitestateprecision.com` isn't false-flagged).

The actual grouping feature is `models/company_group.py` + `routers/groups.py`: a named group with a colour, a many-to-many membership table, and **static** membership (not query-backed). Its useful part is three one-click bulk classifiers: `POST /groups/auto-group-by-industry`, `.../by-country`, `.../by-stage` — each scans companies, creates a group per distinct value if absent, and inserts new members idempotently.

**Adapted for HomeNex.** `contacts.labels` is a `JSONB` array that already exists and is written by nothing. Give it meaning with auto-group equivalents: by locality preference, by budget band, by intent (`buy`/`rent`/`invest`), by pipeline stage, by score band.

The payoff is bulk action gated by the send limiter (4.8): *"send this new Kharadi launch to my 34 warm buyers with a ₹80L–1.2Cr budget who asked about Kharadi"* — one targeted template send instead of a blast to everyone. That directly improves both conversion and Meta quality rating, since relevance is what drives block-rate down.

**Why valuable.** It turns `festive_schedules`' blunt broadcast into targeted campaigns. Static membership is a real limitation (a group goes stale as leads move stages), so prefer query-backed dynamic segments — but Landline's auto-group endpoints are the right UX: one click, sensible defaults, no query builder.

---

### 6.4 Editable knowledge base

**In Landline.** `models/knowledge.py` defines `KnowledgeDocument` (slug-keyed, category, markdown content, editable via `routers/knowledge.py`) and `IndustryContact` (a seeded prospect list). `services/knowledge_data.py` seeds them idempotently from the version-controlled `docs/*.md` and a CSV, keyed by slug and by `(company_name, contact_email)` so re-running a migration never duplicates.

**As established in 5.5, none of this feeds the AI.** It is a CRUD-backed reading surface — the docs, viewable and editable in the app.

**Adapted for HomeNex.** A genuinely useful HomeNex version stores the things agents get asked and answer badly, in Hinglish, from memory: RERA rules and how to verify a registration number; home-loan eligibility and documentation; stamp duty and registration charges by state; the capital-gains and TDS rules on property sale; society transfer procedures.

The interesting version is the one Landline *didn't* build: retrieve the relevant document and inject it into the AI reply prompt, so the assistant answers "what's the stamp duty in Maharashtra?" correctly instead of declining. HomeNex's current prompt handles this by refusing (*"If asked something you don't know (exact legal/loan specifics), say the broker will confirm personally"*) — safe, but every refusal is a moment the AI wasn't useful.

**Why valuable.** Two payoffs: an agent-facing reference, and a grounded-answer source that shrinks the AI's refusal surface. The second requires retrieval infrastructure HomeNex doesn't have, so treat it as a real project, not a port.

**Caveat.** Grounding an AI on legal/tax content raises liability that a manufacturing sales tool never faced. Wrong stamp duty advice sent from the *agent's own WhatsApp number* is the agent's problem. Any such feature needs conspicuous sourcing and a "verify with your lawyer" posture.

---

## 7. Tier D — defer

### 7.1 A/B testing with statistical significance

`services/ab_testing_service.py` is a clean, dependency-free implementation: a two-proportion z-test, a polynomial normal-CDF approximation for confidence, a 200-per-variant minimum sample, a 95% confidence threshold, separate analyses for open/click/reply rates with reply as the primary metric, and `calculate_required_sample_size()` with configurable minimum detectable effect and power.

It is genuinely good code. **It is also not wired to anything** — `ABTestExperiment` exists in `models/email_sentiment.py`, `evaluate_experiment()` exists, and no router calls either.

For HomeNex this is premature on arithmetic alone. At 200 sends per variant for significance, a solo agent with a few hundred contacts would need months per experiment, and Meta template approval makes variants slow to create. Revisit when HomeNex aggregates across many agents — at which point it becomes a network-level product ("this message pattern converts 23% better across 400 Pune agents"), which is a far more interesting thing than per-agent A/B.

### 7.2 Reports suite

`routers/reports.py` offers client retention, revenue pipeline, activity summary, revenue funnel, activity heatmap, top clients, monthly retention from health snapshots, email performance by day, and pipeline analytics (stage counts, conversion rates, deal cycle time, win/loss, total pipeline value).

The *pipeline analytics* metrics — conversion rate per stage, average days in stage, stuck-deal detection — are the ones that transfer, and they're a natural extension of HomeNex's existing Insights tab. But reports are a lagging indicator; the leading-indicator features (Tier A) change agent behaviour, and reports only describe it. Build them once there is enough history to plot.

### 7.3 Do not port

- **The seven B2B sales frameworks** (Challenger, SPIN, Gap Selling, etc.) — wrong buyer psychology, as argued in 5.4. Port the mechanism, not the content.
- **`ai_investor_outreach.py`, `models/investor.py`, `pages/Investors.jsx`** — Landline fundraising tooling, unrelated to its own product.
- **Apollo enrichment, `scrapers/census.py`, `scrapers/thomasnet.py`, `routers/discovery.py`** — cold-list building. HomeNex's leads are inbound by construction; there is no list to discover.
- **`services/gmail_sender.py`, `smtp_sender.py`, `google_oauth.py`, `email_signatures.py`, `tracking.py`** — email transport. WhatsApp Cloud API is the transport.
- **`services/consent.py`'s CASL/CAN-SPAM regime modelling** — the *shape* (a single gate every send path must pass) is worth copying; the specific North-American regimes are not. India's DPDP Act and Meta's own opt-in policy are the governing constraints.
- **`contact_grouping.py`** — test-data hygiene, not a feature.
- **`CallTask.discovery_scorecard`** — written, never read.

---

## 8. Honest accounting: what Landline documents but does not implement

Landline's `docs/` describe considerably more than the code does. Anyone reading those documents as a spec will over-estimate the codebase. Specifically:

| Documented | Implemented? |
|---|---|
| Email-engagement triggers (opens, clicks, replies) | **Yes** — `tasks/calls.py::detect_hot_leads` |
| Signal recency decay, engagement velocity | **Yes** — `services/scoring.py` |
| Role-based call timing, cooling periods | **Yes** — `services/call_queue.py` |
| Account tier classification (ABM) | **Yes** — `scoring.py::classify_account_tier` |
| Website-visit signals (Triggers 7–9) | **No** — no web analytics ingestion |
| Email-forward detection (Trigger 6) | **No** |
| Third-party intent data (Bombora/6sense, Trigger 13) | **No** |
| Leadership-change detection (Trigger 10) | Partially — only whatever Google News surfaces |
| A/B testing framework | Library + model exist; **not wired to any endpoint** |
| Knowledge base as AI context (RAG) | **No** — CRUD only; prompts read Python constants |
| `send_timing.py` scheduling sends | **No** — it is read-only analytics, exposed via `routers/discovery.py` |
| Multi-channel cadence (`triple`/`quad`/`quint`) | Schema supports it; orchestration is email-only |
| Gap Selling discovery scorecard | Column written; **no reader, no analytics** |

This matters for HomeNex because several of the most attractive-sounding ideas (intent data, RAG knowledge base, cadence orchestration) would be **new builds, not ports** — the design thinking transfers, the code does not.

---

## 9. Suggested sequencing

Each stage is independently shippable and each depends only on what precedes it.

**Stage 1 — Make the score honest, and act on it (no new AI cost).**
Signal recency decay + engagement velocity (4.4), splitting fit from engagement. Then the next-best-action feed (4.3) and the pre-call briefing (4.2), both rule-based, both reading data HomeNex already stores. Wire `property_page_views` into scoring — it is written today and read by nothing. Ship the Today tab against it.

**Stage 2 — Protect the number.**
The send limiter (4.8) in front of every outbound path, `contacts.opt_in_status` actually enforced, and pacing on `festive_schedules` before that feature meets a real contact list. Defensive, unglamorous, and the thing whose absence ends the business.

**Stage 3 — Make it act while the agent is away.**
The background job runner and the first three jobs (4.7): service-window watch, stale-lead follow-up generation, hot-lead detection. Plus the notification queue (5.6) to deliver them. This is the stage where HomeNex stops being a record and starts being an assistant.

**Stage 4 — Give the agent the day's work.**
The prioritised daily call queue (4.1), the seeded script library (4.5), and the objection library with its analytics (4.6). By this point the queue has honest scores (Stage 1), safe sending (Stage 2), and a scheduler (Stage 3) to build it at 6 AM.

**Stage 5 — Deepen the AI.**
Fold sentiment/intent/objection extraction into the existing extraction call (5.1). Restructure prompts to scaffold from templates rather than originate, and add staleness-signature caching (5.4). Begin `LOCALITY_PROFILES` and `BUYER_PERSONAS` as structured constants (5.5) — the moat.

**Stage 6 — Compound.**
Drip sequences on the multi-channel state machine (5.2), dynamic segments with gated bulk send (6.3), client health for post-close retention (5.3), trigger-event monitoring (6.1).

---

## 10. The one-paragraph version

Landline's CRM plumbing is unremarkable and HomeNex mostly has it already. What Landline has that HomeNex lacks is a **decision layer**: a scoring model whose signals decay, a rule-based ranker that turns those scores into a ranked list of things to do today, a briefing that tells you what to say before you say it, a scheduler that computes all of this while nobody is looking, a notification queue that delivers it, and a rate limiter that stops the whole machine from destroying the channel it runs on. Underneath all of it sits ~1,000 lines of structured domain knowledge injected into every AI prompt — which is the actual product, and the only part a competitor cannot trivially copy. HomeNex should port the decision layer more or less as designed, port the knowledge-encoding *pattern* while writing entirely new Indian-real-estate content into it, and skip the cold-outreach machinery altogether, because HomeNex's leads arrive on their own and its channel punishes exactly the behaviour Landline was built to perform at scale.
