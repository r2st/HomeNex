# HomeNex — Further UI Simplification Opportunities

Audit of every screen/component in `src/components/` for a **non-tech-savvy Indian
real-estate agent**. Builds on `UI_SIMPLIFICATION.md` (e99d9e6) and
`SIMPLIFY_AND_HARDEN.md`. Same principles carry over: *explain before you ask*,
*plain words over jargon* (glossary + `InfoTip` ⓘ), *show state not codes*,
*collapse the rarely-changed*, no new npm deps, decision logic in testable
`src/lib/*.js` pure modules.

Nothing here is implemented yet — this is a prioritised proposal list. Each item
quotes the current UI text/code, states the problem, and proposes a concrete
change with a rough effort tag.

---

## Top priorities (highest impact for a layman)

1. **Property "Photo URLs" / "Brochure URL" require hosting a link** — replace with
   phone file-upload (`PropertyDetail.jsx`). A broker photographs a flat on their
   phone; asking for a URL is a dead end. *(High)*
2. **Two contradictory WhatsApp-setup models** — Settings says *"our support team
   registers it"* (read-only) while the Home card asks the agent to paste a
   `phone_number_id` from the *"Meta developer dashboard"*. Pick one; hide the
   developer field. *(High)*
3. **Lead sources screen is developer-grade** — API keys, "form ID", "Regenerate
   address", raw status codes (`merged`/`unmatched`). Lead with copy-the-email;
   hide keys/IDs behind "Advanced". *(High)*
4. **Raw browser `prompt()` / `alert()` leaked back in** — group blast
   (`ContactsTab.jsx`) and GST invoice errors (`CommissionsScreen.jsx`) bypass the
   themed `Confirm`/inline-error pattern the last pass established. *(Medium)*
5. **Internal codes/acronyms still surfacing** — `BLTC`, `buy_primary`, `payer ?`,
   template snake_case names, IANA timezones, "Meta cost". *(Low–Medium, mostly quick)*
6. **Home screen stacks up to 7 overlapping sections** — "Your day" worklist already
   contains the unanswered/follow-up items shown again below it. *(Medium–High)*

---

## AuthScreen.jsx

Already clean (single WhatsApp number, friendly headline, ⓘ-free). Minor:

### No "show password" toggle
- **File:** `AuthScreen.jsx:124-132`
- **Current:** `type="password"` with placeholder `'At least 6 characters'`
- **Problem:** On a phone keyboard, a non-tech user who mistypes a hidden password just sees a generic login failure and can't tell what went wrong.
- **Suggested:** Add a 👁 show/hide toggle on the password field (both signup and login).
- **Effort:** low

---

## DashboardTab.jsx (Home)

### Too many stacked, overlapping sections
- **File:** `DashboardTab.jsx:233-419`
- **Current:** In order: Onboarding, WhatsApp chip, 4 KPIs, **ALERTS**, **YOUR DAY — WHAT TO DO NEXT**, **UNANSWERED — REPLY NOW**, **TODAY'S FOLLOW-UPS**, **⏰ OVERDUE · BY HEAT**, **TODAY'S SITE VISITS**, **🔥 HOT LEADS**, **LIVE Activity**.
- **Problem:** The "Your day" worklist is explicitly the "what to do next" list, yet Unanswered, Today's follow-ups and Overdue are then repeated as their own sections — the same lead can appear 3–4 times, and the agent scrolls a very long page to find "what now".
- **Suggested:** When the worklist has items, make it the single hero list and collapse Unanswered/Follow-ups/Overdue into it (or hide them). Keep Hot leads + Live activity below. Decide the merge in a `src/lib/homeSections.js` pure module.
- **Effort:** medium

### "BY HEAT" heading is jargon
- **File:** `DashboardTab.jsx:322`
- **Current:** `⏰ OVERDUE · BY HEAT`
- **Problem:** "By heat" is internal shorthand for the hot/warm/cold sort.
- **Suggested:** `⏰ OVERDUE FOLLOW-UPS` (the 🔥/☀️/❄️ icons already show heat).
- **Effort:** low

### Raw numeric score on hot leads
- **File:** `DashboardTab.jsx:386`
- **Current:** `{l.name || l.wa_id} <span className="text-hot">· {l.score}/100</span>`
- **Problem:** "· 82/100" is a developer-ish metric; a layman doesn't know what a 82 means or what to do with it.
- **Suggested:** Show a word + emoji instead — `🔥 Hot` / `☀️ Warm` — reusing the temperature the card already carries. Keep the number only inside LeadDetail's ScoreRing.
- **Effort:** low

---

## ShareNumberCard.jsx

### Setup form asks for a Meta `phone_number_id`
- **File:** `ShareNumberCard.jsx:122-140`
- **Current:** *"Enter your WhatsApp Business number and its Meta phone_number_id from the Meta developer dashboard."* with placeholders `"Meta phone_number_id"` and `"WhatsApp number, e.g. +919812345678"`.
- **Problem:** `phone_number_id` and "Meta developer dashboard" are pure developer concepts. This directly contradicts `SettingsTab`'s WabaCard, which tells the agent their number is registered *for* them by support and is read-only.
- **Suggested:** Remove the self-serve `phone_number_id` field from the agent UI entirely (keep it admin-only in `AdminPanel`). The agent card should only ever *display* the connected number + Share actions. Resolve the two-model conflict in favour of the "support registers it" flow.
- **Effort:** high

### "Configure number" heading vs "connected" reality
- **File:** `ShareNumberCard.jsx:170`, `:120`, `:191`
- **Current:** `SET UP YOUR WHATSAPP NUMBER` / `CONFIGURE YOUR WHATSAPP NUMBER`
- **Problem:** "Configure" is techy; and if support does registration, the agent shouldn't see a config CTA at all.
- **Suggested:** If unconfigured, show a friendly "Your WhatsApp number is being set up — we'll email you when it's live" instead of a config button.
- **Effort:** medium (folds into the item above)

---

## LeadsTab.jsx

### Kanban board relies on drag-and-drop
- **File:** `LeadsTab.jsx:247-324`
- **Current:** Default view is `board`; cards move only by `draggable` drag onto a column.
- **Problem:** Drag-and-drop on a small touchscreen is fiddly and undiscoverable for non-tech users; there's no on-card tap-to-move on the board (you must open the lead → "Move →").
- **Suggested:** Make **List** the default view, or add a small stage-chip / "Move" affordance on each board card so a tap (not a drag) advances the stage. The `LeadDetail` `StagePicker` sheet already exists to reuse.
- **Effort:** medium

### Three view toggles incl. analytics-heavy "Stats"
- **File:** `LeadsTab.jsx:247-249`, `:103-155`
- **Current:** `▦ Board · ☰ List · 📊 Stats`; Stats renders `FUNNEL · AVG TIME IN STAGE`, dwell-time (`3d 4h`), and a `WHY LEADS ARE LOST` table.
- **Problem:** Funnel + average-time-in-stage is manager analytics, not a solo agent's daily need; three toggles add choice overhead on the main working screen.
- **Suggested:** Move "Stats" out of the primary toggle row (into Insights/Team-Board where analytics live), leaving Board/List. Keep it for managers only if desired.
- **Effort:** medium

### Numeric score on every lead card
- **File:** `LeadsTab.jsx:64-66`
- **Current:** `{lead.temp === 'Hot' ? '🔥' …} {lead.score ?? 0}`
- **Problem:** Same raw-number concern as Home; the emoji already conveys heat.
- **Suggested:** Drop the number from the kanban card, keep the emoji + (optionally) the word.
- **Effort:** low

---

## InboxTab.jsx

### "score {n}" in the chat header
- **File:** `InboxTab.jsx:405-407`
- **Current:** `+{lead.wa_id} · {lead.temp} · score {lead.score}`
- **Problem:** A raw "score 74" in the conversation header is developer-oriented noise while replying.
- **Suggested:** `+{wa_id} · {temp}` only (drop the score here; it lives in LeadDetail).
- **Effort:** low

### "window" jargon without an explainer
- **File:** `InboxTab.jsx:408-412`, `:263-266`
- **Current:** `🟢 window open · 3h left` / `🔒 window closed · templates only`; and `⏱️ 24-hour window closed — only approved templates can be sent until {name} replies again.`
- **Problem:** "window", "templates" are WhatsApp-policy terms. `glossary.SERVICE_WINDOW` / `glossary.TEMPLATE` exist but aren't surfaced here.
- **Suggested:** Add an `InfoTip` next to the badge, and reword the closed-state line to plain English: *"You can send free replies for 24 hours after the buyer's last message. That time's up — pick one of your approved messages below."*
- **Effort:** low

### AI toggle label differs from the list badge
- **File:** `InboxTab.jsx:420-427` vs `lib/replyMode.js`
- **Current:** Conversation shows `🤖 AI on` / `AI off`; the inbox list uses `replyModeBadge` → `🤖 Auto-reply` / `✋ You reply`.
- **Problem:** Two names for the same state confuse a first-timer ("is 'AI on' the same as 'Auto-reply'?").
- **Suggested:** Use one vocabulary everywhere: `🤖 Auto-reply` (on) / `✋ You reply` (off) for the toggle too.
- **Effort:** low

---

## PropertiesTab.jsx

Largely already simplified (search + Filters sheet + friendly empty state). Minor:

### "RERA ✓" with no explanation
- **File:** `PropertiesTab.jsx:193`
- **Current:** `{p.rera_project_number ? ' · RERA ✓' : ''}`
- **Problem:** RERA is defined elsewhere but not on this list row.
- **Suggested:** Low priority; acceptable as-is since RERA is explained on the property form/detail. Optionally reuse `glossary.RERA` via an ⓘ on the section, not per-row.
- **Effort:** low

---

## PropertyDetail.jsx — `PropertyForm`

### "Photo URLs (one per line)" + "Brochure URL" — impossible for a phone user
- **File:** `PropertyDetail.jsx:115-120`, `:30`, `:50`
- **Current:** `<Field label="Photo URLs (one per line)"><textarea …/></Field>` and `<Field label="Brochure URL"><input …/></Field>`
- **Problem:** A non-tech broker has photos in their phone gallery and a brochure PDF — not hosted URLs. This is the single biggest blocker in the add-property flow.
- **Suggested:** Replace both with file pickers that upload like `ProfileCard`'s avatar / `MediaManager` (base64 → server). Multi-select for photos, single for brochure. Keep a URL fallback only behind "Advanced".
- **Effort:** high

### 14-field single form with no grouping
- **File:** `PropertyDetail.jsx:56-133`
- **Current:** Title, Type, Status, BHK, Size, Price, Locality, City, RERA number, Builder, Owner, Photos, Brochure, Notes — all flat.
- **Problem:** A long undivided form is intimidating; only Title is required but that isn't obvious, so users feel they must fill everything.
- **Suggested:** Show the essentials (Title, Type, BHK, Price, Locality, Status, Photos) and collapse RERA/Builder/Owner/Brochure/Notes under a **"More details (optional)"** expander. Add ⓘ (`glossary.RERA`) on the RERA field.
- **Effort:** medium

### Marketing/analytics cards stacked on every property
- **File:** `PropertyDetail.jsx:475-477` (`MicroPageCard`, `SyndicateCard`, `AnalyticsCard`)
- **Current:** Three dense promo/analytics sections render inline before the "Send to chat" button. `AnalyticsCard` has a 14-day bar chart, `WHO'S LOOKING`, `VIEW ANALYTICS`; `MicroPageCard` says *"Views count as engagement."*
- **Problem:** Heavy cognitive load; "engagement", "micro-page", "syndication", "distinct_leads" are marketing/analytics jargon on what should be a simple "see property → send to buyer" screen.
- **Suggested:** Collapse the three into one **"Share & promote"** accordion (collapsed by default). Reword "Views count as engagement." → "Every time someone opens it is counted here." Simplify `AnalyticsCard` header to "Who's looking at this property" and drop the sparkline for laymen.
- **Effort:** medium

---

## SnippetsMediaScreen.jsx

### Template category (utility / marketing / service) exposed raw
- **File:** `SnippetsMediaScreen.jsx:157-163`, `:191-195`
- **Current:** Chips `utility · marketing · service`; list shows raw `{t.category}` badge, plus `🔒`, `pack`.
- **Problem:** WhatsApp template categories are a Meta-policy concept; a broker doesn't know if their message is "utility" vs "service".
- **Suggested:** Default new templates to a sensible category and hide the selector (or replace with plain choices like "Reminder / Promotion"); add a one-line explainer. Keep the RERA checkbox (already gated to marketing) but auto-derive category from that toggle.
- **Effort:** medium

### `{{name}}` variable syntax typed by hand
- **File:** `SnippetsMediaScreen.jsx:6`, `:165`, `:243`
- **Current:** `varsHint = 'Use {{name}}, {{property}}, {{visit_time}} as fill-in variables.'`; body placeholder `"Hi {{name}}, …"`.
- **Problem:** Double-brace variable syntax is a programming concept; users will mistype `{name}` or `{{Name}}`.
- **Suggested:** Offer tap-to-insert chips ("Insert: Name · Property · Visit time") that drop the correct token into the textarea, so nobody types braces.
- **Effort:** medium

### snake_case template name placeholder
- **File:** `SnippetsMediaScreen.jsx:155`
- **Current:** `placeholder="e.g. follow_up_week"`
- **Problem:** `follow_up_week` looks like a code identifier.
- **Suggested:** `placeholder="e.g. Weekly follow-up"`.
- **Effort:** low

### Templates vs Quick replies distinction is unclear
- **File:** `SnippetsMediaScreen.jsx:341-354`
- **Current:** Four tabs: `Media library · Templates · Quick replies · Labels`.
- **Problem:** To a layman both Templates and Quick replies are "saved messages"; the difference (approved-template-for-out-of-window vs snippet-for-in-window) is invisible.
- **Suggested:** Add a one-line subtitle under each tab: Templates → "Approved messages for buyers who haven't replied in 24h." Quick replies → "Shortcuts you drop into a live chat."
- **Effort:** low

---

## FestiveTab.jsx

Clean and well-scoped. Only nit: `Message ({name} becomes the client's name)` — same
braces-syntax concern as templates; consider a "the name fills in automatically"
phrasing without exposing `{name}`. *(Low)*

---

## SettingsTab.jsx

### "WABA Registration" acronym in a heading
- **File:** `SettingsTab.jsx:144`
- **Current:** `<h3>How WABA Registration Works</h3>`
- **Problem:** "WABA" is an acronym in a user-facing heading (the body copy already avoids it).
- **Suggested:** "How your WhatsApp number gets connected". Keep the ⓘ/glossary for WABA elsewhere.
- **Effort:** low

### Status pills use off-theme raw Tailwind colors
- **File:** `SettingsTab.jsx:7-19`
- **Current:** `statusColors` uses `bg-gray-100 text-gray-600`, `bg-blue-100 text-blue-700`, etc.
- **Problem:** Breaks the green/white brand token system (`brand`, `amber-wash`, `cream`) used everywhere else; blue/gray pills look foreign.
- **Suggested:** Map to brand tokens (e.g. active → `bg-brand-wash text-brand-deep`, pending → `bg-amber-wash text-gold`).
- **Effort:** low

### Contradicts ShareNumberCard's self-serve setup
- **File:** `SettingsTab.jsx:145-150` vs `ShareNumberCard.jsx:122-140`
- **Current:** Here: *"Our support team registers it on Meta WhatsApp Business API."* There: agent pastes `phone_number_id`.
- **Problem:** Two mental models for the same task.
- **Suggested:** Same resolution as ShareNumberCard #1 — one flow only.
- **Effort:** high (shared with ShareNumberCard)

---

## PreferencesCard.jsx

### Timezone dropdown shows raw IANA zones
- **File:** `PreferencesCard.jsx:22-33`, `:121-137`
- **Current:** `Asia/Kolkata`, `America/New_York`, `Australia/Sydney`… rendered via `tz.replace('_',' ')`.
- **Problem:** IANA identifiers are technical; a solo Indian agent almost never needs anything but IST, and the long list adds choice overhead.
- **Suggested:** Default to Asia/Kolkata and either (a) hide the timezone control for non-NRI agents, or (b) show friendly labels ("India (IST)", "Dubai (GST)") mapped in a small `src/lib/timezones.js`.
- **Effort:** medium

### Alerts toggles for a feature that isn't live
- **File:** `PreferencesCard.jsx:139-161`
- **Current:** *"Alert delivery is still rolling out — these choices apply once it lands."*
- **Problem:** Presenting 3 toggles that do nothing yet is confusing and erodes trust.
- **Suggested:** Hide the Alerts block until delivery ships, or tag it "Coming soon" and disable the toggles.
- **Effort:** low

---

## SecurityCard.jsx

### Change-number form is hard-locked to +91 / 10 digits
- **File:** `SecurityCard.jsx:22-28`, `:64-79`, `:107`
- **Current:** `api.changePhone({ phone: '+91' + newPhone })`; validation `newPhone.length !== 10`; fixed `+91` prefix span.
- **Problem:** Signup (`AuthScreen`) accepts international country codes (+971, +44…), but an NRI/overseas agent can never change their login number here — it's forced to a 10-digit +91.
- **Problem impacts usability, not just correctness:** the field silently rejects their real number.
- **Suggested:** Reuse the AuthScreen country-code + local-part input here so any valid number works.
- **Effort:** medium

---

## ProfileCard.jsx

Clean. Optional: add an ⓘ (`glossary.RERA`) on the `RERA registration ID` field
(`ProfileCard.jsx:182-190`). *(Low)*

---

## LeadSourcesScreen.jsx  *(most developer-oriented screen)*

### API-key fields for portal integrations
- **File:** `LeadSourcesScreen.jsx:70-84`, `:57-59`, `:163`
- **Current:** `placeholder="Paste partner API key…"`, `🔑 API key saved`, `Direct lead push`, section `DIRECT PORTAL INTEGRATIONS`.
- **Problem:** A non-tech agent has no API key and no idea what one is; this whole block is power-user territory.
- **Suggested:** Move API-key rows under a collapsed **"Advanced — connect a portal account"** expander; lead the screen with the copy-the-email flow, which needs zero technical knowledge.
- **Effort:** high

### "Lead form ID" for Facebook/Instagram
- **File:** `LeadSourcesScreen.jsx:148-157`
- **Current:** `placeholder="Lead form ID"`, *"Paste your form ID to route it to you."*, button `Connect`.
- **Problem:** "form ID" is a Meta developer artifact most agents can't find.
- **Suggested:** Either hide behind the same "Advanced" expander, or replace with a guided "Connect Facebook" button + link to a help article. Add `InfoTip` using `glossary.LEAD_ADS`.
- **Effort:** medium–high

### "Regenerate address" is a scary, unexplained action
- **File:** `LeadSourcesScreen.jsx:136-138`, `:107-110`
- **Current:** `↻ Regenerate address`
- **Problem:** No explanation that regenerating **breaks** the email already pasted into portals; one tap silently detaches their lead flow.
- **Suggested:** Add a `Confirm` dialog ("This makes a new email and stops the old one — you'll need to update it on each portal."), and demote it to a small "Advanced" link.
- **Effort:** low

### Raw ingestion status codes
- **File:** `LeadSourcesScreen.jsx:21-27`, `:189`
- **Current:** statuses `created · merged · duplicate · unmatched · failed`; feed shows `{e.status}` verbatim, plus `RECENT LEAD CAPTURES`.
- **Problem:** Internal pipeline states leak to the UI.
- **Suggested:** Map to plain words: created → "New lead", merged → "Added to existing contact", duplicate → "Already had this one", unmatched → "Couldn't match — check it", failed → "Didn't come through". Centralise in `src/lib/ingestStatus.js`.
- **Effort:** low

---

## MoreTab.jsx

### "Lead Ads" and "click-to-WhatsApp" jargon in the menu subtitle
- **File:** `MoreTab.jsx:154`
- **Current:** `sub: 'Connect portals, Lead Ads and click-to-WhatsApp'`
- **Problem:** Two acronyms/jargon terms in a menu descriptor a first-timer skims.
- **Suggested:** `'Get leads from 99acres, Facebook ads and more'`.
- **Effort:** low

### Long flat 11-item menu
- **File:** `MoreTab.jsx:150-162`
- **Current:** Follow-ups, Site visits, Team, Lead sources, Deals & commissions, Contacts, Snippets & media, Festive greetings, Insights, Help & billing, Settings.
- **Problem:** Everything at one level; daily items (Follow-ups, Contacts) sit beside rarely-touched setup (Lead sources, Snippets).
- **Suggested:** Group into 2–3 labelled clusters — e.g. "Daily work" (Follow-ups, Site visits, Contacts, Deals), "Grow" (Lead sources, Festive, Snippets, Insights), "Account" (Team, Help & billing, Settings).
- **Effort:** medium

### Site-visit status = five raw chips
- **File:** `MoreTab.jsx:131-141` (and same in `LeadDetail.jsx:541-551`)
- **Current:** `scheduled · confirmed · completed · no_show · rescheduled` as five side-by-side chips per visit.
- **Problem:** Five toggle chips per row is dense and `no_show`/`rescheduled` overlap conceptually; unclear which is "current".
- **Suggested:** Collapse to a single "Update status ▾" dropdown showing the current status, or reduce to the three states that matter (Scheduled / Done / No-show).
- **Effort:** medium

---

## BottomNav.jsx

Clean 5-tab layout, good. No change proposed.

---

## ContactsTab.jsx

### Bulk blast uses raw `window.prompt()`
- **File:** `ContactsTab.jsx:142-152`
- **Current:** `const message = window.prompt(\`Message to send to "${g.name}" …\`)`, then flash `Sent ${r.sent}, skipped ${r.skipped} (rate-limited/opted-out)`.
- **Problem:** A raw browser prompt is exactly what the last pass replaced elsewhere; it's off-theme, easy to mis-tap, and the result string exposes "rate-limited/opted-out" jargon — for a *bulk send to many contacts* with no styled confirm.
- **Suggested:** Replace with a themed `Sheet` (message textarea + recipient count + Send), and a `Confirm` before sending. Reword result: "Sent to 24. 3 skipped — they haven't agreed to messages yet." Add `glossary.OPT_IN` ⓘ.
- **Effort:** medium

### "Temperature" as a grouping term
- **File:** `ContactsTab.jsx:174`
- **Current:** `['temp', '🌡 Temperature']`
- **Problem:** "Temperature" for buyer interest is internal vocabulary.
- **Suggested:** `🌡 Interest level` (Hot/Warm/Cold).
- **Effort:** low

### Raw pipeline slug + score in contact's leads list
- **File:** `ContactsTab.jsx:96-101`
- **Current:** `{l.stage || 'New'} · {l.pipeline_type || 'buy_primary'}` and `{l.temp} · score {l.score ?? 0}`
- **Problem:** `buy_primary` is an internal slug shown verbatim; plus the raw score again.
- **Suggested:** Map via a shared `PIPELINE_LABEL` ("Buy (Primary)") and drop/replace the numeric score with the temperature word.
- **Effort:** low

---

## InsightsTab.jsx

### "full BLTC captured" — internal acronym leaked
- **File:** `InsightsTab.jsx:25`
- **Current:** `{ label: 'Leads qualified', value: \`${stats.qualifiedPct}%\`, sub: 'full BLTC captured' }`
- **Problem:** BLTC (Budget/Location/Timeline/Config) is developer shorthand shown directly to the agent.
- **Suggested:** `sub: 'budget, location, timeline & home type captured'`.
- **Effort:** low

Charts are otherwise clearly labelled and fine for this screen.

---

## LeadDetail.jsx

### "template" jargon in the free-window banner
- **File:** `LeadDetail.jsx:747-753`
- **Current:** `🎁 Free 72-hour messaging window — {h}h left. Reply freely, no template needed.` / `72-hour free-messaging window has closed — send an approved template.`
- **Problem:** "template" unexplained here (though in glossary).
- **Suggested:** Add `InfoTip` (`glossary.TEMPLATE` / `glossary.CTWA`) or reword: "…after that you can only send one of your approved messages."
- **Effort:** low

### Source labels without the CTWA explainer
- **File:** `LeadDetail.jsx:26-32`, `:737-744`
- **Current:** `Click-to-WhatsApp ad`, `Portal push`, `Facebook / Instagram Lead Ad`.
- **Problem:** "Click-to-WhatsApp"/"Portal push" are unexplained here; `glossary.CTWA`/`glossary.PORTAL` exist.
- **Suggested:** Add an ⓘ on the LEAD SOURCE label when the channel is CTWA / portal.
- **Effort:** low

Note: LeadDetail is information-dense (source, stage, briefing, autofill, CRM,
AI capture, matches, follow-ups, site visits, score, transcript) but each block is
useful and already has friendly empty/first-run states — no structural change urged
beyond the site-visit-status chip simplification shared with MoreTab.

---

## CommissionsScreen.jsx

### `alert()` for invoice errors
- **File:** `CommissionsScreen.jsx:120-130`
- **Current:** `catch (e) { alert(e.message) }`
- **Problem:** Raw browser alert, off-theme, and can surface a raw error string.
- **Suggested:** Inline themed error (as other screens do) via `friendlyError`.
- **Effort:** low

### "payer ?" developer placeholder in the UI
- **File:** `CommissionsScreen.jsx:151-156`
- **Current:** `{c.payer_type || 'payer ?'}` and `· {c.commission_pct}%`
- **Problem:** `'payer ?'` is a debug fallback that reaches end users; reads as broken.
- **Suggested:** Fall back to a plain label like "Payer not set" and map `payer_type` codes (builder/buyer/seller) to words.
- **Effort:** low

### Aging-report buckets are accounting jargon
- **File:** `CommissionsScreen.jsx:13`, `:46-51`
- **Current:** `0–30d / 31–60d / 61–90d / 90+ d` under "Total outstanding".
- **Problem:** An aging report is finance-professional UI; a solo broker mostly wants "who owes me and how overdue".
- **Suggested:** Keep the total prominently; collapse the four buckets under a "Payment age" expander, or relabel "On time / A bit late / Overdue / Very overdue".
- **Effort:** medium

### Four sub-tabs with subtle distinctions
- **File:** `CommissionsScreen.jsx:212-217`
- **Current:** `Receivables · Deals · Commissions · Invoices`.
- **Problem:** The difference between Deals, Commissions, Receivables and Invoices is subtle for a layman.
- **Suggested:** Consider merging Receivables into Commissions (as a filter/summary) and adding one-line intros per tab. At minimum add subtitles.
- **Effort:** medium

### Raw `deal_type` / status codes
- **File:** `CommissionsScreen.jsx:92-101`, `:149`
- **Current:** badge `{d.deal_type}`; second line `… · {d.status} · …`; commission `{c.status}` raw.
- **Problem:** Slugs like `resale`, `expected`, `invoiced` shown verbatim.
- **Suggested:** Map to Title-case friendly labels in a small status map.
- **Effort:** low

---

## SupportScreen.jsx

### "est. Meta cost" exposed to the agent
- **File:** `SupportScreen.jsx:151-156`
- **Current:** `{billing.usage.total_conversations} conversations · est. Meta cost {fmtRs(...)}`
- **Problem:** The wholesale Meta/WhatsApp cost is HomeNex's internal number; showing it confuses the agent about what *they* pay.
- **Suggested:** Show only what's relevant to them (conversations used vs quota); drop "Meta cost" or relabel as HomeNex's own pricing if that's the intent.
- **Effort:** low

### Raw category/status codes
- **File:** `SupportScreen.jsx:6`, `:132`, `:81`
- **Current:** `CATEGORIES = ['general','billing','whatsapp','technical','feature_request']`; ticket rows show `{t.category} · {t.status}`.
- **Problem:** Mostly fine (underscore stripped), but `technical`/`feature_request` are a bit dev-y for the category picker.
- **Suggested:** Friendlier options: "Something's not working", "Billing", "WhatsApp number", "Idea / request".
- **Effort:** low

---

## Cross-cutting themes

- **Kill the last raw browser dialogs.** `window.prompt` (`ContactsTab.jsx:143`) and
  `alert` (`CommissionsScreen.jsx:127`) should use the themed `Sheet`/`Confirm`/inline
  error primitives the earlier pass introduced.
- **Never show internal slugs.** `buy_primary`, `deal_type`, `payer ?`, ingest
  statuses, ticket categories — route all through friendly label maps (candidate for a
  shared `src/lib/labels.js` with tests).
- **One vocabulary for AI replies.** Align the conversation toggle (`AI on/off`) with the
  list badge (`Auto-reply / You reply`).
- **De-emphasise the numeric lead score.** Keep the ScoreRing in LeadDetail; elsewhere
  (Home hot leads, kanban cards, inbox header, contact leads) prefer the 🔥/☀️/❄️
  temperature word over `n/100`.
- **Photos as files, not URLs.** The property form is the clearest place a phone user
  hits a wall — fix it with the upload pattern already used for avatars/media.
- **Gate power-user surfaces.** Lead-sources API keys/form IDs, pipeline analytics,
  commission aging, timezone list, and the `phone_number_id` field are all fine to keep
  for advanced users but should sit behind "Advanced"/collapsed sections so the default
  view stays layman-simple.
- **Consistency of tokens.** A few spots (`SettingsTab` status pills) use raw Tailwind
  gray/blue instead of the brand token system — small but they look off-brand.

## Suggested testable pure modules (per repo convention)

- `src/lib/labels.js` — slug → friendly label (pipeline, deal type, statuses) + tests.
- `src/lib/ingestStatus.js` — ingestion status → plain sentence + tests.
- `src/lib/homeSections.js` — decide which Home sections to show given the worklist,
  to remove duplication + tests.
- `src/lib/timezones.js` — friendly timezone labels + tests.
