# HomeNex — Feature Research & Roadmap

> AI-powered WhatsApp-native lead management for Indian real estate brokers.
>
> Last updated: 2026-07-09

---

## Table of Contents

1. [What's Already Built (v1)](#whats-already-built-v1)
2. [Phase 1 — Quick Wins (Weeks 1-4)](#phase-1--quick-wins-weeks-1-4)
3. [Phase 2 — Differentiators (Weeks 5-12)](#phase-2--differentiators-weeks-5-12)
4. [Phase 3 — Revenue Multipliers (Weeks 13-20)](#phase-3--revenue-multipliers-weeks-13-20)
5. [Phase 4 — Scale & Network Effects (Weeks 21-30)](#phase-4--scale--network-effects-weeks-21-30)
6. [AI/LLM-Powered Features](#aillm-powered-features)
7. [AI Model Strategy](#ai-model-strategy)
8. [WhatsApp Business API Strategy](#whatsapp-business-api-strategy)
9. [Compliance & Regulatory Module](#compliance--regulatory-module)
10. [Mobile App Strategy](#mobile-app-strategy)
11. [Admin Portal Features](#admin-portal-features)
12. [Onboarding & User Education](#onboarding--user-education)
13. [Monetization Strategy](#monetization-strategy)
14. [Technical Notes](#technical-notes)

---

## What's Already Built (v1)

These features are live in the current codebase and form the foundation everything else builds on.

**Core pipeline:** Meta WhatsApp Business API webhook receives inbound messages → AI replies via OpenRouter (free-tier Llama 3.3 70B) → BLTC extraction (Budget, Location, Timeline, Configuration) → lead scoring (0-100) and temperature classification (Hot / Warm / Cold) → all persisted to SQLite.

**Multi-agent architecture:** any number of brokers register (name + phone + password). Each agent gets their own lead pool, conversations, stats, and contacts. The webhook routes inbound messages either by per-agent WhatsApp Business phone_number_id or by matching the sender against each agent's saved client list. Unknown senders on a shared line land in an unassigned pool that any agent can claim.

**Dashboard (React + Vite + Tailwind 4):** six tabs — Today (stats + activity feed), Leads (filterable list with score/temp badges), Inbox (WhatsApp-style conversation view with agent reply + AI toggle), Clients (contact management with bulk CSV import), Insights, and Settings (WABA phone number config). Auth screen with signup and login.

**Agent commands via WhatsApp:** agents can text the shared HomeNex number to add clients (phone number or forwarded contact card) or list their clients — no dashboard needed.

**Network / co-broking board:** agents post inventory or requirements; HomeNex auto-matches them by config, locality, and budget overlap.

**Admin panel:** separate admin UI at /admin with admin-only API routes.

**AI capabilities (current):** conversational reply generation with BLTC qualifying flow, structured JSON extraction of lead fields, score breakdown with labeled factors, next-step suggestions for the broker, temperature classification. All via a single OpenRouter endpoint.

---

## Phase 1 — Quick Wins (Weeks 1-4)

Features that agents would immediately love — high impact, low-to-moderate build effort. These directly save agents 30+ minutes per day and make HomeNex feel indispensable from week one.

### 1.1 EMI Calculator In-Chat

Client asks "what's the EMI for 80L?" inside WhatsApp → the AI bot calculates and sends a formatted breakdown instantly. No links, no external apps.

- **How it works:** detect EMI/loan intent in the incoming message via the existing AI layer. When triggered, compute EMI using the standard reducing-balance formula: `EMI = P × r × (1+r)^n / ((1+r)^n - 1)`. Format a reply card with principal, interest rate assumptions (8.5% default, configurable), tenure options (15/20/25 years), monthly EMI, total interest, and total payment.
- **Why agents want this:** buyers ask this in almost every conversation. Currently agents Alt-Tab to a calculator app, compute, screenshot, and send. This kills the conversation flow.
- **LLM role:** intent detection (free tier). The math itself is deterministic — no LLM needed for calculation.
- **Effort:** ~2 days. Add an EMI module to `ai.js`, pattern-match loan-related queries, format a clean WhatsApp text response.

### 1.2 WhatsApp Status/Story Posting from CRM

Agents post property listings to their WhatsApp status daily — it's the #1 marketing channel for Indian brokers. Automating this saves 30+ minutes per day.

- **How it works:** agent uploads a property photo + details in the dashboard → HomeNex generates a status-ready image (property photo with overlay text: price, config, locality, RERA number) + a caption → posts it to the agent's WhatsApp status via the WhatsApp Business API Status Updates endpoint.
- **Image generation:** use server-side canvas (node-canvas or sharp with SVG overlay) to composite text onto the property photo. Template library with 3-4 designs (modern, premium, festive, commercial).
- **LLM role:** generate the caption text (free tier) — punchy, emoji-rich, WhatsApp-optimized. E.g., "🏠 2 BHK Ready Possession in Baner | ₹85L | RERA Registered | East-facing | Call now!"
- **Effort:** ~5 days. WhatsApp Status API integration, image templating pipeline, dashboard UI for compose + preview + schedule.

### 1.3 Property Comparison Cards

Side-by-side comparison images (auto-generated) that agents send to undecided clients who are comparing 2-3 properties.

- **How it works:** agent selects 2-3 properties from their inventory → HomeNex generates a clean comparison card (image) with columns for each property showing price, config (2BHK/3BHK), carpet area, floor, facing, possession date, amenities, RERA status, and a price-per-sqft calculation. The image is sent directly via WhatsApp to the client.
- **LLM role:** generate a brief "recommendation" line at the bottom of the card based on the client's stated preferences from the conversation — e.g., "Based on your budget of ₹90L and preference for ready possession, Property B looks like the best fit." (free tier)
- **Effort:** ~4 days. Inventory data model (new table), comparison image generation (sharp/canvas), WhatsApp image send integration.

### 1.4 Festive Greeting Automation

Diwali, Holi, Eid, Christmas, New Year, Makar Sankranti, Pongal, Onam, Navratri — Indian agents send greetings to their entire contact list religiously. It's a major relationship retention touchpoint.

- **How it works:** pre-built festive templates (designed images with the agent's name/branding) + personalized message. Agent previews and hits "Send to all contacts" in the dashboard. HomeNex sends via WhatsApp Business API template messages (pre-approved by Meta) to avoid spam flags.
- **Scheduling:** auto-detect upcoming festivals from an Indian festival calendar. Remind the agent 2 days before. Option to schedule the send for festival morning (e.g., Diwali morning 7 AM).
- **Personalization (LLM):** generate a personalized line for each contact — "Wishing you and your family a Happy Diwali! May this be the year you find your dream home in Kharadi 🏠✨" (free tier). Vary the message so it doesn't feel mass-blasted.
- **Template messages:** use WhatsApp Business API's message template system for bulk sends (required by Meta for business-initiated messages). Pre-register 10-15 festive templates.
- **Effort:** ~5 days. Festival calendar, template management, bulk WhatsApp send with rate limiting, dashboard UI.

### 1.5 Quick Follow-Up Templates

One-tap follow-up messages for common scenarios — saves agents from typing repetitive messages daily.

- **Templates:** "Hi [name], just checking in — any update on your 2BHK search in Baner?", site visit reminder, post-visit feedback request, document checklist, price update alert.
- **LLM role:** personalize templates with context from the conversation history (free tier).
- **Effort:** ~2 days. Template engine, dashboard UI with template picker in the Inbox.

### 1.6 Lead Assignment Notifications

Push a WhatsApp notification to the agent when a new hot lead comes in, or when an unassigned lead scores above a threshold.

- **How it works:** after BLTC extraction, if `temp === 'Hot'` or `score > 70`, send a WhatsApp message to the agent's personal number: "🔥 Hot lead: Ramesh (9876543210) looking for 3BHK in Wakad, budget ₹1.2Cr, wants to move in 2 months. Score: 85/100."
- **Effort:** ~1 day. Add notification trigger in the webhook pipeline.

### 1.7 Property Portal Lead Ingestion

Auto-capture leads from 99acres, MagicBricks, Housing.com, and NoBroker — the portals agents already pay for but track manually.

- **The problem:** agents list properties on 3-4 portals. Each portal sends leads via email, SMS, or its own dashboard. Agents copy-paste lead details into spreadsheets, often forgetting or losing leads in the process. Studies show 30-40% of portal leads never get a first response.
- **How it works:**
  - **Email parsing:** connect the agent's email (the one registered on portals) via IMAP or Gmail API. Parse incoming lead notification emails from 99acres/MagicBricks/Housing.com using regex + LLM extraction. Extract: buyer name, phone, property interested in, budget, email, source portal.
  - **Webhook/API:** where portals offer webhooks or APIs (99acres has a partner API, MagicBricks has lead push), integrate directly.
  - **Auto-dedup:** match incoming portal leads against existing leads by phone number. If a lead already exists, merge the portal inquiry as a new touchpoint rather than creating a duplicate.
  - **Auto-engage:** once ingested, send an immediate WhatsApp greeting: "Hi [name], you showed interest in [property] on [portal]. I'm [agent], your local expert. What's your preferred budget and timeline?"
- **LLM role:** parse varied email formats from different portals (free tier). Generate the first WhatsApp message with property-specific context.
- **Why this is table stakes:** Sell.Do, LeadSquared, and TeleCRM all offer portal lead capture. Agents expect it. Without it, leads leak out of the CRM.
- **Effort:** ~6 days. Email connection UI, parser for each portal format, dedup logic, auto-greeting pipeline.

### 1.8 WhatsApp Flows for Lead Qualification

Use WhatsApp Flows (interactive multi-screen forms inside WhatsApp) instead of free-text conversation to qualify leads faster.

- **How it works:** when a new lead messages or clicks a CTWA ad, HomeNex sends a WhatsApp Flow — a native multi-screen form with dropdowns, date pickers, and text inputs. The flow collects: property type (buy/rent/sell), BHK preference, preferred localities (multi-select), budget range (slider or preset ranges), possession timeline, home loan status. The entire BLTC profile is captured in 30 seconds instead of a 5-message back-and-forth.
- **Why Flows beat free text:** 3x faster qualification. Structured data (no parsing errors). Works on WhatsApp Web (supported since Dec 2025). Buyers prefer tapping over typing — especially on mobile.
- **Technical:** WhatsApp Flows use Flow JSON v7.0. Build 3-4 reusable flow templates: buyer qualification, rental inquiry, site visit booking, document checklist. Flows are session messages (free within the 24-hour window — no template cost).
- **LLM role:** minimal — the flow captures structured data directly. LLM generates the follow-up message after the flow is completed.
- **Effort:** ~5 days. Flow JSON builder, webhook handler for flow responses, flow template management UI.

---

## Phase 2 — Differentiators (Weeks 5-12)

Features no competitor has. These create lock-in and network effects that make HomeNex hard to leave.

### 2.1 Builder Payment Tracker

Agents lose lakhs tracking commission receivables from builders across 5-10 active projects. A simple "Builder X owes you ₹2.4L, 60 days overdue" dashboard would be killer.

- **The problem:** an agent closes a deal at a builder's project. The builder owes the agent a CP (Channel Partner) commission — typically 1-2% of the flat value, paid in 2-3 installments (on booking, on agreement, on possession). Agents are simultaneously tracking commissions from 5-10 builders across 20-30 deals. They use Excel or WhatsApp notes. They forget. Builders "forget." Lakhs slip through the cracks.
- **How it works:**
  - New data model: `builders` table (name, contact, projects), `deals` table (client, builder, project, flat, deal_value, commission_pct, commission_amount), `commission_payments` table (deal_id, installment_number, amount_due, amount_paid, due_date, paid_date, status).
  - Dashboard section: "My Commissions" — grouped by builder, showing total owed, total received, overdue amounts. Drill into each builder to see individual deals and installment status.
  - Alert system: "Builder X owes you ₹2.4L, 60 days overdue" — pushed via WhatsApp to the agent.
  - Overdue escalation: auto-generate a polite follow-up message that the agent can forward to the builder's accounts team.
- **LLM role:** generate the follow-up message (free tier). Parse deal details from WhatsApp conversations with builders if the agent forwards them. Summarize commission status across all builders.
- **Why this is a differentiator:** no CRM does this. It's a spreadsheet problem that agents hate. Solving it creates massive lock-in — once their commission data is in HomeNex, they can't leave without losing visibility into money owed to them.
- **Effort:** ~8 days. New data models, dashboard UI, WhatsApp notification pipeline.

### 2.2 Broker Group Intelligence

Agents share requirements in WhatsApp broker groups (50-200 agents per group). Messages like "Need 3BHK Baner 1Cr ready" or "Available: 2BHK Wakad 75L East facing" fly by hundreds per day. If HomeNex could parse those group messages and auto-match against inventory, that's a network effect moat.

- **How it works:**
  - Agent forwards broker group messages to the HomeNex number (or connects the HomeNex bot to a broker group).
  - HomeNex parses each message using the LLM to extract: type (requirement / inventory), config, locality, budget range, possession timeline, contact info.
  - Auto-match extracted requirements against the agent's own inventory (and vice versa). Notify the agent: "Rajesh in your broker group needs a 3BHK in Baner under ₹1Cr — you have 2 matching properties."
  - Network board integration: parsed messages feed into the existing network/co-broking board, enriching it with real broker-group volume.
- **LLM role (critical):** parse unstructured Hinglish broker-group messages into structured data. Messages like "2bhk wakad 75l redy posn east facing urgnt" need robust extraction. Free tier works here — this is text extraction, not generation.
- **Why this is a moat:** this creates a network effect. The more agents use HomeNex, the more broker group messages flow in, the better the matching gets. No competitor can build this without the WhatsApp integration.
- **Privacy:** messages are only matched — original sender info is shared only when both parties consent via the co-broking board.
- **Effort:** ~10 days. Message parsing pipeline, matching algorithm enhancement, notification system, group message forwarding flow.

### 2.3 Site Visit Proof (GPS Check-in)

GPS check-in at project site + timestamped photo = proof for builder CP (Channel Partner) attribution disputes. Agents lose commissions over "who brought the client first."

- **The problem:** two agents bring the same client to a builder's project. The builder pays CP commission to whoever "brought the client first." Without proof, it's the agent's word against the builder's records. Agents lose lakhs in disputed commissions.
- **How it works:**
  - Agent opens HomeNex at the project site, taps "Check In" — the app captures GPS coordinates + timestamp + a photo of the client at the site.
  - HomeNex generates a tamper-proof "Visit Certificate" — a PDF/image with: agent name, client name, project name, GPS coordinates, Google Maps pin, timestamp, photo, and a unique verification hash.
  - The visit certificate is stored in HomeNex and can be shared with the builder as proof of first visit. The hash makes it tamper-evident.
  - Optional: share the certificate with the builder's CP desk via WhatsApp immediately after the visit.
- **GPS verification:** compare check-in GPS coordinates against known project locations. Flag if the agent is more than 500m from the project site (prevents fake check-ins).
  - **OTP verification (optional):** for high-value projects or disputed CP claims, add an OTP layer — the client receives an OTP on their phone at the site visit, confirms it in the agent's app. This provides dual verification (GPS + client presence). Sell.Do uses this approach.
- **LLM role:** minimal — generate the visit certificate text. The core value is GPS + timestamp + photo, not AI.
- **Why this is a differentiator:** no CRM offers this. It's a uniquely Indian real estate pain point. Solves a real money problem.
- **Effort:** ~6 days. GPS capture (WhatsApp location sharing or web geolocation API), photo upload, certificate generation (PDF), project location database.

### 2.4 Vastu Compass Overlay

Sounds niche but Indian buyers ask about Vastu facing constantly. Overlay compass direction on floor plan photos.

- **How it works:**
  - Agent uploads a floor plan photo → HomeNex detects the orientation (using the LLM vision model to identify North arrow / layout cues) and overlays a compass rose showing the flat's facing direction.
  - If no North arrow is visible, the agent manually sets the orientation with a simple drag-to-rotate compass UI.
  - The overlay also highlights Vastu-relevant features: main entrance direction (should face East/North per Vastu), kitchen placement (SE corner preferred), master bedroom (SW corner preferred), toilets (should not face East or North).
  - Output: an annotated floor plan image that the agent can send to the client via WhatsApp.
- **LLM role (vision):** floor plan analysis — detecting room layouts, identifying entrance, kitchen, bedrooms. This needs a vision-capable model → premium tier feature (paid model).
- **Vastu rules engine:** a simple rules engine that maps room positions + facing direction to Vastu compliance scores: "This flat scores 8/10 on Vastu — entrance faces East ✅, kitchen in SE ✅, master bedroom in SW ✅, toilet faces North ❌."
- **Why agents want this:** "Vastu kaisa hai?" is asked in 70%+ of Indian property inquiries. Currently agents guess or ask the builder. An instant Vastu overlay makes the agent look incredibly knowledgeable.
- **Effort:** ~7 days. Image upload, compass overlay (canvas), Vastu rules engine, vision model integration (premium).

### 2.5 Smart Inventory Management

Move beyond the current flat network_posts table to a proper inventory system.

- **How it works:** agents maintain their property inventory — projects they're authorized to sell, with unit-level details (tower, floor, config, carpet area, price, facing, possession date, RERA number, builder name, brokerage %).
  - Import: bulk upload from builder price lists (Excel/PDF — parsed by the LLM).
  - Match: when a lead's BLTC profile is extracted, auto-suggest matching properties from inventory.
  - Share: one-tap send a property card to the client via WhatsApp.
- **LLM role:** parse builder price lists (PDFs/Excel) into structured inventory data (premium vision tier for PDFs). Auto-match leads to inventory using semantic understanding, not just exact filter matches.
- **Effort:** ~8 days. New inventory data model, import pipeline, matching engine, property card generation.

### 2.6 Client Document Vault

Secure storage for client KYC documents, agreements, and receipts.

- **How it works:** agent or client uploads PAN card, Aadhaar, income proof, bank statements, booking form. Documents are stored encrypted, organized per client.
- **LLM role:** OCR extraction from PAN/Aadhaar photos (premium vision tier). Auto-fill client profile fields from extracted document data.
- **Effort:** ~5 days. File upload, encrypted storage, document viewer, OCR integration.

### 2.7 Cloud Telephony & Click-to-Call

Integrate IVR and click-to-call so agents never leave the CRM to make calls, and every call is logged with context.

- **The problem:** agents juggle WhatsApp and phone calls. Call details (duration, outcome, commitments) are never captured. When a buyer calls back, the agent scrambles to remember who they are and what was discussed.
- **How it works:**
  - Integrate with Indian cloud telephony providers (Exotel, Knowlarity, or MyOperator — all have well-documented APIs and India-specific IVR capabilities).
  - **Click-to-call:** agent clicks a phone icon next to any lead in the dashboard → call connects via the cloud telephony provider → call is recorded (with consent announcement) → recording is linked to the lead.
  - **Incoming call routing:** set up a virtual number as the agent's business line. When a call comes in, HomeNex identifies the caller against the lead database and shows the agent a pop-up with the lead's profile, conversation history, and BLTC data before they pick up.
  - **Call logging:** after every call, auto-log duration and prompt the agent for a quick disposition (interested, follow up, not interested, wrong number). Premium: auto-transcribe the call and extract action items.
  - **WhatsApp Business Calling API (GA July 2025):** agents can call leads directly from WhatsApp with full chat history visible — the ultimate context-rich calling experience.
- **LLM role:** post-call summarization and action item extraction from transcriptions (premium tier).
- **Why this matters:** Sell.Do, LeadSquared, and TeleCRM all have telephony. It's table stakes for serious CRM users who handle 20-30 calls per day.
- **Effort:** ~8 days. Telephony provider integration, call UI in dashboard, call logging, WhatsApp Business Calling API integration.

### 2.8 Automated Drip Sequences

Move beyond one-off follow-up templates to multi-step, trigger-based nurturing sequences that run on autopilot.

- **The problem:** agents send one follow-up and forget. Leads that don't respond to the first message are abandoned. Research shows it takes 5-7 touchpoints to convert a real estate lead. Manual follow-up at that cadence is impossible across 50+ active leads.
- **How it works:**
  - **Sequence builder:** visual drag-and-drop builder in the dashboard. Agent creates a sequence like: Day 0 → welcome message with property match. Day 2 → EMI calculator for their budget. Day 5 → similar property comparison card. Day 10 → market trend update for their locality. Day 15 → site visit invitation. Day 30 → re-engagement with new listings.
  - **Triggers:** sequences start on configurable triggers — new lead, lead goes cold, post-site-visit, post-booking, festival season.
  - **Smart exits:** the sequence auto-pauses if the lead replies (hand off to agent), books a site visit, or explicitly opts out.
  - **Channel mix:** WhatsApp (primary), email (secondary), SMS (fallback for non-WhatsApp users).
  - **Meta compliance:** use approved template messages for business-initiated messages outside the 24-hour window. Respect per-template pricing (Marketing: ~₹0.86, Utility: ~₹0.12).
- **LLM role:** personalize each drip message with conversation context and lead profile (free tier). Suggest optimal sequence timing based on lead engagement patterns.
- **Effort:** ~8 days. Sequence builder UI, scheduler engine, template management, exit condition logic, multi-channel dispatch.

### 2.9 Content View Tracking

Know when a lead opens a brochure, views a property card, or watches a video you sent — and get notified instantly.

- **How it works:** when an agent shares a document (brochure PDF, property card image, comparison card), HomeNex wraps the link in a tracked URL. When the lead opens it, the agent gets a notification: "Priya just viewed the Kolte Patil brochure you sent 2 hours ago — now might be a good time to follow up."
  - Track: open timestamp, time spent viewing, number of views, device type.
  - For images sent directly in WhatsApp (not links), use WhatsApp's message status (delivered, read) as a proxy.
- **Why agents want this:** Privyr offers this and agents love it. Knowing a lead is actively looking at your material is a hot buying signal.
- **Effort:** ~4 days. URL shortener with tracking, notification pipeline, analytics dashboard.

---

## Phase 3 — Revenue Multipliers (Weeks 13-20)

Features that directly generate revenue for HomeNex — either through value-added services agents pay for, or by capturing a share of agent spending.

### 3.1 Managed Click-to-WhatsApp Ads

HomeNex runs the Facebook/Instagram ad for the agent — leads land directly in the CRM. Charge a percentage of ad spend.

- **The problem:** Indian real estate agents spend ₹10K-₹1L/month on Facebook ads but don't know how to run them well. They boost posts randomly, target poorly, and leads go to their personal WhatsApp (untracked). They lose 40-60% of ad spend to bad targeting.
- **How it works:**
  - Agent selects a property from inventory → HomeNex auto-generates an ad creative (property image + overlay text) and ad copy using the LLM.
  - HomeNex creates a Click-to-WhatsApp ad via the Facebook Marketing API — targeted to the relevant locality + demographic.
  - When a user clicks the ad, they land in the agent's WhatsApp → HomeNex catches the lead via the webhook, auto-qualifies with BLTC, and tracks attribution back to the ad campaign.
  - Dashboard shows: ad spend, leads generated, cost per lead, conversion rate, ROI.
  - **Revenue model:** HomeNex charges 15-20% of ad spend as management fee, or a flat ₹999-₹2999/month for a managed ads package.
- **LLM role:** generate ad copy and creative text (free tier). Optimize targeting suggestions based on lead data (which localities, age groups, income brackets convert best for this agent).
- **Why this works:** agents already spend the money. HomeNex just makes it work better and captures a management fee. Win-win.
- **Effort:** ~12 days. Facebook Marketing API integration, ad creative generation, campaign management dashboard, attribution tracking, billing.

### 3.2 Rental Agreement Generator

State-specific stamp duty calculation + e-signature. Rental agents would pay for this alone.

- **How it works:**
  - Agent fills in: landlord name, tenant name, property address, rent amount, security deposit, lease duration, lock-in period.
  - HomeNex generates a legally compliant rental agreement based on the state's template (Maharashtra Rent Agreement is the most common — Leave & License format per Maharashtra Rent Control Act).
  - Auto-calculates stamp duty (Maharashtra: stamp duty on rent agreements = 0.25% of total rent + deposit for the lease period, minimum ₹100, registered via e-stamp).
  - Agent and tenant e-sign via Aadhaar-based eSign (using NSDL/UIDAI eSign APIs) or a simpler OTP-based consent.
  - Output: a stamped, signed PDF that's legally valid.
  - **Revenue model:** ₹199-₹499 per agreement generated. Volume pricing for rental-focused agents.
- **LLM role:** generate custom clauses based on agent/tenant requirements (free tier). E.g., "Add a clause for pet permission" or "Include a 2-month notice period clause." Parse special conditions from natural language into legal clause format.
- **State support:** start with Maharashtra (60%+ of target market), then expand to Karnataka, Delhi NCR, Telangana, Tamil Nadu.
- **Effort:** ~10 days. Agreement template engine, stamp duty calculator per state, eSign integration, PDF generation, payment integration.

### 3.3 Premium AI Tier

Free models for basic usage, paid tier with better models for voice transcription, vision features, and smarter matching.

- **Tier structure:**
  - **Free tier:** OpenRouter free models (gpt-oss-20b:free / gpt-oss-120b:free) for conversational replies, BLTC extraction, lead scoring, basic content generation. Sufficient for 80% of use cases.
  - **Pro tier (₹499/month):** upgraded models for better Hinglish understanding, voice note transcription (Whisper or equivalent), property photo analysis, floor plan digitization, document OCR. Higher rate limits. Priority processing.
  - **Business tier (₹1499/month):** everything in Pro + managed ads, advanced analytics, API access, white-label options, dedicated support.
- **Why it works:** agents experience the free tier, get hooked on the AI capabilities, then upgrade when they need voice/vision features. Classic freemium land-and-expand.
- **Upsell triggers:** when a voice note arrives and can't be transcribed on free tier → "Upgrade to Pro to auto-transcribe voice notes." When a floor plan is uploaded → "Upgrade for Vastu analysis."
- **Effort:** ~5 days. Tier management, model routing per tier, usage tracking, Stripe/Razorpay billing integration.

### 3.4 Lead Marketplace

Allow agents to buy and sell leads they can't service.

- **How it works:** if an agent gets a lead for a locality they don't cover, they can list it on HomeNex's internal marketplace. Other agents bid on it. HomeNex takes a 10-15% cut.
- **Trust system:** agents rate each other after lead handoffs. Bad leads get refunded. Reputation scores determine marketplace visibility.
- **Effort:** ~8 days. Marketplace UI, bidding system, escrow/payment, reputation engine.

### 3.5 Builder Portal & Channel Partner Management

Builders pay to list their projects on HomeNex and push inventory to all CP agents on the platform. Full CP lifecycle management — the feature that makes HomeNex indispensable for both builders and agents.

- **How it works:**
  - **Builder dashboard:** builder creates a project listing with unit-level inventory (tower, floor, unit number, config, carpet area, price, availability status). Real-time inventory matrix — when a unit is booked by any CP agent, all other agents see it as unavailable instantly. No double-booking.
  - **CP onboarding:** builder invites CP agents via WhatsApp link. Agent submits KYC (RERA number, PAN, firm details). Builder approves/rejects. Approved agents see the builder's inventory in their HomeNex dashboard.
  - **CP performance dashboard (builder side):** which agents are generating leads, site visits, and bookings. Leaderboard view. Commission disbursement tracker — the builder logs payments against each deal, and the agent sees the same data in their commission tracker (2.1). Single source of truth.
  - **Automated commission slabs:** builder configures commission structure per project (e.g., 2% standard, 2.5% for early bird, 3% for specific towers). Auto-calculate payable commission per booking.
  - **Push notifications to CPs:** builder launches a new tower/phase → all approved CPs get a WhatsApp notification with updated inventory and price list.
- **Revenue model:** builders pay ₹5K-₹25K/month per project listing, depending on project size and agent reach. Premium tier: ₹50K/month for priority placement and lead routing preference.
- **Effort:** ~15 days. Builder registration, project management, CP agent approval workflow, inventory matrix with real-time sync, builder analytics dashboard, commission reconciliation.

### 3.6 Cost Sheet & Demand Letter Generator

Auto-generate Indian real estate cost sheets and demand letters — the two documents agents create most frequently.

- **The problem:** after every site visit, the agent manually creates a cost sheet in Excel with 15+ line items: base price, floor rise, PLC (preferential location charge), parking, GST, stamp duty, registration, legal charges, maintenance deposit, sinking fund, infrastructure charges. It takes 20-30 minutes per cost sheet, and arithmetic errors are common.
- **How it works:**
  - Agent selects a property from inventory + selects the client → HomeNex auto-generates a formatted cost sheet with all standard Indian real estate components.
  - **Components:** base price (carpet area × rate/sqft), floor rise (₹X per floor above Y), PLC (corner/road-facing/garden-facing premiums), covered/open parking, GST (1% affordable / 5% non-affordable / 0% ready), stamp duty (state-specific with gender concessions), registration (state-specific caps), legal charges, corpus/maintenance deposit, infrastructure charges, total cost, payment schedule milestones.
  - **Demand letters:** for booked clients, auto-generate demand letters per payment milestone: "10% on booking, 20% on foundation, 20% on plinth..." with amounts, due dates, and payment instructions.
  - **Output:** professional PDF with builder branding (if from builder portal) or agent branding. Share directly via WhatsApp.
- **LLM role:** minimal — this is a template + rules engine. LLM generates a plain-English summary at the bottom: "Total cost for this 2BHK on the 12th floor is ₹1.04Cr all-inclusive. Your EMI on a ₹75L loan at 8.5% for 20 years would be ₹65,100/month."
- **Revenue model:** free for basic cost sheets. ₹99/cost sheet for branded PDF with builder logo. Bundled into Pro tier.
- **Effort:** ~7 days. Cost sheet template engine, state-specific rules, demand letter generator, PDF output, WhatsApp sharing.

### 3.7 WhatsApp Payment Collection (UPI)

Collect token amounts and booking fees directly inside WhatsApp using UPI — no external payment links needed.

- **How it works:** WhatsApp Pay is available to all Indian users (NPCI removed onboarding caps). Integrate with Razorpay's WhatsApp payment gateway to enable in-chat payment collection.
  - Agent sends a payment request from the dashboard: "Collect ₹1L booking token from Priya for Flat 302."
  - Client receives a WhatsApp message with a "Pay ₹1,00,000" button → taps → UPI payment completes inside WhatsApp → HomeNex records the transaction against the deal.
  - **Use cases:** booking token (₹50K-₹2L), rental agreement charges (₹199-₹499 per agreement), HomeNex premium subscription payments.
- **Compliance:** UPI has a ₹1L per-transaction limit for P2M. For larger amounts, provide a Razorpay payment link (outside WhatsApp) with the same tracking.
- **Revenue model:** 0.5-1% convenience fee on property-related payments (within RBI guidelines). Zero fee on HomeNex subscription payments.
- **Effort:** ~6 days. Razorpay WhatsApp Pay integration, payment request UI, transaction ledger, reconciliation dashboard.

---

## Phase 4 — Scale & Network Effects (Weeks 21-30)

Features that compound with user growth and create defensible advantages.

### 4.1 Cross-Agent Lead Routing

When one agent can't service a lead (wrong locality, too busy), automatically route to the best available agent for that requirement.

- **How it works:** agent declines a lead → HomeNex scores all other agents on the platform for fit (do they cover this locality? what's their response time? client rating?) → routes to the best match → originating agent gets a referral fee if the lead converts.
- **Effort:** ~6 days.

### 4.2 Market Intelligence Dashboard

Aggregate anonymized data across all agents on HomeNex to surface market trends.

- **Metrics:** average price per sqft by locality (from lead budget data + inventory), demand heat map (which localities get the most inquiries), supply-demand gap (where demand exceeds listed inventory), price trend over time, most-searched configurations.
- **LLM role:** generate natural-language market reports from the data (free tier). "Baner 3BHK demand is up 23% this month. Average asking price: ₹7,200/sqft. Hot micro-markets: Baner-Balewadi road, near Westend Mall."
- **Effort:** ~8 days.

### 4.3 Agent Reputation System

Public profile pages for agents, with client ratings, response times, deal history, and specializations.

- **How it works:** after a deal closes (or after a set interaction period), clients receive a rating request via WhatsApp. Ratings feed into the agent's public profile. Top-rated agents get featured in the lead marketplace.
- **Effort:** ~5 days.

### 4.4 WhatsApp Catalog Integration

Agents maintain a WhatsApp Business catalog of properties that buyers can browse directly in WhatsApp.

- **How it works:** sync agent's inventory to the WhatsApp Business Catalog API. Buyers browse properties in-chat without leaving WhatsApp. Clicking a property starts a conversation about it.
- **Effort:** ~6 days.

### 4.5 Multi-City Expansion Tools

Templates, localization, and configuration for expanding beyond Pune — Mumbai, Bangalore, Hyderabad, NCR.

- **How it works:** city-specific AI prompts (locality names, price ranges, regulatory context like RERA authority per state), city-specific festival calendars, stamp duty calculators, and rental agreement templates.
- **Effort:** ~4 days per city.

### 4.6 Booking Engine with Inventory Matrix

Visual tower-floor-unit inventory matrix with real-time booking status — the feature that makes HomeNex a complete transaction platform, not just a lead management tool.

- **How it works:**
  - Interactive matrix view: tower selector → floor grid → unit cells color-coded by status (available / booked / blocked / held). Agent taps a unit to see full details and initiate a booking.
  - **Booking flow:** select unit → attach client → generate cost sheet (auto from 3.6) → collect token (via WhatsApp Pay or manual) → mark as "held" (24-48 hour lock to prevent double-booking) → builder confirmation → mark as "booked."
  - **Real-time sync:** if integrated with the builder portal (3.5), inventory updates across all CP agents instantly. No more "sorry, that unit was just sold" embarrassment.
  - **Waitlist:** if a unit is booked, allow clients to join a waitlist. If the booking falls through, auto-notify waitlisted clients.
- **Why this is Phase 4:** requires builder portal integration (3.5) and payment collection (3.7) as prerequisites. This is the capstone feature that ties everything together.
- **Effort:** ~10 days. Inventory matrix UI, booking state machine, locking/hold mechanism, builder sync, waitlist engine.

### 4.7 Self-Service Buyer Portal

A web portal where buyers can browse properties, view their shortlist, check document status, and track their booking — without bothering the agent.

- **How it works:** buyer receives a unique link via WhatsApp → opens a lightweight web portal showing: their shortlisted properties, site visit schedule, documents submitted/pending, booking status, payment milestones, and a direct WhatsApp chat button to their agent.
  - Agent controls what the buyer sees — they can share specific properties, hide pricing until a site visit, or reveal the full cost sheet after a meeting.
  - **Document upload:** buyer uploads KYC documents directly through the portal (PAN, Aadhaar, bank statements) — no more WhatsApp image compression artifacts.
- **Why buyers want this:** provides transparency and reduces "any update?" messages by 50%+. The buyer feels in control.
- **Effort:** ~8 days. Buyer portal UI, access control per agent, document upload, booking status tracker, WhatsApp deep-link integration.

### 4.8 Agent Gamification & Leaderboards

Drive engagement and healthy competition with leaderboards, badges, streaks, and rewards.

- **How it works:**
  - **Leaderboards:** weekly/monthly rankings across the platform — most leads converted, fastest response time, highest client ratings, most site visits. Anonymized leaderboard visible to all agents; detailed view for the agent's own performance.
  - **Badges:** "First Deal Closed 🎉", "Speed Demon ⚡ (avg response < 2 min)", "Consistent Closer 🔥 (3+ deals/month)", "5-Star Agent ⭐ (avg rating > 4.5)", "Network Builder 🤝 (10+ co-broking deals)".
  - **Streaks:** daily login streaks, follow-up streaks (no leads without a follow-up for X days), content posting streaks (WhatsApp status posts).
  - **Rewards:** top agents get featured in the lead marketplace, priority in cross-agent lead routing, and potential cash rewards from HomeNex or builder partners.
- **Why this works:** TeleCRM and LeadSquared report that gamification increases daily active usage by 30-40%. Real estate agents are inherently competitive.
- **Effort:** ~5 days. Scoring engine, leaderboard UI, badge/achievement system, notification pipeline.

### 4.9 Customer Referral Engine

Structured post-sale referral program — buyers who close deals refer friends and family, tracked and rewarded.

- **How it works:** after a deal closes, the buyer receives a unique referral link/code via WhatsApp. When a referred lead converts, the referrer gets a reward (decided by the agent — cashback, gift voucher, or broker fee discount on their next transaction). HomeNex tracks the referral chain and automates reward disbursement.
  - **Post-possession nurture:** scheduled touchpoints at 1 month, 3 months, 6 months, and 1 year after possession. "How's the new home? Need help with interiors / society registration / property tax? And if any friends are looking for a home, I'd love to help them too 🏠"
  - **Referral analytics:** which clients refer the most, referral conversion rate, reward ROI.
- **Why this matters:** referred leads convert at 3-4x the rate of cold leads. Most agents don't have a structured referral process.
- **Effort:** ~5 days. Referral code generation, tracking pipeline, reward ledger, post-possession drip sequence.

---

## AI/LLM-Powered Features

This is the comprehensive catalog of every way LLMs and AI can be leveraged across the HomeNex platform. Each feature is tagged with its model requirement (free tier vs. premium) and integration point.

### A. Conversation AI

These features enhance the core WhatsApp conversation experience — the bread and butter of HomeNex.

#### A.1 Hinglish/Vernacular NLU for Lead Qualification

**What:** understand mixed Hindi-English (Hinglish), Marathi-English, and other Indian vernacular conversations to extract BLTC data accurately.

**Why it matters:** 80%+ of WhatsApp conversations with Indian real estate buyers happen in Hinglish. Messages like "bhai 2bhk chahiye baner me, budget 80-90 ke beech, jaldi chahiye possession" need to be parsed as accurately as formal English. Current free-tier models handle basic Hinglish but miss nuances, slang, and regional dialects.

**Implementation:** the existing `extractLead()` function in `ai.js` already handles some Hinglish via the LLM's training. Improvements include adding Hinglish examples to the extraction prompt, a Hinglish-specific system prompt variant, and a glossary of Indian real estate slang (e.g., "reddy" = ready possession, "poss" = possession, "regi" = registration, "agri" = agricultural land, "NA" = non-agricultural, "CP" = channel partner).

**Model tier:** free tier (gpt-oss-120b:free handles Hinglish well). Premium tier for better accuracy on heavy dialect.

#### A.2 Intent Detection

**What:** classify every incoming message into a specific intent — buy, rent, sell, invest, loan inquiry, site visit request, price negotiation, document request, complaint, or just browsing.

**Why it matters:** different intents need different conversation flows. A buyer asking "what's the price?" is very different from one asking "can I get a home loan?" The AI should route accordingly.

**Implementation:** add an `intent` field to the extraction JSON. The LLM classifies intent as part of the existing extraction call (zero additional API cost — just expand the extraction prompt). Map intents to conversation strategies: buy → BLTC flow, rent → rental-specific flow (budget, duration, furnishing preference), sell → property valuation flow, invest → ROI/rental yield discussion.

**Model tier:** free tier.

#### A.3 Sentiment Analysis — Detect Frustrated / Hot / Cold Leads

**What:** analyze conversation tone to detect when a lead is frustrated (bad experience with another agent, tired of searching), highly interested (asking detailed questions, requesting site visit), or going cold (one-word replies, long gaps between messages).

**Why it matters:** frustrated leads need empathy + urgency. Hot leads need immediate agent intervention. Cold leads need a re-engagement strategy. Currently, the `temp` field (Hot/Warm/Cold) is based on BLTC completeness, not emotional signals.

**Implementation:** add `sentiment` and `engagement_level` fields to the extraction prompt. Sentiment: positive / neutral / frustrated / anxious. Engagement: high / medium / low / disengaged. When a lead is detected as "frustrated + high engagement" (actively searching but had bad experiences), alert the agent: "This lead seems frustrated with their search. A personal call right now could close the deal."

**Model tier:** free tier.

#### A.4 Auto-Negotiation Suggestions

**What:** when a buyer pushes back on price, suggest negotiation strategies based on market data, comparable properties, and the buyer's apparent budget flexibility.

**Why it matters:** many agents are poor negotiators. They either drop price too fast (losing builder commission) or hold firm and lose the deal. AI-powered suggestions like "The buyer's budget is ₹85L but Baner 2BHKs average ₹92L. Suggest showing them options in Mahalunge (10 min from Baner, avg ₹78L) as a value alternative" help agents negotiate smarter.

**Implementation:** when the conversation enters negotiation territory (price objections detected), generate a sidebar suggestion in the dashboard with 2-3 strategies: hold firm with justification, offer alternatives in adjacent localities, suggest a smaller config that fits budget, highlight upcoming price increases as urgency.

**Model tier:** free tier for suggestions. Premium tier for market data enrichment.

#### A.5 Conversation Summarization for Handoffs

**What:** when an agent takes over from the AI (or hands off to a colleague), generate a crisp conversation summary: who the buyer is, what they want, where they are in the journey, what was discussed, what's the next step.

**Why it matters:** agents hate reading through 30 messages to understand context. The existing `ai_summary` field captures this partially, but a dedicated handoff summary is more actionable.

**Implementation:** extend the extraction prompt to generate a `handoff_summary` — a 3-5 sentence brief formatted for the agent. E.g., "Priya (F, ~30s) is looking for a 2BHK in Baner or Balewadi, budget ₹80-95L, ready possession preferred. She's pre-approved for ₹70L home loan from HDFC. She's compared 3 projects but didn't like the small carpet areas. Suggested Kolte Patil 24K Sereno (985 sqft, ₹88L) — she wants to see it this weekend. Next step: confirm site visit for Saturday 11 AM."

**Model tier:** free tier.

#### A.6 Multi-Turn Context Management

**What:** maintain conversation context across sessions — a buyer who messages today and comes back 2 weeks later should be greeted with context: "Hi Priya! Last time you were interested in 2BHKs in Baner around ₹85L. Have your preferences changed?"

**Implementation:** store the latest extraction as structured context. When a returning lead messages, inject their profile into the system prompt so the AI continues the conversation seamlessly.

**Model tier:** free tier.

#### A.7 Objection Handling Library

**What:** detect common buyer objections ("too expensive," "not ready to buy yet," "already working with another agent," "location is too far from office") and suggest scripted responses that experienced agents use.

**Implementation:** classify the objection type via the LLM, then pull the best response from a curated library of 50+ objection handlers. The LLM personalizes the script with conversation context. Agents can also add their own winning responses to the library.

**Model tier:** free tier.

### B. Content Generation

Automating the content that agents create and share daily.

#### B.1 Property Listing Descriptions

**What:** generate property listing descriptions in two formats — portal-ready (99acres, MagicBricks format with structured fields) and WhatsApp-ready (casual, emoji-rich, concise).

**How it works:** agent inputs basic property details (config, carpet area, price, locality, floor, facing, amenities, RERA number) → LLM generates:
  - Portal listing: formal, keyword-optimized for search, 200-300 words, highlighting USPs.
  - WhatsApp text: casual, 50-80 words, emoji-heavy, with a call-to-action.
  - Status post: punchy one-liner for WhatsApp status.

**Model tier:** free tier.

#### B.2 Social Media Captions for Reels/Posts

**What:** generate Instagram/Facebook captions for property reels and posts. Include relevant hashtags (#PuneRealEstate #2BHKInBaner #ReadyPossession).

**Implementation:** agent uploads a property photo or reel → LLM generates 3 caption options (informative, emotional, urgency-driven). Include relevant hashtags, locality tags, and a call-to-action.

**Model tier:** free tier.

#### B.3 Personalized Follow-Up Messages

**What:** generate follow-up messages based on conversation history and time since last contact. Different tones for different situations — 1-day follow-up vs. 2-week re-engagement vs. post-site-visit.

**Implementation:** scheduled follow-up engine triggers at configurable intervals. The LLM generates a message that references the last conversation: "Hi Ramesh, you mentioned wanting to see the 3BHK in Wakad. This weekend works great for site visits — shall I book Saturday 11 AM?"

**Model tier:** free tier.

#### B.4 Festival Greeting Templates with Personalization

**What:** generate personalized festival greetings that feel handcrafted, not mass-blasted.

**Implementation:** LLM generates a unique greeting for each contact based on: the festival, the contact's name, their property search status (if they're a lead), and the agent's relationship with them. "Happy Diwali, Priya! 🪔 May this festive season light up your new home search. That 2BHK in Baner we discussed — the builder just announced a Diwali discount. Shall I send the details?"

**Model tier:** free tier.

#### B.5 WhatsApp Status Content Generation

**What:** daily auto-generated WhatsApp status content — property spotlights, market tips, motivational quotes, "just sold" celebrations, new listing alerts.

**Implementation:** LLM generates 3-5 status posts per day from the agent's inventory and market data. Agent picks and posts (or auto-posts on schedule). Content calendar with themes: Monday = Market Monday (trends), Wednesday = New Listing Wednesday, Friday = Fun Fact Friday.

**Model tier:** free tier.

#### B.6 Email Drip Campaigns

**What:** for agents who collect email addresses, generate and send automated email sequences — welcome series, property recommendations, market updates, festival greetings.

**Implementation:** LLM generates email content personalized to each lead's BLTC profile. SendGrid integration for delivery.

**Model tier:** free tier.

### C. Intelligence & Matching

Using AI to make smarter connections between leads and properties.

#### C.1 Semantic Property Matching

**What:** match leads to properties using semantic understanding, not just exact filter matches. A buyer asking for "something near Symbiosis school with a garden for my kids" should match properties in Viman Nagar / Kharadi with garden amenities and school proximity, even if they didn't say "Viman Nagar" explicitly.

**Implementation:** embed lead requirements and property descriptions using LLM embeddings (or simpler TF-IDF on free tier). Score matches based on semantic similarity, not just budget/config overlap. Factor in implicit preferences detected from conversation context.

**Why this is powerful:** filter-based matching misses 30-40% of valid matches because buyers don't always use the right keywords. Semantic matching captures intent.

**Model tier:** free tier for keyword-based semantic matching. Premium tier for embedding-based matching.

#### C.2 Price Prediction / Market Value Estimation

**What:** estimate the fair market value of a property based on comparable sales, locality trends, floor/facing premiums, amenities, and builder reputation.

**Implementation:** build a price estimation model from aggregated data across HomeNex agents — actual deal prices (from commission tracker data), listed prices (from inventory), and lead budgets (demand signals). The LLM provides the natural-language explanation: "This 2BHK in Baner is listed at ₹95L. Based on recent deals in the area (avg ₹7,100/sqft for ready 2BHKs), comparable properties, and the east-facing premium, fair value is approximately ₹88-92L. The listing is slightly above market."

**Model tier:** free tier for explanation generation. The price model itself is statistical, not LLM-based.

#### C.3 Lead Scoring with Explainable Reasons

**What:** enhance the existing lead scoring (0-100) with human-readable explanations for each score component.

**Current state:** the `score_breakdown` field already provides labeled factors. Enhance this with actionable context: instead of "Budget clarity: 80," say "Budget clarity: 80 — buyer has a pre-approved loan of ₹70L from HDFC, indicating serious intent and clear budget ceiling of ₹85-90L with own contribution."

**Model tier:** free tier.

#### C.4 Churn Prediction — Which Leads Are Going Cold

**What:** predict which active leads are about to go cold based on engagement patterns — decreasing response frequency, shorter messages, avoiding price/visit discussions, mentioning other agents.

**Implementation:** track per-lead engagement metrics: avg response time, message length trend, days since last message, sentiment trend. When churn probability exceeds a threshold, alert the agent: "⚠️ Priya hasn't responded in 5 days and her last message was a one-word reply. She may be going cold. Suggested action: send her the new listings in Baner that came this week."

**Model tier:** free tier for pattern detection. The signals are mostly rule-based (response frequency, gap duration) with LLM providing the alert text and suggested action.

#### C.5 Best Time to Contact Prediction

**What:** analyze each lead's messaging patterns to predict the best time to send a follow-up — when they're most likely to read and respond.

**Implementation:** track when each lead typically messages (morning commute? lunch break? late evening?). Build a per-lead contact preference: "Ramesh is most responsive between 9-10 PM on weekdays. Avoid calling before 11 AM — he's never responded to morning messages."

**Model tier:** free tier (this is analytics, not LLM — the LLM just formats the insight).

#### C.6 Lookalike Lead Identification

**What:** when an agent closes a deal, find other leads in their pipeline with similar profiles — same locality preference, similar budget, comparable timeline. These "lookalike" leads are most likely to convert.

**Model tier:** free tier.

#### C.7 Deal Probability Scoring

**What:** predict the probability of a lead converting to a deal based on historical patterns — leads with pre-approved loans who've done site visits close at 4x the rate of those who haven't.

**Model tier:** free tier for pattern matching. Data-driven, not LLM-dependent.

### D. Voice & Multimedia AI

Features that process audio and visual content — these are premium tier features that justify the paid plan.

#### D.1 Call Transcription (Indian Languages + Hinglish)

**What:** transcribe phone calls between agents and clients in Hindi, Marathi, Hinglish, Tamil, Telugu, Kannada, and other Indian languages. Extract key information from the call.

**Implementation:** agents tap "Record" before a client call (or auto-record with consent). The audio is transcribed using Whisper-large or a specialized Indian language ASR model. The transcription is then processed by the LLM to extract: BLTC updates, action items, commitments made, and a call summary.

**Why agents want this:** agents make 20-30 calls per day but forget half of what was discussed. Call transcription + AI summary means every call's context is captured and linked to the lead.

**Model tier:** premium tier (Whisper API costs ~$0.006/min; an average 5-min call costs ₹2.5).

#### D.2 Voice Note Transcription in WhatsApp

**What:** when a buyer sends a WhatsApp voice note, auto-transcribe it and process it through the normal BLTC extraction pipeline.

**Implementation:** WhatsApp webhook delivers voice messages as audio files. Download the audio, transcribe with Whisper, then feed the transcription into the existing `extractLead()` pipeline. Reply to the buyer as if they'd typed the message.

**Why this is critical:** Indian buyers (especially older demographic) send voice notes more than text. Without transcription, HomeNex AI is blind to 30-40% of communication.

**Model tier:** premium tier (Whisper).

#### D.3 Property Photo Analysis

**What:** auto-tag rooms (living room, bedroom, kitchen, bathroom, balcony), detect issues (poor lighting, unfinished construction, damage), estimate room dimensions, and assess photo quality.

**Implementation:** when an agent uploads property photos, run them through a vision model. Extract tags, quality score, and improvement suggestions. Auto-generate a photo description for listings. Flag low-quality photos: "This kitchen photo is too dark — try retaking with the lights on and window curtains open."

**Model tier:** premium tier (vision model required).

#### D.4 Floor Plan Digitization

**What:** convert a photo of a hand-drawn or printed floor plan into a digital, interactive floor plan with room labels, dimensions, and areas.

**Implementation:** vision model identifies rooms, walls, doors, windows. Convert to SVG or interactive HTML with labeled rooms and calculated carpet area. Agent can share the digital floor plan with clients via WhatsApp.

**Model tier:** premium tier (vision model).

#### D.5 Virtual Staging Suggestions

**What:** given an empty room photo, suggest furniture placement and decor to help buyers visualize the space. Generate a text description of staging ("Place a 3-seater sofa against the east wall, a 6-seater dining table near the balcony, and a TV unit on the north wall").

**Implementation:** vision model analyzes room dimensions and layout. LLM generates staging suggestions with furniture sizing. For premium-premium users, integrate with an image generation model to create a staged photo.

**Model tier:** premium tier (vision + generation).

#### D.6 Video Property Tours — Auto-Narration

**What:** agent records a walk-through video of a property → AI generates a professional voiceover narration describing each room, amenities, and view.

**Model tier:** premium tier (video processing + TTS).

### E. Document Intelligence

AI-powered document processing for the paperwork-heavy Indian real estate workflow.

#### E.1 Extract Key Terms from Agreements

**What:** upload a sale agreement, builder-buyer agreement, or allotment letter → AI extracts key terms: property description, total consideration, payment schedule, possession date, penalties, GST applicability, carpet vs. built-up area, parking allocation, maintenance charges.

**Implementation:** PDF/image upload → OCR (if scanned) → LLM extracts structured data from legal text. Present a clean summary card: "Agreement for Flat 302, Tower B, at ₹98L. Possession: Dec 2027. Penalty for delay: ₹5/sqft/month. Parking: 1 covered. Maintenance: ₹4/sqft/month."

**Model tier:** free tier for text-based documents. Premium tier for scanned PDFs (OCR + vision).

#### E.2 RERA Document Parsing

**What:** parse RERA (Real Estate Regulatory Authority) project registrations and compliance certificates. Extract: RERA number, project name, developer name, approved units, carpet areas, completion date, financial disclosures.

**Implementation:** RERA documents are typically PDFs. Download from state RERA websites (MahaRERA, K-RERA, etc.) and parse using the LLM. Surface compliance status: is the project's RERA registration active? When does it expire? Are there any complaints filed?

**Model tier:** free tier for text PDFs. Premium for scanned documents.

#### E.3 KYC Document Verification (PAN / Aadhaar OCR)

**What:** client shares their PAN card or Aadhaar photo via WhatsApp → AI extracts the name, number, and DOB → auto-fills the client profile → validates format (PAN: ABCDE1234F pattern, Aadhaar: 12-digit with Verhoeff checksum).

**Implementation:** WhatsApp image webhook → download image → vision model OCR → extract fields → validate → store securely (encrypted). Never store the full document image after extraction — store only the extracted text fields.

**Privacy:** critical to handle with care. Encrypt at rest, mask in logs, auto-delete raw images after extraction. Comply with India's DPDPA (Digital Personal Data Protection Act).

**Model tier:** premium tier (vision model for OCR).

#### E.4 Rental Agreement Drafting with Clause Suggestions

**What:** extends the Rental Agreement Generator (Phase 3) with AI-powered clause suggestions. Agent describes a situation in natural language → AI suggests the appropriate legal clause.

**Examples:** "Tenant wants to keep a dog" → generates a pet permission clause with standard conditions (no aggressive breeds, tenant liable for damage, society rules apply). "Landlord wants to increase rent after 11 months" → generates a rent escalation clause with the agreed percentage.

**Model tier:** free tier.

#### E.5 Stamp Duty & Registration Fee Calculator

**What:** calculate stamp duty, registration fees, and GST for property transactions across Indian states. Account for: property type (residential/commercial), buyer gender (women get concessions in some states), property value, under-construction vs. ready, first-time buyer concessions.

**Implementation:** rules engine with state-specific rates. LLM provides natural-language explanation: "For this ₹95L flat in Pune, stamp duty is ₹6.65L (7%), registration is ₹30K (capped), and GST is ₹4.75L (5% for under-construction). Total closing cost: ₹11.7L."

**Model tier:** free tier (rules engine + LLM explanation).

### F. Agent Coaching & Performance

AI that helps agents become better at their job.

#### F.1 Response Quality Scoring

**What:** score every agent reply (manual, not AI) on clarity, helpfulness, professionalism, and actionability. Surface a monthly "Communication Score" for the agent.

**Implementation:** after every agent-sent message, the LLM scores it on 4 dimensions (1-10 each). Show trends over time. Compare against AI-generated replies to surface improvement areas: "Your last 10 replies averaged 6.2/10 on actionability. Try ending each message with a specific next step for the client."

**Model tier:** free tier (runs async, not in the critical path).

#### F.2 Suggested Improvements for Messages

**What:** before an agent sends a message from the dashboard, offer an AI-improved version. "Your message → AI-improved version → Send original or improved."

**Implementation:** agent types a reply in the Inbox → a "✨ Improve" button generates an improved version: more professional, includes relevant context from the conversation, adds a clear CTA. Agent can use it as-is, edit, or discard.

**Model tier:** free tier.

#### F.3 Win/Loss Analysis with AI Explanations

**What:** when a deal closes (win) or a lead goes permanently cold (loss), the AI analyzes the full conversation history and provides an explanation of what worked or didn't.

**Implementation:** LLM reviews the entire message thread and generates: "This lead converted because the agent responded within 30 seconds, addressed the Vastu concern immediately, and offered a competitive 3-property comparison. The site visit on Day 3 was the turning point." Or: "This lead was lost because follow-up was delayed by 6 days after the site visit, and the agent didn't address the EMI concern raised on Day 2."

**Why agents want this:** agents rarely reflect on why deals succeed or fail. AI-powered analysis builds institutional knowledge.

**Model tier:** free tier.

#### F.4 Training Content Recommendations

**What:** based on an agent's performance gaps (low response quality scores, high lead churn, poor negotiation outcomes), recommend specific training content: articles, videos, scripts, and best practices.

**Implementation:** maintain a content library of 50-100 training modules (short articles/videos). LLM matches agent weaknesses to relevant training content. Push via WhatsApp: "Your EMI-related conversations have a 20% lower conversion rate. Here's a 3-min guide on handling loan-related objections: [link]"

**Model tier:** free tier.

#### F.5 Real-Time Coaching During Conversations

**What:** as the agent is chatting with a lead in the Inbox, show contextual coaching tips in a sidebar: "The client just mentioned they're comparing with another project. This is a good time to highlight your property's USPs and offer a site visit."

**Model tier:** free tier (process each new buyer message through a coaching prompt async).

### G. Market Intelligence

AI-powered insights from aggregated platform data.

#### G.1 Area Price Trend Analysis

**What:** track price trends per locality, per BHK configuration, over time — using aggregated data from all agents on HomeNex (inventory listings + deal data from commission tracker).

**Implementation:** aggregate anonymized pricing data. LLM generates trend reports: "Baner 2BHK prices increased 8% QoQ (Q1 2026 vs Q4 2025). Average asking: ₹7,200/sqft. Highest deal: ₹8,100/sqft (16th floor, west-facing at Kolte Patil 24K). Inventory levels down 12% — seller's market conditions emerging."

**Model tier:** free tier for report generation.

#### G.2 Competitor Pricing Monitoring

**What:** track what competitors (other agents/builders) are listing similar properties for. Alert agents when their listings are overpriced or underpriced relative to the market.

**Implementation:** scrape or aggregate listing data from public portals (99acres, MagicBricks, Housing.com). LLM compares the agent's inventory prices against market: "Your 2BHK in Wakad is listed at ₹82L. Average for similar properties: ₹78L. You're 5% above market — consider adjusting or highlighting premium features."

**Model tier:** free tier.

#### G.3 Demand Forecasting by Locality/BHK

**What:** predict which locality + BHK combinations will see increased demand in the next 30/60/90 days — based on lead inquiry trends, search patterns, and seasonal patterns.

**Implementation:** time-series analysis on lead inquiry data. LLM narrates the forecast: "3BHK demand in Hinjewadi is projected to spike 35% in October — IT companies are announcing return-to-office mandates. Agents with Hinjewadi inventory should increase their WhatsApp status posting frequency."

**Model tier:** free tier.

#### G.4 New Project Launch Detection

**What:** automatically detect when a new project is launched in a locality — from broker group messages, portal listings, or RERA filings — and alert relevant agents.

**Implementation:** monitor broker group messages (from the Broker Group Intelligence feature), RERA website filings, and portal new listings. LLM extracts project details and generates an alert: "New launch: Godrej Horizon, Baner-Balewadi road. 2/3/4 BHK, ₹7,500-8,200/sqft, possession Dec 2028, RERA: P52100078888. You have 3 active leads who might be interested."

**Model tier:** free tier.

#### G.5 Seasonal & Event-Based Opportunity Alerts

**What:** alert agents to seasonal buying patterns and events that drive real estate demand — Gudi Padwa (auspicious buying season in Maharashtra), stamp duty changes, interest rate changes, budget announcements, infrastructure project approvals.

**Model tier:** free tier.

### H. Workflow Automation

AI-powered automation of repetitive agent workflows.

#### H.1 Auto-Categorize Leads by Stage

**What:** automatically move leads through pipeline stages — New → Qualified → Site Visit Scheduled → Site Visit Done → Negotiation → Booking → Closed. Detect stage transitions from conversation content.

**Implementation:** LLM detects stage transitions from messages. "Client just confirmed Saturday site visit" → move to "Site Visit Scheduled." "Client said they'll book after Diwali" → move to "Negotiation."

**Model tier:** free tier.

#### H.2 Smart Task Generation

**What:** after every conversation, auto-generate tasks for the agent: "Call Priya to confirm Saturday site visit," "Send Kolte Patil brochure to Ramesh," "Follow up with Suresh about loan pre-approval status."

**Implementation:** LLM extracts commitments and next steps from conversations. Create tasks with due dates and reminders. Push reminders via WhatsApp.

**Model tier:** free tier.

#### H.3 End-of-Day Summary

**What:** every evening at 8 PM, send the agent a WhatsApp summary of their day: new leads, conversations held, follow-ups due tomorrow, hot leads needing attention, commission updates.

**Implementation:** aggregate daily activity data. LLM generates a conversational summary: "Today: 4 new leads (1 hot), 12 conversations, 2 site visits completed. Tomorrow: follow up with Priya (hot, wants to see Kolte Patil), call Ramesh about loan status. Commission update: ₹1.2L received from Builder X today."

**Model tier:** free tier.

#### H.4 Intelligent Auto-Reply Scheduling

**What:** when a lead messages outside business hours, send an intelligent auto-reply that acknowledges their specific query (not a generic "we'll get back to you") and schedules a callback: "Hi Priya! You asked about 2BHKs in Baner. Great options available from ₹78-95L. Rajesh will call you at 10 AM tomorrow with details. Meanwhile, here are 2 properties that match your budget: [links]."

**Model tier:** free tier.

### I. Agentic AI & Autonomous Workflows

Moving beyond reactive AI (respond when asked) to proactive AI agents that act autonomously on the broker's behalf.

#### I.1 Autonomous Lead Nurturing Agent

**What:** a background AI agent that monitors every lead in the pipeline and autonomously takes actions — sending follow-ups, sharing relevant new listings, re-engaging cold leads, scheduling site visits — without the agent explicitly asking it to. The broker sets guardrails (max messages/day, no price negotiations without approval, always route hot leads to human), and the AI handles the rest.

**Why this is the future:** the shift from "AI chatbot" to "AI employee" is the biggest trend in CRM AI (2025-2026). Lofty's agentic OS monitors an agent's entire database and resurfaces dormant leads showing sell-readiness signals. HomeNex can leapfrog by building this natively for WhatsApp.

**Implementation:** deploy specialized micro-agents — one for lead nurturing, one for follow-up scheduling, one for content posting, one for market monitoring. Each agent has defined capabilities and guardrails. A supervisor agent coordinates them based on the broker's preferences.

**Meta compliance:** Meta's January 2026 AI policy blocks general-purpose AI chatbots on WhatsApp — only purpose-specific bots (support, bookings, tracking) are allowed. This is actually an advantage: HomeNex's architecture of multiple purpose-specific agents (scheduling bot, follow-up bot, qualification bot) is inherently compliant. Competitors building monolithic chatbots face regulatory risk.

**Model tier:** free tier for rule-based actions. Premium tier for autonomous decision-making with more capable models.

#### I.2 RAG-Powered Property Knowledge Base

**What:** a Retrieval-Augmented Generation (RAG) system that ingests builder brochures, RERA documents, locality amenity data, floor plans, price lists, and sales comps. When a buyer asks "what schools are near Kolte Patil 24K?", the AI retrieves the specific locality data and generates an accurate, sourced answer — not a hallucination.

**Why this matters:** LLMs hallucinate property details (wrong prices, non-existent amenities, incorrect possession dates). RAG grounds responses in actual documents and data, dramatically improving accuracy and trust.

**Implementation:** for each agent, maintain a vector store of their inventory documents (brochures, price lists, floor plans). For each locality, ingest public data (school listings, hospital distances, metro connectivity, upcoming infrastructure projects). On each buyer query, retrieve relevant chunks and generate a grounded response with source attribution.

**Model tier:** free tier for retrieval + generation. Embedding costs are minimal (~$0.0001 per document page).

#### I.3 Voice AI with Indian Accent & Language Tuning

**What:** voice AI agents that can make and receive calls on behalf of the broker — handling initial lead screening, appointment booking, and basic qualification — with Indian language support and regional accent adaptation.

**Why this is novel:** VBHC Homes (July 2026) deployed the first enterprise Voice AI in Indian residential real estate. Their discovery: auto-detecting language mismatch and rerouting Kannada/Hindi leads boosted connect rates from 19% to 34%. Voice AI that speaks Marathi in Pune and Kannada in Bangalore is a differentiator.

**Implementation:** integrate with voice AI providers (e.g., Bland.ai, Retell.ai, or build on Whisper + TTS). Train on Indian real estate conversation patterns. Support: Hindi, Marathi, Tamil, Telugu, Kannada, Bengali, Gujarati, and Hinglish. The AI handles initial screening calls ("Hi, I'm calling from [agent name]'s team. You showed interest in 3BHKs in Baner. Are you still looking?") and routes qualified leads to the human agent.

**Model tier:** premium tier (voice processing + TTS costs).

#### I.4 AI Property Condition Scoring

**What:** upload property photos → AI scores the property's condition on a C1-C6 scale (excellent to poor), identifies issues (peeling paint, water stains, cracked tiles, incomplete construction), and estimates renovation costs.

**Why agents want this:** for resale properties, condition assessment is subjective and time-consuming. An objective AI score helps agents price properties correctly and gives buyers confidence. VeroVISION (June 2026) achieves 93% correlation with human appraisers, but no India-specific competitor exists yet.

**Implementation:** fine-tune a vision model on Indian property photos (different construction styles, materials, and common issues vs. Western properties). Generate a report: "Condition: C3 (Fair). Issues: kitchen tiles need replacement (est. ₹40K), bathroom waterproofing shows signs of age (est. ₹25K), balcony railing rust (est. ₹10K). Total estimated renovation: ₹75K."

**Model tier:** premium tier (vision model).

#### I.5 Indian Legal Document Intelligence

**What:** AI that understands and processes the full spectrum of Indian real estate documents — not just agreements, but title deeds, encumbrance certificates (ECs), revenue records (7/12 extracts in Maharashtra, Khata in Karnataka), power of attorney, mutation certificates, building permission orders, occupancy certificates, and NOCs.

**Why this matters:** LegiScore processes 20+ Indian document types across 12+ languages, handling handwritten Sub-Registrar endorsements and faded legacy documents. Maharashtra now grants legal validity to digitally signed 7/12 extracts — an API integration opportunity.

**Implementation:** build OCR + LLM pipelines for each document type. For 7/12 extracts: parse owner name, survey number, land area, crop details, mutation history. For ECs: extract encumbrance entries (mortgages, liens, court orders) and flag risks. For title deeds: chain-of-title analysis to detect gaps or forged links.

**Model tier:** premium tier (vision + specialized prompting). Could be a standalone paid feature: ₹199 per document analysis.

### J. Carousel & Rich Media AI

AI-powered generation of WhatsApp-native rich media content using the latest API features.

#### J.1 Auto-Generated Property Carousels

**What:** automatically generate WhatsApp carousel messages (2-10 scrollable cards) from the agent's inventory, each card with a property photo, key details, and CTA buttons ("Book Site Visit" / "Get Cost Sheet" / "View on Map").

**Implementation:** when an agent asks "send Priya options for 2BHK Baner under 1Cr," the AI selects matching properties, generates carousel cards with the best photo, price, carpet area, and a compelling one-liner per card. Sent as a carousel template message via the WhatsApp Business API.

**Model tier:** free tier for card content generation. Carousel templates require Meta pre-approval.

#### J.2 Multi-Product Catalog Messages

**What:** leverage WhatsApp Business catalog to send multi-product messages — up to 30 properties from the agent's catalog in a single message, browsable in-chat.

**Implementation:** sync agent inventory to WhatsApp Business Catalog (up to 500 items per WABA). When a buyer asks for options, send a multi-product message with relevant properties. Buyer taps a property → sees full details → taps "Enquire" → starts a conversation about that property. No links, no external apps.

**Model tier:** free tier (catalog sync is API-driven, not AI-driven).

---

## AI Model Strategy

### Default: OpenRouter Free Tier

All features default to OpenRouter's free models unless they require vision or audio processing.

| Use Case | Recommended Model | Tier |
|---|---|---|
| Conversational replies | gpt-oss-120b:free | Free |
| BLTC extraction / lead scoring | gpt-oss-120b:free | Free |
| Content generation (listings, captions) | gpt-oss-120b:free | Free |
| Hinglish NLU / intent detection | gpt-oss-120b:free | Free |
| Sentiment analysis | gpt-oss-20b:free | Free |
| Document parsing (text PDFs) | gpt-oss-120b:free | Free |
| Quick calculations (EMI, stamp duty) | gpt-oss-20b:free | Free |
| Voice note transcription | whisper-large-v3 | Premium |
| Call transcription (Indian languages) | whisper-large-v3 | Premium |
| Property photo analysis | vision model (e.g. gpt-4o-mini) | Premium |
| Floor plan digitization | vision model | Premium |
| KYC document OCR | vision model | Premium |
| Virtual staging | vision + image generation | Premium |
| RAG retrieval + generation | gpt-oss-120b:free + embeddings | Free |
| Voice AI (screening calls) | Whisper + Indian language TTS | Premium |
| Property condition scoring | vision model (fine-tuned) | Premium |
| Legal document intelligence | vision model + specialized prompts | Premium |
| Carousel/rich media generation | gpt-oss-120b:free | Free |
| Agentic autonomous workflows | gpt-oss-120b:free (rule-based) | Free |

### Upsell Triggers

The free tier should be generous enough that agents get hooked. Premium upsell triggers are built into the UX:

- Voice note arrives → "🎙️ Upgrade to Pro to auto-transcribe voice notes (₹499/mo)"
- Floor plan uploaded → "📐 Upgrade for Vastu analysis and digital floor plans"
- Blurry photo detected → "📸 Upgrade for AI photo enhancement and auto-tagging"
- Agent hits daily free-tier rate limit → "You've used 50 AI replies today. Upgrade for unlimited."

### Cost Management

- Batch extraction calls (don't re-extract after every message — extract after a conversation pause of 2+ minutes).
- Cache common calculations (EMI for standard amounts, stamp duty per locality).
- Use gpt-oss-20b:free for simple tasks (sentiment, intent) and gpt-oss-120b:free for complex tasks (extraction, generation).
- Queue non-urgent AI tasks (daily summaries, training recommendations) for off-peak processing.

---

## WhatsApp Business API Strategy

HomeNex's core differentiation is being WhatsApp-native. This section catalogs every WhatsApp Business API capability and how HomeNex should leverage it. API landscape as of mid-2026.

### Platform Changes

- **Cloud API only:** the On-Premise API was fully deprecated in October 2025. Cloud API is the sole path, offering up to 1,000 messages/second throughput.
- **Coexistence:** since January 2026, Cloud API and the WhatsApp Business App can coexist on the same phone number. This means agents can use HomeNex's API integration AND still use WhatsApp Business App manually for ad-hoc messages — a major onboarding friction reducer.
- **Pricing model:** shifted from per-conversation to per-delivered-template pricing. Marketing templates: ~₹0.86 per message. Utility templates: ~₹0.12. Authentication templates: ~₹0.04. All plus 18% GST. Service replies within the 24-hour window are free (until at least October 2026). This pricing model directly affects feature design — minimize marketing templates, maximize utility templates and session messages.

### Message Types to Leverage

| Message Type | Use Case in HomeNex | Cost |
|---|---|---|
| **WhatsApp Flows** | Lead qualification forms, site visit booking, document checklist, feedback forms | Free (session message) |
| **Reply Buttons** (up to 3) | Quick responses: "Interested / Not now / Tell me more" | Free (session message) |
| **List Messages** (up to 10 items) | Property shortlist, locality selection, time slot picker for site visits | Free (session message) |
| **Location Request** | "Share your preferred area" — returns lat/long for locality matching | Free (session message) |
| **Carousel Templates** (2-10 cards) | Property showcase with photos and CTA buttons | Marketing template cost |
| **Multi-Product Messages** (up to 30 items) | Browse agent's full inventory in-chat | Free (session message) |
| **Single Product Messages** | Detailed property card with photo, description, price | Free (session message) |
| **Authentication Templates** | OTP verification for buyer identity during document submission | Auth template cost |
| **Payment Messages** | Collect booking tokens via UPI in-chat | Free (session message) |

### Key API Features

- **WhatsApp Flows (GA mid-2024, Flow JSON v7.0):** multi-screen interactive forms running natively inside WhatsApp. Text inputs, dropdowns, date pickers, conditional routing. Supported on WhatsApp Web since December 2025. HomeNex should build 5-6 reusable flows: buyer qualification, rental inquiry, site visit booking, document upload, post-visit feedback, referral submission.

- **Business Calling API (GA July 2025):** agents can call leads directly from WhatsApp while seeing the full chat history. Critical for high-touch real estate sales where context matters. HomeNex should integrate this as the primary calling method (supplement to cloud telephony, not replacement).

- **Catalog API (up to 500 products per WABA):** properties listed as catalog items with images, descriptions, and prices. Buyers browse, view details, and express interest without leaving WhatsApp. Sync agent inventory automatically.

- **Click-to-WhatsApp Ads (CTWA):** Meta's fastest-growing ad format in India. The `ReferralCtwaClid` parameter (added March 2024) enables closed-loop lead attribution — track exactly which ad generated which lead. Conversions API (CAPI) integration with `action_source: "business_messaging"` tracks ad-to-conversation ROI.

- **Meta Business Agent Platform (GA June 2026):** AI agents that handle initial lead screening, FAQ responses, and scheduling at ~$0.04-0.05/message. HomeNex should evaluate whether to use Meta's agent platform or maintain its own AI layer. Recommendation: maintain own AI (more control, better Hinglish support, lower cost with OpenRouter free tier) but monitor Meta's platform for commodity use cases.

### Template Strategy

Templates require Meta pre-approval and cost money. Strategy: minimize template usage by maximizing session messages.

- **Marketing templates (₹0.86 each):** use sparingly — festive greetings, new listing announcements, re-engagement after 24-hour window expires. Pre-register 15-20 templates covering: festival greetings (10 festivals × language variants), new listing alert, price drop alert, site visit invitation, market update.
- **Utility templates (₹0.12 each):** booking confirmations, site visit reminders, document upload requests, payment receipts. These are high-volume but low-cost.
- **Authentication templates (₹0.04 each):** OTP for buyer portal login, document submission verification.
- **Session messages (free):** all interactive conversations within the 24-hour window — qualification flows, property discussions, negotiations, Flows, catalog messages, payment requests. Design the UX to keep conversations within session windows whenever possible.
- **Auto-recategorization risk:** since July 2024, Meta auto-reclassifies misclassified templates as Marketing (higher cost). Ensure template category accuracy.

### Rate Limits & Scaling

- Unverified business numbers: 1,000 messages/day.
- Verified (Green Badge): 10,000/day initially, scaling to 100,000/day based on quality rating.
- Cloud API throughput: up to 1,000 messages/second.
- **Recommendation:** guide agents through Meta Business Verification during onboarding. A verified number with high quality rating is essential for bulk festive greetings and drip campaigns.

---

## Compliance & Regulatory Module

Indian real estate is heavily regulated. A CRM that helps agents stay compliant — rather than just manage leads — becomes mission-critical and extremely sticky.

### RERA Compliance

- **Agent registration tracker:** RERA registration is mandatory for agents in most states (5-year validity). HomeNex should track each agent's RERA number, registration date, expiry date, and state authority. Auto-remind agents 90, 60, and 30 days before renewal. Store the RERA certificate for quick sharing with clients.
- **Advertising compliance validator:** RERA mandates that every property advertisement must include the RERA registration number, authority website URL, and (under RERA 2.0) a QR code linking to the project's RERA page. When an agent generates a WhatsApp status post, property card, or listing description, HomeNex should auto-validate that the RERA number is included and correctly formatted. Block or warn on non-compliant content.
- **MahaRERA Certificate of Competency:** Maharashtra requires agents to pass a 50-MCQ exam. UP mandates training completion by December 2026. Track certification status per agent per state.
- **Penalties awareness:** operating without RERA registration risks ₹10K/day fine, up to 5% of property cost. Surface this in onboarding to drive compliance adoption.
- **RERA 2.0 readiness:** upcoming changes include three-bank-account escrow tracking, QR code transparency requirements, suo moto action alerts, and extended jurisdiction over previously unregistered projects. Build flexible compliance infrastructure that can adapt.

### GST & TDS Automation

- **GST calculator:** apply correct GST rates automatically — 1% for affordable housing (under-construction, carpet area ≤60 sqm in metros / ≤90 sqm in non-metros, value ≤₹45L), 5% for non-affordable under-construction, 0% for ready-to-move-in with OC. Brokerage/commission attracts 18% GST. No ITC available at concessional 1%/5% rates for residential.
- **TDS on property (Section 194-IA):** buyer must deduct 1% TDS on properties above ₹50L and file Form 26QB within 30 days of month-end. HomeNex should calculate TDS amount and remind the agent/buyer about filing deadlines. Generate a pre-filled Form 26QB for the buyer.
- **GST on brokerage:** agents earning commission above ₹20L/year must register for GST. Track aggregate commission earnings and alert agents when they approach the threshold. Auto-generate GST invoices for commission payments received.

### Digital Personal Data Protection Act (DPDPA) 2023

- **Consent management:** collect granular, purpose-specific consent from every lead before storing their personal data (no pre-ticked boxes). Consent must specify: what data is collected, why, how long it's stored, who it's shared with. Maintain a consent audit trail.
- **Consent withdrawal:** provide a mechanism for leads to withdraw consent and request data deletion. When consent is withdrawn, auto-delete personal data and notify the agent.
- **Data lifecycle:** auto-delete personal data when the purpose is fulfilled (e.g., lead goes permanently cold, deal is closed and commission is settled) or when consent is withdrawn. Configurable retention periods.
- **Cross-border transfers:** allowed unless a country is on the government's restricted list (currently none restricted, but build the infrastructure to block if needed).
- **Penalties:** up to ₹250 crore for violations. This is not optional.
- **Implementation in HomeNex:** consent collection screen during lead import/creation, consent status flag per lead, automated data deletion scheduler, consent audit log, privacy dashboard for the agent showing DPDPA compliance status.

### Anti-Money Laundering (AML / PMLA)

- **Background:** real estate agents are reporting entities under the Prevention of Money Laundering Act (PMLA). Customer Due Diligence (CDD) and Enhanced Due Diligence (EDD) are required for all clients.
- **FIU-IND registration:** mandatory for transactions above ₹50L. Cash transactions above ₹10L must be reported to FIU-IND (Financial Intelligence Unit - India).
- **Suspicious Transaction Reports (STR):** if a transaction appears suspicious (e.g., cash payments, benami transactions, structured transactions to avoid reporting thresholds), the agent must file an STR. HomeNex should flag potentially suspicious patterns and guide agents on reporting obligations.
- **Beneficial ownership:** verify beneficial ownership for company/trust buyers — 10% threshold for companies/trusts, 15% for partnerships. Maintain records for 5 years.
- **Implementation:** KYC checklist per client (PAN, Aadhaar, address proof, income declaration), transaction value flagging (auto-flag deals above ₹50L for enhanced documentation), beneficial ownership capture for non-individual buyers, STR flag and reporting workflow.

### State-Specific Configuration

Each state has different stamp duty rates, registration fees, and regulatory nuances. HomeNex needs a state configuration module.

- **Maharashtra:** stamp duty 5% (women) / 6% (men) / 7% (joint — one non-woman). Registration capped at ₹30K. Ready reckoner rate integration for minimum valuation. Leave & License format for rental agreements.
- **Karnataka:** slab-based stamp duty 2-5%. Registration at 2% (doubled since August 2025). BBMP 0.5% cess on Bangalore properties. Khata certificate and extract required for property transfer.
- **Delhi NCR:** 4% (women) / 6% (men) stamp duty. Circle rate zones A-H determine minimum valuation. Split jurisdiction: UP-RERA for Noida/Greater Noida, HRERA for Gurgaon/Faridabad. DDA vs. private colony distinctions.
- **Telangana:** 4% stamp duty + 0.5% registration (recent reductions). GHMC properties have additional charges. RERA Telangana has its own portal and format requirements.
- **Tamil Nadu:** 7% stamp duty + 4% registration — one of the highest in India. Guideline value (government valuation) integration for minimum stamp duty calculation. TNRERA specifics.

---

## Mobile App Strategy

While the dashboard is web-based (React + Vite), a dedicated mobile experience is critical for field agents who spend 70% of their time outside the office.

### Progressive Web App (PWA) — Phase 1

- **Approach:** convert the existing React dashboard to a PWA with offline support, push notifications, and home screen installation. This gives 80% of native app benefits with zero App Store friction.
- **Offline mode:** cache critical data (lead list, contact details, recent conversations, property inventory) using service workers. Agents in low-connectivity areas (construction sites, suburban project locations) can view lead details and draft messages offline. Auto-sync when connectivity returns.
- **Push notifications:** real-time alerts for new leads, hot lead assignments, client messages, site visit reminders, commission updates — without requiring the dashboard to be open.

### Native Features — Phase 2

- **GPS check-in (for site visit proof):** use the device's native GPS for accurate site visit verification. PWA geolocation API works, but a native wrapper (Capacitor/Ionic) provides background GPS access and better accuracy.
- **Camera integration:** direct photo capture for property photos, document scans (KYC), and site visit proof images. Native camera access provides better quality than browser-based capture.
- **Contact sync:** request permission to read the agent's phone contacts. Auto-suggest adding frequent contacts as clients in HomeNex. Detect when a lead calls (caller ID integration on Android).
- **Quick actions:** floating action button for one-tap "Add Lead" (enter phone number → HomeNex creates the lead and sends a greeting), "Check In" (GPS capture for site visit), and "Quick Follow-up" (list of leads needing follow-up today).

### Field Operations

- **Beat planning:** for agents covering multiple localities, plan daily routes: "Visit Baner project at 10 AM → Wakad site visit at 11:30 AM → Hinjewadi showing at 2 PM." Optimize route order using Google Maps API. Share the day's schedule via WhatsApp with the team lead.
- **Expense tracking:** log travel expenses (fuel, toll, food) against specific site visits or projects. Generate monthly expense reports for reimbursement from builders.

---

## Admin Portal Features

The existing admin panel at `/admin` needs to evolve into a comprehensive platform management tool.

### Agent Management

- **Onboarding workflow:** guided signup → RERA verification → WABA phone number configuration → first lead setup → tutorial completion. Track onboarding completion rate and drop-off points.
- **Agent health dashboard:** per-agent metrics — active leads, response time, conversion rate, AI usage, subscription tier, last login, RERA expiry status. Identify churning agents (declining login frequency) and at-risk accounts.
- **Tier management:** upgrade/downgrade agent subscriptions. Apply promotional pricing, trial periods, and referral credits. Bulk operations for onboarding teams of agents from a single brokerage firm.

### Platform Analytics

- **Revenue dashboard:** MRR, ARR, churn rate, ARPU, LTV by tier. Revenue breakdown by source: subscriptions, rental agreements, managed ads, lead marketplace, builder portal fees, cost sheet charges.
- **Usage analytics:** API calls per agent, WhatsApp messages sent/received, AI model usage (free vs. premium), feature adoption rates. Identify which features drive retention.
- **Growth metrics:** new agent signups, activation rate (first lead within 7 days), week-1/month-1 retention, viral coefficient (agents who invite other agents).

### Content & Template Management

- **Template approval pipeline:** manage WhatsApp message templates — create, submit to Meta for approval, track approval status, version history. A/B test template variations.
- **Festive calendar management:** add/edit festivals, set reminder schedules, manage greeting templates across languages and regions.
- **Training content CMS:** manage the coaching module library — add articles, videos, scripts. Track content engagement and effectiveness.

### Support & Operations

- **Agent support tickets:** in-app support system. Agents report issues via WhatsApp or the dashboard. Track resolution time, categorize issues, build a knowledge base.
- **Broadcast messaging:** send platform-wide announcements to all agents — new features, maintenance windows, policy updates. Via WhatsApp (utility template) and in-app notification.
- **Data export:** GDPR/DPDPA-compliant data export for agents who want to leave the platform. Export leads, conversations, contacts, and commission data in CSV/JSON format.

---

## Onboarding & User Education

Agent onboarding and education determine retention. Most real estate CRM churn happens in the first 14 days.

### Day 0-1: Activation

- **60-second signup:** name, phone, password → OTP verification → dashboard. No WABA setup required initially — let agents explore with demo data first.
- **Interactive product tour:** highlight key dashboard sections with tooltip overlays. Show: how to view leads, how to reply from inbox, how to check scores. Keep it under 2 minutes.
- **First lead magic:** prompt the agent to add their first client (phone number or forward a contact card). HomeNex sends a demo greeting message so the agent sees the AI in action. This "aha moment" must happen within the first 5 minutes.

### Day 2-7: Habit Formation

- **Daily WhatsApp nudges:** "You have 3 new leads today — open your dashboard to respond" or "Your lead Priya hasn't been contacted in 2 days — tap to send a follow-up." Drive daily dashboard visits via WhatsApp notifications.
- **Feature discovery:** introduce one new feature per day via WhatsApp: Day 2 = EMI calculator ("Try asking your bot about EMI!"), Day 3 = property comparison cards, Day 4 = festive greetings, Day 5 = status posting. Drip education, not feature overload.
- **Quick wins:** surface easy wins: "You have 5 uncontacted leads from 99acres. HomeNex can send a greeting to all of them in one tap."

### Day 8-30: Deepening

- **WABA setup guide:** step-by-step guide (with screenshots) for connecting a WhatsApp Business API number. Offer a "we'll set it up for you" white-glove onboarding call for agents who need hand-holding. This is the biggest friction point — make it frictionless.
- **Advanced features unlock:** gradually introduce builder payment tracker, drip sequences, and content generation as the agent's usage matures. Gate advanced features behind usage milestones: "You've managed 20+ leads — unlock Drip Sequences!"
- **Peer learning:** connect new agents with power users in their city. In-app community or WhatsApp group for HomeNex agents to share tips, ask questions, and network.

### Ongoing Education

- **In-context help:** contextual tooltips and help links throughout the dashboard. When an agent opens a feature for the first time, show a 15-second explainer.
- **Weekly tips via WhatsApp:** "Pro tip: agents who follow up within 5 minutes convert 3x more leads. Your average response time this week: 2.3 hours. Try enabling instant notifications to improve."
- **Video tutorials:** 2-3 minute screencasts for each major feature. Hosted on YouTube (free) and linked from the dashboard help center.

---

## Monetization Strategy

### Revenue Streams (Ordered by Expected Contribution)

| Stream | Price Point | Target | Margin |
|---|---|---|---|
| **SaaS Subscriptions (Pro/Business)** | ₹499-₹1,499/month | Individual agents, teams | 85%+ |
| **Managed Ads Commission** | 15-20% of ad spend | Agents spending ₹10K-₹1L/month on ads | 30-40% |
| **Builder Portal Fees** | ₹5K-₹50K/month per project | Builders with active CP programs | 90%+ |
| **Rental Agreement Charges** | ₹199-₹499 per agreement | Rental agents | 80%+ |
| **Cost Sheet Generation** | ₹99 per branded PDF | All agents | 90%+ |
| **Lead Marketplace Cut** | 10-15% of lead price | Agents with surplus/unserviceable leads | 70%+ |
| **WhatsApp API Markup** | ₹0.10-₹0.20 per template message | All agents (pass-through) | 15-20% |
| **Document Intelligence** | ₹199 per document analysis | Agents processing legal documents | 60%+ |
| **Premium AI Features** | Bundled in Pro/Business tier | Agents needing voice/vision AI | 50-60% |

### Pricing Philosophy

- **Free tier must be genuinely useful:** WhatsApp AI replies, BLTC extraction, lead scoring, basic follow-ups, EMI calculator, up to 50 leads. The free tier is the growth engine — it must solve a real pain point, not be a crippled demo.
- **Pro upgrade should feel like a steal:** at ₹499/month (~₹17/day), Pro should pay for itself with the first deal it helps close. Include: unlimited leads, voice transcription, drip sequences, content generation, portal lead ingestion, analytics.
- **Business tier for teams:** at ₹1,499/month, include: multi-agent team management, builder portal access, managed ads, white-label options, API access, priority support.
- **Per-seat vs. flat rate:** competitors are split. TeleCRM charges ₹799/user/month. Kylas offers unlimited users at ₹12,999/month flat. HomeNex should start per-seat (individual agents) and offer flat-rate team pricing at 5+ agents to win brokerage firms.

### Home Loan Referral Revenue

A significant untapped revenue stream — agents already refer buyers to banks/NBFCs for home loans. Formalizing this creates a new income line for both the agent and HomeNex.

- **How it works:** when a lead's BLTC profile shows loan intent (or they explicitly ask about financing), HomeNex surfaces pre-qualified loan offers from partner banks/NBFCs (HDFC, SBI, ICICI, Bajaj, etc.). The agent shares the offer with the buyer via WhatsApp. If the buyer applies and the loan is disbursed, the agent earns a referral fee (typically 0.1-0.3% of loan value) and HomeNex takes a platform cut.
- **Why it works:** agents already do this informally with their banker contacts. Formalizing it via HomeNex gives them better rates, faster processing, and tracked commissions. Banks get qualified, property-specific leads (much higher conversion than random loan inquiries).
- **Revenue potential:** average home loan ₹60L × 0.2% referral fee = ₹12K per loan. At 100 loans/month across the platform = ₹12L/month. HomeNex takes 20% = ₹2.4L/month.
- **Integration:** partner with loan aggregators (BankBazaar, PaisaBazaar) or directly with bank DSA (Direct Selling Agent) programs.

### Unit Economics Target

- **CAC (Customer Acquisition Cost):** target ₹500-₹1,500 per agent. Primary channels: WhatsApp referral (viral), broker group word-of-mouth, targeted Facebook/Instagram ads in real estate agent communities, partnerships with builder CP desks.
- **LTV (Lifetime Value):** target ₹15,000-₹30,000 (12-24 months retention at ₹499-₹1,499/month + transaction revenue).
- **LTV:CAC ratio:** target 10:1 or higher. This is achievable because the product is WhatsApp-native (where agents already live) and commission tracking creates high switching costs.

---

## Technical Notes

### Data Models Required (New Tables)

- `properties` — agent's property inventory (project, tower, floor, config, area, price, facing, possession, RERA, builder_id)
- `builders` — builder profiles (name, contact, projects, CP commission structure)
- `deals` — closed deals linking lead + property + builder + commission terms
- `commission_payments` — installment-level commission tracking per deal
- `tasks` — auto-generated agent tasks with due dates and status
- `templates` — festive greeting and follow-up message templates
- `visit_certificates` — site visit proofs with GPS, timestamp, photo hash
- `market_data` — aggregated pricing and demand signals by locality
- `training_content` — coaching module library
- `drip_sequences` — multi-step nurturing sequence definitions (trigger, steps, timing, exit conditions)
- `drip_enrollments` — which leads are enrolled in which sequences, current step, status
- `portal_leads` — ingested leads from 99acres/MagicBricks/Housing.com with source attribution
- `cost_sheets` — generated cost sheets linked to property + client + deal
- `demand_letters` — payment milestone demand letters linked to deals
- `payments` — UPI/payment gateway transactions with reconciliation status
- `booking_holds` — unit-level hold/lock records with expiry timestamps
- `waitlists` — client waitlist entries per property unit
- `referrals` — referral codes, referred leads, reward status
- `consent_records` — DPDPA consent audit trail (purpose, timestamp, withdrawal)
- `compliance_docs` — RERA certificates, GST registrations, agent compliance status
- `flow_responses` — WhatsApp Flow submission data linked to leads
- `call_logs` — telephony call records (duration, recording URL, disposition, linked lead)
- `content_views` — tracked document/link opens by leads
- `badges` — agent achievement/badge records
- `catalog_items` — WhatsApp Business Catalog sync records
- `vector_embeddings` — RAG document chunks and embeddings for property knowledge base

### API Integrations Required

- WhatsApp Business API (existing) — extend for: status posting, template messages, catalog sync, voice note download, Flows (Flow JSON v7.0), carousel templates, multi-product messages, location request messages, Business Calling API, payment messages
- Facebook Marketing API — for managed Click-to-WhatsApp ads with CTWA attribution (ReferralCtwaClid) and Conversions API (CAPI) integration
- OpenRouter (existing) — extend with vision model routing for premium tier
- Razorpay — for premium tier billing, rental agreement payments, WhatsApp UPI payment collection, and lead marketplace escrow
- NSDL eSign API — for Aadhaar-based eSign on rental agreements
- SendGrid (key exists) — for email drip campaigns
- Google Maps Geocoding API — for site visit GPS verification and beat planning route optimization
- Cloud telephony (Exotel / Knowlarity / MyOperator) — IVR, click-to-call, call recording, call routing
- Property portals (99acres API, MagicBricks API, Housing.com) — lead ingestion via API/webhook and email parsing (Gmail API / IMAP)
- State RERA portals (MahaRERA, K-RERA, UP-RERA, TNRERA) — project registration data, compliance status scraping
- UPI/NPCI — WhatsApp Pay integration for in-chat payments
- Vector database (Pinecone / Qdrant / pgvector) — for RAG-powered property knowledge base embeddings
- Voice AI (Whisper API + Indian language TTS) — for call transcription and voice agent capabilities
- Meta Business Agent Platform — evaluate for commodity AI agent tasks (FAQ, scheduling)

### Infrastructure Considerations

- **Database:** SQLite is fine for single-server deployment up to ~50 agents. Beyond that, migrate to PostgreSQL (with pgvector extension for RAG embeddings) or CockroachDB for multi-region deployment.
- **Job queue:** voice/image processing, drip sequence dispatch, bulk WhatsApp sends, content view tracking, and daily summary generation all need an async job queue (BullMQ or similar) — don't process in the webhook handler.
- **File storage:** photos, documents, floor plans, call recordings, and generated PDFs need S3-compatible object storage (Hetzner Object Storage is cheap and the VPS is already on Hetzner). Separate buckets: `uploads` (raw user files, auto-expire after processing), `documents` (encrypted KYC docs, access-controlled), `generated` (cost sheets, certificates, property cards).
- **Rate limiting:** WhatsApp sends are rate-limited by Meta — 1K messages/day for unverified, 10K/day for verified business numbers, scaling to 100K/day with good quality rating. Implement per-agent rate limiting and queuing with priority (hot lead notifications > drip messages > festive greetings).
- **Caching:** Redis for session management, WhatsApp Flow state, EMI calculation cache, stamp duty rate lookups, and real-time inventory matrix updates.
- **CDN:** property images, brochures, and generated cards served via a CDN (Cloudflare free tier or Hetzner CDN) for fast WhatsApp media delivery.
- **Encryption:** all KYC documents encrypted at rest (AES-256). PAN/Aadhaar data stored as extracted text fields only — raw images auto-deleted after extraction per DPDPA requirements.
- **Multi-tenancy:** current single-database design with agent_id filtering works up to ~500 agents. Beyond that, consider schema-per-tenant or database-per-tenant for large brokerage firms.
- **Monitoring:** application metrics (response time, AI latency, WhatsApp delivery rates), business metrics (lead flow, conversion funnel, revenue), and compliance metrics (consent rates, data deletion compliance). Integrate with Grafana or Datadog.

### Security Considerations

- **Authentication:** JWT-based auth with refresh tokens. Consider adding 2FA (OTP via WhatsApp) for admin access and high-value actions (commission data export, bulk lead export).
- **Authorization:** role-based access control (RBAC) — agent (own data only), team lead (team data), admin (platform-wide), builder (own projects + CP performance). API key management for third-party integrations.
- **Data isolation:** strict agent-level data isolation. An agent must never see another agent's leads, conversations, or commission data unless explicitly shared via co-broking or lead marketplace.
- **Audit logging:** log all data access, exports, and modifications for DPDPA compliance. Tamper-proof audit trail.
- **WhatsApp security:** validate webhook signatures (X-Hub-Signature-256) on every incoming request. Store WhatsApp Business API tokens encrypted. Rotate tokens periodically.
