# HomeNex — Feature Research & Proposals

> New feature proposals for HomeNex, the WhatsApp-native CRM for Indian real estate agents.
> Focused on: Hindi/Hinglish AI, Indian RE agent pain points, WhatsApp-specific features, lead nurturing automation, competitive gaps, and AI-powered capabilities.
>
> Date: July 10, 2026

---

## Executive Summary

HomeNex already has a strong foundation — WhatsApp webhook pipeline, AI auto-replies with BLTC extraction, lead scoring with recency decay, prioritized worklist, festive greeting scheduler, property micro-pages, and co-broking network. This document proposes **28 new features** across six focus areas, each prioritized as P0 (ship within 4 weeks), P1 (ship within 8 weeks), or P2 (ship within 16 weeks), with effort estimates and a clear explanation of how each feature helps agents close more deals.

The target user is an individual Indian real estate agent or small brokerage (2–10 agents) in tier 1/2 cities — budget-conscious, heavy WhatsApp users, managing 50–200 active leads on any given day.

**Key themes from research:**

- The pricing floor has dropped — new entrants like Realatic (free plan, Pro at ₹499/user/month) and Zakeli (₹499/month flat) have reset expectations. HomeNex's free tier must be genuinely useful.
- AI features are now table stakes, not differentiators. Sell.Do has "Ask Jarvis" sentiment analysis, Brixi.AI has AI agents handling calls/chats, PropFlo has an AI sales assistant. HomeNex's AI must be at parity or better.
- Hindi/vernacular support is essential for Tier-2/3 expansion, where 80%+ of buyer conversations happen in Hinglish or regional languages.
- WhatsApp platform changes (BSUIDs, Portfolio Pacing, Marketing Messages API, Meta AI chatbot policy) require architectural updates before any feature work.
- RERA 2.0 (March 2026) introduced QR codes, three-bank escrow, and agent certification requirements — compliance tools are a sales differentiator.

---

## Table of Contents

1. [Hindi & Hinglish AI Support](#1-hindi--hinglish-ai-support)
2. [Indian Real Estate Agent Pain Points](#2-indian-real-estate-agent-pain-points)
3. [WhatsApp-Specific Features](#3-whatsapp-specific-features)
4. [Lead Nurturing Automation](#4-lead-nurturing-automation)
5. [Competitive Analysis & Gap Closure](#5-competitive-analysis--gap-closure)
6. [AI-Powered Features](#6-ai-powered-features)
7. [Priority Summary Matrix](#7-priority-summary-matrix)
8. [Sources](#8-sources)

---

## 1. Hindi & Hinglish AI Support

### Context

Over 80% of WhatsApp conversations with Indian real estate buyers happen in Hinglish (mixed Hindi-English). Messages like "bhai 2bhk chahiye baner me, budget 80-90 ke beech, jaldi chahiye possession" are the norm, not the exception. HomeNex currently stores a language preference per agent (11 languages supported in settings) but the AI reply generation and BLTC extraction prompts are not yet wired to produce language-matched output. The extraction layer handles basic Hinglish input, but there is no auto-detection, no language-specific reply generation, and no vernacular UI.

Research shows that properties using multilingual chatbots saw a 42% increase in out-of-station site visit bookings in Central Indian deployments. VBHC Homes (July 2026) found that auto-detecting language mismatch and rerouting Kannada/Hindi leads boosted connect rates from 19% to 34%.

### Feature 1.1 — Auto-Detect Language & Reply in Kind

**Priority: P0** | **Effort: 3 days** | **Model tier: Free**

**What:** When a lead writes in Hindi, Hinglish, Marathi, or any supported language, HomeNex auto-detects the language and replies in the same language — no configuration needed, no per-region bots, no translation toolchains.

**How it works:**

- Add a `detected_language` field to the lead extraction JSON. The LLM already sees the input text — adding language detection to the extraction prompt is a zero-cost addition (same API call, one more field in the JSON output).
- Store `detected_language` on the lead record. Use it for all subsequent AI-generated replies, follow-ups, drip messages, and festive greetings for that lead.
- If the lead switches languages mid-conversation (common — they might start in Hindi and switch to English), update the stored preference to the most recent language.
- The system prompt for reply generation gets a simple addition: "Reply in {{detected_language}}. Match the buyer's communication style — if they use Hinglish, reply in Hinglish. If formal Hindi, reply in formal Hindi."

**How it helps close deals:** Buyers trust agents who speak their language. A Hindi-speaking buyer from Indore getting an English auto-reply feels like they're talking to a corporate bot. A Hinglish reply feels like talking to a local broker who gets them. Trust converts to site visits, site visits convert to deals.

### Feature 1.2 — Hinglish/Vernacular Real Estate Glossary

**Priority: P0** | **Effort: 2 days** | **Model tier: Free**

**What:** A curated glossary of Indian real estate slang injected into extraction and reply prompts so the LLM handles domain-specific shorthand accurately.

**Glossary examples:**

| Slang | Meaning |
|-------|---------|
| reddy / redy | Ready possession |
| poss | Possession |
| regi | Registration |
| agri | Agricultural land |
| NA | Non-Agricultural (converted land) |
| CP | Channel Partner (broker) |
| OC | Occupancy Certificate |
| CC | Completion Certificate |
| undcon | Under construction |
| vastu ok | Vastu-compliant facing |
| east face | East-facing flat (premium in Indian RE) |
| loan pass | Home loan pre-approved |
| 1cr / 1C | ₹1 crore (₹10 million) |
| 80L | ₹80 lakhs |
| carpet | Carpet area (usable area) |
| super | Super built-up area |
| flr rise | Floor rise premium |
| PLC | Preferential Location Charge |
| token | Booking token amount |

**How it works:** Embed the glossary as few-shot examples in the extraction prompt. When the LLM sees "2bhk baner 85L reddy poss east face vastu ok," it correctly extracts: config=2BHK, locality=Baner, budget=₹85L, timeline=Ready Possession, facing=East, vastu_compliant=true.

**How it helps close deals:** Accurate extraction means accurate lead scoring, which means the agent's worklist surfaces the right leads at the right time. A lead scored 40 because the AI missed "loan pass" (pre-approved = high intent) should have been scored 75+.

### Feature 1.3 — Hindi/Regional Language UI Toggle

**Priority: P2** | **Effort: 5 days** | **Model tier: N/A**

**What:** Translate the HomeNex dashboard into Hindi and 2–3 other regional languages (Marathi, Tamil, Telugu) for agents who are more comfortable in their native language.

**How it works:**

- Extract all UI strings into an i18n JSON file (React-intl or i18next).
- Use the LLM to generate initial translations, then have native speakers review the top 50 most-used strings.
- Language selector in Settings. The dashboard language is independent of the AI reply language (an agent who prefers Hindi UI might serve English-speaking buyers).

**How it helps close deals:** Tier-2/3 agents who struggle with English interfaces abandon CRMs within a week. A Hindi dashboard removes the adoption barrier entirely. If they can use it, they'll track leads instead of losing them.

### Feature 1.4 — Voice Note Transcription with Indian Language Support

**Priority: P1** | **Effort: 4 days** | **Model tier: Premium (Whisper)**

**What:** Auto-transcribe WhatsApp voice notes in Hindi, Marathi, Tamil, Telugu, Kannada, and Hinglish, then feed the transcription through the standard BLTC extraction pipeline.

**Why it's critical:** Indian buyers — especially the older demographic (40+) and Tier-2/3 users — send voice notes far more than text. Without transcription, HomeNex AI is blind to an estimated 30–40% of buyer communication. The AI can't score what it can't read.

**How it works:**

- WhatsApp webhook delivers voice messages as audio file URLs. Download the audio via the Graph API.
- Transcribe with Whisper-large-v3 (or Groq's free Whisper endpoint for cost optimization). Whisper handles Hindi, Marathi, Tamil, and code-mixed Hinglish well.
- Feed the transcription into the existing `extractLead()` pipeline in `ai.js`. The lead gets scored and the AI replies as if the buyer had typed the message.
- Cost: ~₹2.5 per 5-minute voice note on Whisper API. At 10 voice notes/day per agent = ₹750/month — fits within a Pro tier at ₹499+/month.

**How it helps close deals:** A 55-year-old buyer in Nagpur sends a 2-minute voice note in Hindi describing exactly what they want. Without transcription, the AI sends a generic "What are you looking for?" response. With transcription, it immediately responds with matching properties in their budget, in Hindi. That's a site visit booked in under 60 seconds.

---

## 2. Indian Real Estate Agent Pain Points

### Context

Over 55% of Indian real estate agents still manage leads manually in Excel sheets, leading to missed follow-ups and lost deals. The critical responsiveness gap is real — when a lead is not engaged within the first few minutes, conversion probability drops significantly. Indian agents juggle 5–10 active builder projects, track commissions in WhatsApp notes, and lose lakhs to disputes over "who brought the client first."

The pain points below are specific to Indian RE agents and are not well-served by generic CRMs.

### Feature 2.1 — Site Visit Scheduling with Location Sharing

**Priority: P0** | **Effort: 4 days** | **Model tier: Free**

**What:** End-to-end site visit workflow: AI detects visit intent in conversation → suggests available slots → confirms with buyer → sends WhatsApp location pin + calendar reminder → GPS check-in at site → post-visit feedback request.

**How it works:**

- **Intent detection:** When the AI detects site visit intent ("can I see the flat?", "site visit kab ho sakta hai?", "weekend pe dikhao"), it triggers the visit scheduling flow.
- **Slot management:** Agent pre-configures available slots per project in the dashboard (e.g., "Kolte Patil 24K — Sat/Sun 10 AM, 11 AM, 2 PM, 4 PM"). The AI offers available slots to the buyer.
- **Confirmation flow:** Buyer picks a slot → HomeNex sends a confirmation with: project name, address, Google Maps pin (via WhatsApp location message), date/time, agent name and phone, and a "Add to Calendar" link.
- **Reminders:** T-24h and T-2h reminders via WhatsApp to both buyer and agent. Include the location pin again (buyers lose it in chat history).
- **Post-visit:** 2 hours after the scheduled time, send a feedback request: "How was your visit to Kolte Patil 24K? Would you like to see more options or discuss pricing?"

**How it helps close deals:** Site visits are the single highest-converting action in Indian RE — a lead who visits converts at 15–25x the rate of one who doesn't. Every friction point removed from the visit booking flow directly increases conversion. Location pins eliminate "where is the site?" calls that cause 20%+ of visit no-shows.

### Feature 2.2 — Builder Commission Tracker

**Priority: P0** | **Effort: 8 days** | **Model tier: Free**

**What:** Track CP (Channel Partner) commission receivables across all builders — who owes how much, which installments are overdue, and auto-generate polite follow-up messages.

**Why agents need this:** An agent closing 3–5 deals/month across multiple builders is simultaneously tracking ₹5–15 lakh in commission receivables. They use Excel or WhatsApp notes. Builders "forget." Installments slip. Agents lose real money because they can't track what's owed.

**How it works:**

- New data models: `builders` (name, contact, projects), `deals` (client, builder, project, flat, deal_value, commission_pct, commission_amount), `commission_payments` (deal_id, installment_number, amount_due, amount_paid, due_date, paid_date, status).
- Dashboard: "My Commissions" section grouped by builder — total owed, total received, overdue amounts. Drill into each builder for individual deals and installment status.
- Alerts: "Builder X owes you ₹2.4L, 60 days overdue" pushed via WhatsApp to the agent.
- Auto-generate a polite follow-up message the agent can forward to the builder's accounts team.

**How it helps close deals:** This doesn't directly close deals but it prevents agent churn from HomeNex. Once commission data is in the system, switching costs are high. It also frees agents from spreadsheet management, giving them more time for selling. And agents who track commissions effectively earn 15–20% more annually because they stop letting money slip through the cracks.

### Feature 2.3 — RERA 2.0 Compliance Tools

**Priority: P1** | **Effort: 5 days** | **Model tier: Free**

**What:** Ensure every property shared via HomeNex is RERA-compliant — with mandatory RERA number, QR code, and authority URL attached to listings, micro-pages, and WhatsApp status posts.

**What changed with RERA 2.0 (March 2026):**

- QR codes are now mandatory on all project advertisements — linking to real-time construction progress, financial status, and regulatory approvals.
- Three-bank escrow system for buyer payments.
- Agent certification requirements (MahaRERA Certificate of Competency, UP training completion by Dec 2026).
- Proactive enforcement — RERA can take suo moto action without buyer complaint.

**How it works:**

- Add `rera_number`, `rera_authority_url`, and `rera_qr_code_url` fields to the property/inventory model.
- **Compliance gate:** Before an agent posts a listing to WhatsApp status, shares a micro-page, or sends a property card, validate that RERA fields are populated. Show a warning for non-compliant properties: "This listing is missing a RERA number. Add it to share."
- **QR code auto-generation:** Generate a QR code linking to the state RERA portal page for that project. Embed it in property cards and micro-pages.
- **Agent certification tracker:** Track per-agent RERA certification status with expiry date and renewal reminders.

**How it helps close deals:** RERA compliance builds buyer trust — "This agent only shows RERA-registered properties" is a powerful differentiator. Non-compliance risks penalties up to ₹250 crore under RERA 2.0. Agents who use HomeNex are protected from accidental violations.

### Feature 2.4 — Payment Milestone Tracker for Buyers

**Priority: P1** | **Effort: 5 days** | **Model tier: Free**

**What:** After a deal is booked, track payment milestones (10% on booking, 20% on foundation, 20% on plinth, etc.) and send automated reminders to both agent and buyer.

**How it works:**

- New `payment_milestones` table: deal_id, milestone_name, percentage, amount, due_date, paid_date, status.
- Agent enters the payment schedule from the builder's demand letter (or auto-parse from a cost sheet generated by HomeNex).
- Automated WhatsApp reminders to the buyer: "Hi Priya, your next payment of ₹18.6L for Flat 302 (plinth completion milestone) is due on August 15. Here's the builder's bank details and payment instructions."
- Dashboard view: which buyers have pending payments, total collected vs. total due per deal.

**How it helps close deals:** Post-booking payment defaults cause 10–15% of deals to fall through. Timely reminders keep the deal alive. Agents who proactively manage payment schedules build trust with both buyers and builders, leading to more referrals.

### Feature 2.5 — Cost Sheet Generator

**Priority: P1** | **Effort: 7 days** | **Model tier: Free**

**What:** Auto-generate Indian real estate cost sheets with all standard components — base price, floor rise, PLC, parking, GST, stamp duty, registration, legal charges, maintenance deposit, sinking fund.

**Why agents need this:** After every site visit, the agent manually creates a cost sheet in Excel with 15+ line items. It takes 20–30 minutes per sheet, and arithmetic errors are common. A wrong cost sheet embarrasses the agent and erodes buyer trust.

**How it works:**

- Agent selects a property from inventory + selects the client → HomeNex auto-generates a formatted cost sheet.
- State-specific calculations: stamp duty (Maharashtra: 5% for men, 4% for women; Karnataka: 5%; etc.), registration fees (capped per state), GST (1% affordable / 5% non-affordable / 0% ready possession).
- Output: professional PDF with agent branding. Share directly via WhatsApp.
- LLM generates a plain-English summary at the bottom: "Total all-inclusive cost for this 2BHK on the 12th floor is ₹1.04Cr. Your EMI on a ₹75L loan at 8.5% for 20 years would be ₹65,100/month."

**How it helps close deals:** Speed kills in real estate — the agent who sends a cost sheet within 10 minutes of a site visit while the buyer is still excited wins. A 20-minute Excel exercise means the buyer has time to cool off or get a faster response from a competing agent.

### Feature 2.6 — Plot & Land Transaction Support

**Priority: P2** | **Effort: 4 days** | **Model tier: Free**

**What:** Add plot/land-specific fields and workflows for Tier-2/3 markets where plot sales represent 40–60% of transactions (vs. apartment-dominated Tier-1 cities).

**New fields:** survey number, NA (Non-Agricultural) status, road access type (tar/concrete/kachcha), water/electricity connectivity, proximity to upcoming infrastructure (highway/metro/SEZ), FSI/FAR allowance, boundary wall status.

**How it helps close deals:** Opens HomeNex to the Tier-2/3 market where plot/land transactions dominate. Without these fields, agents in cities like Indore, Lucknow, Nagpur, and Jaipur can't use HomeNex for half their inventory.

---

## 3. WhatsApp-Specific Features

### Context

WhatsApp has 500M+ users in India with 98%+ message open rates. It is the default communication channel for Indian property buyers. The WhatsApp Business API has evolved significantly in 2025–2026 with new capabilities that HomeNex should leverage.

### Feature 3.1 — WhatsApp Flows for Lead Qualification

**Priority: P0** | **Effort: 5 days** | **Model tier: Free**

**What:** Use WhatsApp Flows (native multi-screen forms inside WhatsApp) to qualify leads in 30 seconds instead of a 5-message back-and-forth.

**How it works:**

- When a new lead messages or clicks a CTWA ad, HomeNex sends a WhatsApp Flow with dropdowns, date pickers, and text inputs.
- The flow collects: property type (buy/rent/sell), BHK preference, preferred localities (multi-select), budget range (slider or preset ranges), possession timeline, home loan status.
- Flows now work on WhatsApp Web (since December 2025) and support UPI payment integration in India.
- Performance benchmark: 158% higher conversion rates and 2.6x revenue vs. traditional web forms.
- Flows are session messages — free within the 24-hour window (no template cost).

**How it helps close deals:** 3x faster qualification means 3x more leads qualified per day. Structured data eliminates parsing errors. Buyers prefer tapping over typing — especially on mobile. The faster you qualify, the faster you can match properties and book site visits.

### Feature 3.2 — WhatsApp Catalog Sync

**Priority: P1** | **Effort: 6 days** | **Model tier: Free**

**What:** Sync the agent's property inventory to WhatsApp Business Catalog so buyers can browse listings directly inside WhatsApp without leaving the app.

**How it works:**

- Sync agent's inventory → WhatsApp Business Catalog API. Each property becomes a catalog item with: photo, price, config, locality, carpet area, and a "Know More" CTA.
- Buyers tap the catalog icon in chat → browse properties → tap one → conversation continues about that specific property with context pre-loaded.
- Auto-update: when inventory changes in HomeNex (new listing, price update, sold), the catalog syncs automatically.

**How it helps close deals:** Reduces the friction of property discovery from "agent sends 5 separate property cards" to "buyer browses a visual catalog and self-selects." Buyers who self-select are 2x more likely to book a site visit because they've already filtered to what interests them.

### Feature 3.3 — WhatsApp Business Calling API Integration

**Priority: P1** | **Effort: 6 days** | **Model tier: Free**

**What:** Enable agents to make and receive VoIP calls directly inside WhatsApp with full chat history visible. GA since July 2025, with per-minute pricing and tiered volume discounts.

**Why this beats third-party telephony (Exotel/Knowlarity):**

- Same thread as chat — agent sees the full conversation history when calling.
- No separate telephony bill — integrated into WhatsApp Business API pricing.
- Upcoming: video calls for virtual property tours, screen sharing for cost sheet walkthrough.

**How it helps close deals:** Hot leads need immediate callback. When a lead messages "I want to see this flat today," the agent taps "Call" and speaks to them within 30 seconds — with full context of what they've discussed before. That immediacy converts. Sell.Do and LeadSquared both have telephony integration; without it, HomeNex loses serious users.

### Feature 3.4 — WhatsApp Payment Collection (UPI)

**Priority: P1** | **Effort: 6 days** | **Model tier: Free**

**What:** Collect booking tokens and small payments directly inside WhatsApp using UPI via Razorpay or PayU integration.

**How it works:**

- Agent sends a payment request from the dashboard: "Collect ₹1L booking token from Priya for Flat 302."
- Buyer receives a WhatsApp message with a "Pay" button → taps → UPI payment completes inside WhatsApp → HomeNex records the transaction against the deal.
- UPI transaction limit: ₹1L for P2M. For larger amounts, send a Razorpay payment link with tracking.
- UPI Lite enables sub-₹500 transactions without PIN entry — useful for document charges.
- UPI AutoPay for recurring mandates — HomeNex subscription billing.

**How it helps close deals:** The moment between "I want to book" and the actual token payment is when deals die. A buyer at a site visit says "I'll book it" → agent sends a WhatsApp payment link → buyer pays ₹50K token on the spot via UPI → deal locked. Without in-chat payments, the buyer goes home, thinks about it, and 40% of the time doesn't follow through.

### Feature 3.5 — BSUID Support (Architecture Update)

**Priority: P0** | **Effort: 3 days** | **Model tier: N/A**

**What:** Support WhatsApp Business Scoped User IDs (BSUIDs) — the new user identifier format that replaces phone numbers for users who hide their number via WhatsApp usernames (rolling out mid-2026).

**Why it's P0:** This is an architectural prerequisite. Without BSUID support, HomeNex will silently lose leads whose phone numbers are hidden. BSUIDs are already appearing in webhook payloads as of April 2026.

**How it works:**

- Add `bsuid` column to leads/contacts tables.
- Update webhook handler in `whatsapp.js` to capture BSUIDs from incoming messages.
- Support sending messages to BSUIDs (not just phone numbers).
- Update dedup logic: match on BSUID OR phone number.
- Update UI to show BSUID when phone is unavailable.

**How it helps close deals:** If HomeNex can't identify or message a lead, it can't help close the deal. This is pure infrastructure — it doesn't close deals directly, but without it, deals are lost silently.

### Feature 3.6 — Portfolio Pacing Compliance

**Priority: P0** | **Effort: 2 days** | **Model tier: N/A**

**What:** Implement paced sending for all bulk operations to comply with Meta's new Portfolio Pacing requirements. Meta now monitors engagement in real-time and pauses delivery if it detects blocks, spam reports, or negative feedback.

**How it works:**

- Replace bulk-send logic with paced batches (controlled batch sizes with engagement monitoring between batches).
- Auto-pause campaigns if block/spam rates spike above threshold.
- Surface delivery health metrics in the dashboard: delivery rate, read rate, block rate.
- Design drip sequences and festive greetings with pacing built in from Day 1.

**How it helps close deals:** If Meta throttles or suspends the agent's WhatsApp number due to aggressive bulk sending, the agent loses their primary communication channel. Pacing compliance protects the agent's WhatsApp quality rating — which protects every other feature that depends on WhatsApp.

---

## 4. Lead Nurturing Automation

### Context

Research shows it takes 5–7 touchpoints to convert a real estate lead. Most Indian agents send one follow-up and forget. Leads that don't respond to the first message are abandoned. With 50–200 active leads, manual follow-up at the required cadence is impossible.

### Feature 4.1 — Automated Drip Sequences

**Priority: P0** | **Effort: 8 days** | **Model tier: Free**

**What:** Multi-step, trigger-based nurturing sequences that run on autopilot — from first contact through deal close.

**How it works:**

- **Sequence builder:** Visual builder in the dashboard. Agent creates sequences like:
  - Day 0: Welcome message with property match
  - Day 2: EMI calculator for their budget
  - Day 5: Similar property comparison card
  - Day 10: Market trend update for their locality
  - Day 15: Site visit invitation
  - Day 30: Re-engagement with new listings
- **Triggers:** New lead, lead goes cold, post-site-visit, post-booking, festival season, price drop in preferred locality.
- **Smart exits:** Auto-pause if the lead replies (hand off to agent), books a site visit, or opts out.
- **Template compliance:** Use approved WhatsApp template messages for business-initiated messages outside the 24-hour window. Route marketing templates through the Marketing Messages API for ~9% higher deliverability.
- **Pacing compliance:** All drip sends respect Portfolio Pacing requirements (Feature 3.6).
- **Personalization:** LLM personalizes each drip message with conversation context and lead profile.

**How it helps close deals:** The agent who follows up 7 times wins the deal. The agent who follows up once loses it. Drip sequences ensure no lead falls through the cracks without adding any manual work. A 200-lead pipeline with automated drip converts 3–5x more than one with manual follow-up.

### Feature 4.2 — Festive & Occasion-Based Follow-Ups (Enhanced)

**Priority: P0** | **Effort: 3 days (incremental on existing festivals.js)** | **Model tier: Free**

**What:** Enhance the existing festive greeting scheduler with deal-context personalization, occasion-triggered offers, and lifecycle-aware messaging.

**What's already built:** `server/festivals.js` has a festival calendar and personalized bulk sends with send limiter compliance.

**What to add:**

- **Deal-context greetings:** Instead of generic "Happy Diwali!", send: "Happy Diwali, Priya! 🪔 That 2BHK in Baner we discussed — the builder just announced a Diwali discount of ₹2L off. Shall I send the updated cost sheet?"
- **Occasion triggers beyond festivals:**
  - Anniversary of their first inquiry: "It's been 6 months since you started your home search. Let's find the right one — here are 3 new listings that match your budget."
  - Birthday (if captured): "Happy Birthday, Ramesh! 🎂 A gift from [Builder] — waived parking charges for bookings this month."
  - New Year financial planning: "New year, new home? Here's how much you'd save with the current interest rate of 8.5%..."
- **Builder offer integration:** When a builder announces a festive offer (Diwali discount, New Year scheme), auto-generate personalized messages for all leads interested in that builder's project.
- **Template classification:** Classify festive messages as "utility" templates where possible (₹0.115 vs ₹0.863 for marketing). A "site visit reminder for Diwali open house" is utility, not marketing.

**How it helps close deals:** Festive seasons drive 25–30% of annual residential sales in India. Diwali alone accounts for 15%+ of yearly bookings. A well-timed, personalized festive message with a relevant offer converts cold leads into site visits. Generic "Happy Diwali" messages get ignored; context-rich ones get responses.

### Feature 4.3 — Price Drop & New Listing Alerts

**Priority: P1** | **Effort: 3 days** | **Model tier: Free**

**What:** When a property's price drops or a new listing matches a lead's preferences, auto-send a personalized alert via WhatsApp.

**How it works:**

- Monitor the agent's inventory for price changes. When a price drops on a property that matches any active lead's BLTC profile, trigger an alert.
- Alert message: "Great news, Ramesh! The 3BHK in Wakad you liked is now ₹8L less — down from ₹1.05Cr to ₹97L. At this price, your EMI would be ₹56,800/month. Want to revisit?"
- Similarly, when a new property is added that matches a lead's profile, send a "new listing alert."
- Frequency caps: max 2 property alerts per lead per week to avoid spam.

**How it helps close deals:** Price drops are the #1 re-engagement trigger for dormant leads. A lead who went cold at ₹1.05Cr might buy at ₹97L. Without automated alerts, the agent forgets to inform relevant leads, and the price drop is wasted.

### Feature 4.4 — Post-Sale Nurturing & Referral Engine

**Priority: P2** | **Effort: 5 days** | **Model tier: Free**

**What:** Structured post-sale touchpoints + referral tracking to turn closed deals into future leads.

**How it works:**

- **Post-possession drip:** Scheduled messages at 1 month, 3 months, 6 months, 1 year after possession: "How's the new home? Need help with interiors / society registration / property tax?"
- **Referral program:** After the 3-month check-in, send: "If any friends or family are looking for a home, I'd love to help — and there's a ₹10,000 referral bonus for you."
- **Referral tracking:** Unique referral link/code per client. When a referred lead converts, track the referral chain and notify the referrer.
- **Referral analytics:** Which clients refer the most, referral conversion rate.

**How it helps close deals:** Referred leads convert at 3–4x the rate of cold leads. Most agents don't have a structured referral process — they forget to ask, or ask once and never follow up. Automated post-sale nurturing keeps the agent top-of-mind for referrals for years.

---

## 5. Competitive Analysis & Gap Closure

### Competitive Landscape Summary

| Platform | Strengths | Weaknesses | Pricing |
|----------|-----------|------------|---------|
| **Sell.Do** | 30% market share, 15+ years, AI Call Analysis ("Ask Jarvis"), sentiment analysis, 8+ language transcription, full builder lifecycle | Expensive (₹20K–60K/month), complex UI, WhatsApp integration inconsistent on lower plans, built for large developers not individual agents | Quote-based, enterprise |
| **LeadSquared** | Deep marketing automation, portal integrations (99acres, MagicBricks), mobile app, autoresponders | Bugs in automation campaigns, poor reporting, 3–7 day support response, max 75 custom fields | ₹1,500+/user/month |
| **Brixi.AI** | AI-first, purpose-built for property sales, site visit tracking, live inventory, WhatsApp automation, buyer intent signals | New entrant (limited track record), unclear on multi-language AI | Not public |
| **Realatic** | Free plan, RERA compliance, WhatsApp built-in, lead-to-possession tracking | Small team, limited integrations | Free → ₹499/user → ₹1,199/user |
| **PropFlo** | G2 Top 3 ease-of-use, channel partner management, mobile CRM, AI sales assistant, commission tracking | Developer-focused (not broker-first), limited WhatsApp-native capabilities | Quote-based |
| **TeleCRM** | Affordable, WhatsApp + calling, simple UI | Bot reliability issues ("stops working on its own"), hidden WhatsApp API charges, missed messages | ₹600–1,200/user/month |
| **Kylas** | Affordable general CRM | Only 7 integrations, slows down with data, no RE-specific features | ₹600/user/month |
| **NoBroker Agent** | Large buyer database, brand recognition | Agent CRM is secondary to consumer marketplace, limited AI | Variable |

### Features Competitors Have That HomeNex Doesn't (Yet)

**Feature 5.1 — Property Portal Lead Ingestion**

**Priority: P0** | **Effort: 6 days** | **Model tier: Free**

**What:** Auto-capture leads from 99acres, MagicBricks, Housing.com, and NoBroker — the portals agents already pay for but track manually.

**The gap:** Sell.Do, LeadSquared, Realatic, and Erino all offer native integrations with major Indian property portals. Without it, agents lose 30–40% of portal leads because they never get a first response.

**How it works:**

- **Email parsing:** Connect the agent's email (registered on portals) via IMAP or Gmail API. Parse incoming lead notification emails from 99acres/MagicBricks/Housing.com using regex + LLM extraction.
- **Webhook/API:** Where portals offer webhooks or APIs (99acres partner API, MagicBricks lead push), integrate directly.
- **Auto-dedup:** Match incoming portal leads against existing leads by phone number. If a lead exists, merge as a new touchpoint.
- **Auto-engage:** Send immediate WhatsApp greeting: "Hi [name], you showed interest in [property] on [portal]. I'm [agent], your local expert. What's your preferred budget and timeline?"

**How it helps close deals:** Agents spend ₹5K–₹20K/month on portal listings. Without automatic ingestion, leads arrive via email, get buried, and never get a response. Auto-engagement within 60 seconds of a portal inquiry increases contact rates by 8x.

**Feature 5.2 — Mobile App (React Native / PWA)**

**Priority: P1** | **Effort: 10 days (PWA) / 20 days (native)** | **Model tier: N/A**

**What:** A mobile-first experience for agents who spend 90% of their working day on their phones, at construction sites, in client meetings, and driving between showings.

**The gap:** Sell.Do, LeadSquared, PropFlo, Brixi.AI, and TeleCRM all have mobile apps. Indian RE agents check their phone 50+ times/day. A web-only CRM requires opening a browser, navigating to a URL, and logging in — too much friction for quick lead checks.

**Recommended approach:** Progressive Web App (PWA) first — installable, works offline (with service worker caching), push notifications on Android. Upgrade to React Native if app store presence becomes a competitive requirement.

**How it helps close deals:** The agent at a site visit needs to check a lead's budget before a call. With a mobile app, it's a tap. Without one, it's "let me get back to you" — and by then the competitor has called.

**Feature 5.3 — Click-to-WhatsApp Ad Management

**Priority: P2** | **Effort: 12 days** | **Model tier: Free**

**What:** HomeNex runs Facebook/Instagram CTWA ads for the agent — leads land directly in the CRM with full attribution.

**The gap:** Agents spend ₹10K–₹1L/month on Facebook ads but don't know how to run them well. They boost posts randomly and leads go to personal WhatsApp (untracked). Sell.Do and LeadSquared offer campaign management.

**Key technical advantage:** Integrate CAPI-BM (Conversions API for Business Messaging) from Day 1. When a user clicks a CTWA ad, Meta includes a `ctwa_clid` in the webhook payload. Track ad → conversation → deal attribution end-to-end. CTWA delivers 92% lower cost-per-lead and up to 94% higher conversion rates vs. landing page campaigns.

**Revenue opportunity:** Charge 15–20% of ad spend as management fee, or a flat ₹999–₹2,999/month for a managed ads package.

**How it helps close deals:** Better-targeted ads with proper attribution mean more quality leads at lower cost. An agent spending ₹30K/month on poorly targeted Facebook boosts could get 3x the leads at the same spend through HomeNex-managed CTWA ads.

---

## 6. AI-Powered Features

### Context

AI features have become table stakes in Indian RE CRM. Sell.Do has "Ask Jarvis" with call analysis and sentiment scoring. Brixi.AI is AI-first with buyer intent signals. PropFlo has an AI sales assistant. HomeNex's current AI (OpenRouter free tier for BLTC extraction, conversational replies, and lead scoring) is solid but needs expansion.

### Feature 6.1 — Sentiment Detection with Urgency Alerts

**Priority: P0** | **Effort: 2 days** | **Model tier: Free**

**What:** Analyze conversation tone to detect frustrated, highly interested, and going-cold leads — then alert the agent with specific recommended actions.

**How it works:**

- Add `sentiment` (positive / neutral / frustrated / anxious) and `engagement_level` (high / medium / low / disengaged) fields to the extraction JSON in `ai.js`. This is a zero-cost addition — same API call, two more fields.
- **Alert triggers:**
  - Frustrated + high engagement ("actively searching but had bad experiences"): "⚡ This lead seems frustrated with their search. A personal call right now could close the deal."
  - Sentiment shift from positive to negative: "⚠️ Priya's tone has shifted — she seemed excited about Kolte Patil but her last message sounds hesitant. Ask about her concerns."
  - Going cold (one-word replies, long gaps): "📉 Ramesh hasn't responded in 5 days. Send him the new listings in Baner."
- Feed sentiment into the existing lead scoring — frustrated + high engagement should boost the score, not lower it.

**How it helps close deals:** The existing temperature classification (Hot/Warm/Cold) is based on BLTC completeness, not emotional signals. A lead who has shared full BLTC data but sounds frustrated might be scored Hot when they actually need empathy and a phone call, not another property card. Sentiment detection ensures the right response at the right time.

### Feature 6.2 — AI Property Matching from Conversation

**Priority: P0** | **Effort: 4 days** | **Model tier: Free**

**What:** Automatically match leads to properties from the agent's inventory based on the full conversation context — not just explicit filters, but implicit preferences detected from conversation nuance.

**How it works:**

- After each BLTC extraction, query the agent's property inventory for matches using extracted fields (budget range ±10%, matching config, matching localities).
- Go beyond exact filters with semantic understanding: a buyer asking for "something near Symbiosis school with a garden" should match properties in Viman Nagar / Kharadi with garden amenities — even if they didn't say "Viman Nagar."
- Present matches to the agent in the dashboard sidebar: "3 properties match Priya's requirements" with a one-tap send button.
- Auto-suggest in AI replies: when the AI responds to the buyer, include a property recommendation: "Based on what you're looking for, I'd suggest checking out [Property Name] — 2BHK, 985 sqft, ₹88L, ready possession in Baner."

**How it helps close deals:** Filter-based matching misses 30–40% of valid matches because buyers don't always use the right keywords. An agent who manually scrolls through 50 properties to find matches spends 15 minutes per lead. AI matching does it instantly, and catches matches the agent would miss.

### Feature 6.3 — Auto-Negotiation Suggestions

**Priority: P1** | **Effort: 3 days** | **Model tier: Free**

**What:** When a buyer pushes back on price, suggest negotiation strategies based on market context and the buyer's apparent budget flexibility.

**How it works:**

- Detect price objection intent in the conversation ("too expensive," "budget tight," "kuch kam ho sakta hai?").
- Generate a sidebar suggestion with 2–3 strategies:
  - Hold firm with justification: "Baner 2BHKs average ₹92L. This property at ₹88L is already below market."
  - Offer alternatives: "Show them options in Mahalunge (10 min from Baner, avg ₹78L) as a value alternative."
  - Create urgency: "Mention the upcoming price increase that the builder announced for next quarter."
  - Suggest smaller config: "A 1.5BHK in the same project fits their ₹75L budget perfectly."

**How it helps close deals:** Many agents are poor negotiators — they either drop price too fast (losing commission) or hold firm and lose the deal. AI suggestions help agents navigate the negotiation with data-backed confidence, resulting in more deals closed at better prices.

### Feature 6.4 — Conversation Summarization for Agent Handoffs

**Priority: P1** | **Effort: 2 days** | **Model tier: Free**

**What:** When an agent takes over from the AI (or hands off to a colleague), generate a crisp 3–5 sentence handoff summary.

**How it works:**

- Extend the extraction prompt to generate a `handoff_summary`: "Priya (F, ~30s) is looking for a 2BHK in Baner or Balewadi, budget ₹80–95L, ready possession. Pre-approved for ₹70L from HDFC. Compared 3 projects, didn't like small carpet areas. Interested in Kolte Patil 24K Sereno (985 sqft, ₹88L). Next step: confirm site visit for Saturday 11 AM."
- Show the handoff summary as a card at the top of the Inbox view when the agent opens a conversation.
- Auto-update after each message exchange — the summary is always current.

**How it helps close deals:** Agents hate reading through 30 messages to understand context. A handoff summary means the agent can call the buyer immediately with full context, sounding knowledgeable and prepared. This professionalism builds trust — and trust converts.

### Feature 6.5 — Churn Prediction — Which Leads Are Going Cold

**Priority: P1** | **Effort: 3 days** | **Model tier: Free**

**What:** Predict which active leads are about to go cold based on engagement patterns and alert the agent before it's too late.

**How it works:**

- Track per-lead engagement metrics: average response time trend, message length trend, days since last message, sentiment trend.
- When churn probability exceeds threshold, alert the agent: "⚠️ Priya hasn't responded in 5 days. Her last 3 messages were shorter than usual. She may be going cold. Suggested action: send her the new Baner listings from this week."
- Feed churn risk into the worklist algorithm — at-risk leads get bumped up in priority before they go fully cold.

**How it helps close deals:** A lead that's going cold today can still be saved with the right intervention — a phone call, a relevant new listing, a price drop alert. A lead that went cold 3 weeks ago is 10x harder to revive. Early warning saves deals.

### Feature 6.6 — Smart Inventory Import (Builder Price List Parsing)

**Priority: P2** | **Effort: 5 days** | **Model tier: Premium (vision for PDFs)**

**What:** Agents receive builder price lists as Excel files or PDFs. Auto-parse them into structured inventory data — instead of manual entry of 50+ units.

**How it works:**

- Agent uploads a builder price list (Excel/PDF) → LLM extracts: tower names, floor numbers, unit numbers, configs, carpet areas, prices, facing, parking, and availability status.
- For Excel: parse with SheetJS, use LLM to identify column mappings (builders use inconsistent formats).
- For PDF: OCR + vision model to extract tabular data from formatted price lists.
- Agent reviews the parsed data, corrects any errors, and confirms import.

**How it helps close deals:** An agent onboarding a new builder's project manually enters 50–100 units into the CRM. This takes hours and is error-prone. Auto-import takes minutes and is accurate, meaning the agent's inventory is complete and up-to-date — which means AI property matching (Feature 6.2) works better.

### Feature 6.7 — Best Time to Contact Prediction

**Priority: P2** | **Effort: 2 days** | **Model tier: Free**

**What:** Analyze each lead's messaging patterns to predict when they're most likely to read and respond.

**How it works:**

- Track when each lead typically messages (morning commute? lunch break? late evening?). Build a per-lead contact preference.
- Show in the lead detail view: "Ramesh is most responsive between 9–10 PM on weekdays. Avoid calling before 11 AM."
- Integrate with drip sequence timing — send drip messages at each lead's optimal time, not a blanket schedule.

**How it helps close deals:** A message sent at the right time gets a 3x higher response rate. An agent calling at 9 AM when the buyer only responds at 9 PM is wasting effort and annoying the buyer.

---

## 7. Priority Summary Matrix

### P0 — Ship Within 4 Weeks (Foundation + Quick Wins)

These are non-negotiable. They either protect existing functionality (BSUID, pacing), close critical competitive gaps (portal ingestion, drip sequences), or unlock the vernacular market (Hindi auto-detect).

| # | Feature | Area | Effort | Deal Impact |
|---|---------|------|--------|-------------|
| 1.1 | Auto-Detect Language & Reply in Kind | Hindi/Hinglish | 3 days | High — unlocks Tier-2/3 buyers |
| 1.2 | RE Slang Glossary for Extraction | Hindi/Hinglish | 2 days | Medium — improves scoring accuracy |
| 2.1 | Site Visit Scheduling + Location | Pain Points | 4 days | Very High — site visits are #1 conversion driver |
| 2.2 | Builder Commission Tracker | Pain Points | 8 days | High — agent retention + time savings |
| 3.1 | WhatsApp Flows for Qualification | WhatsApp | 5 days | Very High — 3x faster qualification |
| 3.5 | BSUID Support | WhatsApp | 3 days | Critical — prevents silent lead loss |
| 3.6 | Portfolio Pacing Compliance | WhatsApp | 2 days | Critical — protects WhatsApp quality rating |
| 4.1 | Automated Drip Sequences | Nurturing | 8 days | Very High — 3–5x pipeline conversion |
| 4.2 | Festive Follow-Ups (Enhanced) | Nurturing | 3 days | High — captures festive buying season |
| 5.1 | Portal Lead Ingestion | Competitive | 6 days | Very High — rescues 30–40% lost leads |
| 6.1 | Sentiment Detection + Alerts | AI | 2 days | High — right response at right time |
| 6.2 | AI Property Matching | AI | 4 days | Very High — instant property recommendations |

**Total P0 effort: ~50 developer-days (2 developers × 4 weeks)**

### P1 — Ship Within 8 Weeks (Differentiation)

Features that separate HomeNex from competitors and justify a paid tier.

| # | Feature | Area | Effort | Deal Impact |
|---|---------|------|--------|-------------|
| 1.4 | Voice Note Transcription | Hindi/Hinglish | 4 days | High — unlocks 30–40% of communication |
| 2.3 | RERA 2.0 Compliance Tools | Pain Points | 5 days | Medium — trust + legal protection |
| 2.4 | Payment Milestone Tracker | Pain Points | 5 days | Medium — prevents post-booking defaults |
| 2.5 | Cost Sheet Generator | Pain Points | 7 days | High — speed wins in RE |
| 3.2 | WhatsApp Catalog Sync | WhatsApp | 6 days | Medium — self-serve property discovery |
| 3.3 | WhatsApp Calling API | WhatsApp | 6 days | High — instant hot lead callback |
| 3.4 | UPI Payment Collection | WhatsApp | 6 days | Very High — captures "I'll book" moments |
| 4.3 | Price Drop / New Listing Alerts | Nurturing | 3 days | High — re-engages dormant leads |
| 5.2 | Mobile App (PWA) | Competitive | 10 days | High — daily active usage |
| 6.3 | Auto-Negotiation Suggestions | AI | 3 days | Medium — better deal outcomes |
| 6.4 | Conversation Summarization | AI | 2 days | Medium — faster agent handoffs |
| 6.5 | Churn Prediction | AI | 3 days | High — early intervention saves deals |

**Total P1 effort: ~60 developer-days (2 developers × 5 weeks, overlapping with P0)**

### P2 — Ship Within 16 Weeks (Scale & Expansion)

Features for scale, Tier-2/3 expansion, and revenue generation.

| # | Feature | Area | Effort | Deal Impact |
|---|---------|------|--------|-------------|
| 1.3 | Hindi/Regional UI Translation | Hindi/Hinglish | 5 days | Medium — Tier-2/3 adoption |
| 2.6 | Plot & Land Transaction Support | Pain Points | 4 days | Medium — opens Tier-2/3 TAM |
| 4.4 | Post-Sale Nurturing + Referrals | Nurturing | 5 days | High — 3–4x referred lead conversion |
| 5.3 | CTWA Ad Management | Competitive | 12 days | Medium — revenue opportunity |
| 6.6 | Smart Inventory Import | AI | 5 days | Medium — faster onboarding |
| 6.7 | Best Time to Contact | AI | 2 days | Medium — 3x response rates |

**Total P2 effort: ~33 developer-days**

### Grand Total: ~143 developer-days across all 28 features

---

## 8. Sources

### Competitive Landscape
- [Top 10 Real Estate CRM Software in India 2026 — Erino](https://erino.io/blog/top-10-real-estate-crm-software-in-india)
- [Best Real Estate CRM Software in India 2026 — Realatic](https://realatic.com/blog/best-crm-real-estate-india/)
- [Sell.Do: India's No.1 Real Estate CRM — Business Standard](https://www.business-standard.com/content/specials/sell-do-india-s-no-1-real-estate-crm-achieves-30-market-share-with-game-changing-features-124120300751_1.html)
- [Best Real Estate CRM 2026: Honest Comparison — Brixi.AI](https://brixi.ai/blogs/best-real-estate-crm-2026)
- [Real Estate CRM Pricing India — Realatic](https://realatic.com/pricing/)
- [PropFlo Reviews — Capterra India](https://www.capterra.in/software/1054084/propflo)

### Indian RE Agent Pain Points
- [Challenges Faced by Real Estate Brokers in India — Sell.Do](https://www.sell.do/blog/challenges-faced-by-real-estate-brokers)
- [Real Estate CRM in India 2025 Guide — Makanify](https://makanify.com/blog/real-estate-crm-india-2025-guide)
- [21 Biggest Problems in Real Estate — Salesmate](https://www.salesmate.io/blog/problems-of-being-in-real-estate-industry/)

### WhatsApp Business API
- [WhatsApp Business API for Real Estate — Wacto](https://wacto.in/whatsapp-business-api-real-estate/)
- [WhatsApp for Real Estate 2026 Playbook — Go4WhatsUp](https://www.go4whatsup.com/guides/whatsapp-for-real-estate/)
- [WhatsApp Support for Payment Gateways 2026 — Razorpay](https://razorpay.com/blog/whatsapp-support-for-payment-gateways-the-complete-2026-merchant-playbook)
- [WhatsApp API 2026 Updates: Pacing, Limits, Usernames — WozTell](https://woztell.com/whatsapp-api-2026-updates-pacing-limits-usernames/)
- [WhatsApp Flows Payment Collection — WA.Expert](https://wa.expert/pages/whatsapp-flows-payment-collection)

### Hindi/Hinglish AI
- [AI Chatbot for Real Estate India 2026 — opZynic](https://www.opzynic.com/blog/ai-chatbot-real-estate-lead-generation-2026)
- [Multilingual WhatsApp Chatbot — Edesy](https://edesy.in/features/multilingual-whatsapp-chatbot)
- [The Next Big Thing for Multilingual Chatbots: Hinglish — Haptik](https://www.haptik.ai/blog/multilingual-chatbots-hinglish)
- [Best Multilingual AI Chat Agents for Indian Languages 2026 — MyOperator](https://myoperator.com/blog/top-5-ai-chat-agents-indian-languages-for-smb-2026)

### RERA & Compliance
- [RERA Updates 2026 Legal Guide — Mores](https://www.mores.in/blog/rera-updates-2026-ncr-homebuyer-complete-legal-guide)
- [RERA 2.0 What's New for Homebuyers — LegalAssist](https://legalassist.co.in/rera-2-0-whats-new-for-homebuyers-in-2025/)
- [RERA Compliance Checklist — Lawrbit](https://www.lawrbit.com/article/rera-compliance-checklist-real-estate/)

### Market Data
- [Tier-2/3 Cities: Next Real Estate Boom — LiveHomes](https://www.livehomes.in/liveinsights-details/Tier-2-and-Tier-3-Cities-The-Next-Real-Estate-Boom-in-India-2026)
- [Indian Real Estate Market — Mordor Intelligence](https://www.mordorintelligence.com/industry-reports/real-estate-industry-in-india)
- [Click-to-WhatsApp Ads Benchmarks 2026 — Kanal](https://getkanal.com/blog/click-to-whatsapp-ads-benchmarks-2026)
- [Email Marketing for Real Estate Developers India — CampaignHQ](https://blog.campaignhq.co/email-marketing-real-estate-developers-drip-campaigns)

### AI in Real Estate
- [AI Real Estate Market Analysis 2026 — GrowthFactor](https://www.growthfactor.ai/blog-posts/ai-real-estate-market-analysis)
- [5 Best AI CRMs for Real Estate 2026 — HubSpot](https://blog.hubspot.com/sales/ai-crm-real-estate)
- [AI-Powered CRMs for Real Estate 2026 — KeeTechnology](https://keetechnology.com/blog/ai-crm-for-real-estate/)
