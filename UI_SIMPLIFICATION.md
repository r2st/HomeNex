# HomeNex UI Simplification

Goal: make the HomeNex agent app self-explanatory so a new real-estate agent can
use it with minimal training. Every change keeps the existing green/white theme
(`brand`, `brand-wash`, `cream`, `ink*`, `line` tokens) and the mobile-first,
single-column phone layout.

Guiding principles:
- **Explain before you ask.** Empty states say *why* a thing matters and *what to do*.
- **Plain words over jargon.** Where jargon is unavoidable (RERA, WABA), attach a
  one-tap `InfoTip` (ⓘ) that explains it in a sentence.
- **Show state, not codes.** Badges describe what's happening ("You reply") instead
  of internal modes ("MANUAL").
- **Collapse the rarely-changed.** Setup/config surfaces shrink to a chip once done.

All new decision logic lives in small **pure modules** under `src/lib/` so it can be
unit-tested with `node --test` (run via `npm test` at the repo root). Components import
these helpers rather than embedding the logic inline.

---

## Home screen (`DashboardTab`, `ShareNumberCard`)

**Problem:** The WhatsApp Business Number card (`+1 365 275 4408`) is large and fills the
home screen for any agent whose day is quiet. New agents get no guidance on what to do first.

**Changes**
1. `ShareNumberCard` gains a `compact` prop.
   - Number **configured** → renders a small inline **"✓ WhatsApp connected"** chip showing
     the number, with a **Share ▾** toggle that expands to the Copy / Open-in-WhatsApp
     actions on demand. The full setup form still lives in **Settings → WhatsApp Business Number**.
   - Number **not configured** → renders nothing on Home (the onboarding banner + Settings
     handle setup), so the empty-day home is no longer dominated by a setup card.
2. New **`OnboardingBanner`** (shown at the top of Home) for first-time agents. It lists the
   two first actions with done ticks and deep-links:
   - Connect your WhatsApp Business number → Settings
   - Add your first properties → Properties
   Visibility is decided by `shouldShowOnboarding()` (`src/lib/onboarding.js`): shown while a
   step is pending, auto-hidden once the agent has real leads, and dismissible (persisted in
   `localStorage` under `homenex_onboarding_dismissed`).

## Leads screen (`LeadsTab`)

**Problem:** Empty kanban columns just say "empty". Pipeline tabs give no sense of volume.

**Changes**
1. Empty columns use `stageEmptyText(stageName)` (`src/lib/stageEmpty.js`) — e.g. the **New**
   column reads *"New leads from WhatsApp will appear here"* with a 💬 icon, **Lost** reads
   *"Leads marked lost show up here"*, others read *"Drag leads here as they reach {stage}"*.
2. Pipeline tabs (Buy Primary / Buy Resale / Rental) show a subtle count of open leads per
   pipeline, computed by `pipelineCounts(leads)` (`src/lib/pipelineCounts.js`).

## Inbox screen (`InboxTab`)

**Problem:** The **MANUAL** badge is opaque. Nothing explains the AI-vs-manual split.

**Changes**
1. Conversation rows use `replyModeBadge(lead)` (`src/lib/replyMode.js`):
   - AI on → **🤖 Auto-reply** (brand/green)
   - AI off → **✋ You reply** (amber)
2. A one-line helper under the Inbox header: *"🤖 Auto-reply = HomeNex AI answers · ✋ You reply
   = you've taken over."*

## Properties screen (`PropertiesTab`)

**Problem:** Three rows of filter chips (type, price band, BHK + status) overwhelm the small screen.
The empty state doesn't say why properties matter.

**Changes**
1. Replace the three chip rows with a single **Filters** button that shows the active-filter count
   and opens a bottom **Sheet** containing all filters (type, price, BHK, status) plus a Clear-all.
   The search box stays inline. Active-filter count via `activeFilterCount(filters)`
   (`src/lib/propertyFilters.js`).
2. Empty state gains an explanation: properties are matched to every lead automatically and can be
   sent to WhatsApp in one tap — with the existing "Add your first property" CTA.

## Lead detail (`LeadDetail`)

**Problem:** A brand-new lead shows a Buyer Profile full of "not set" and a Score Breakdown of all
zeros — both read as broken/discouraging.

**Changes**
1. When every buyer-profile field is empty (`buyerProfileIsEmpty(lead)`, `src/lib/buyerProfile.js`),
   the Buyer Profile card shows a friendly line — *"Info will be captured from conversations as this
   buyer chats. You can also add it manually."* — instead of a wall of "not set". Edit still works.
2. Score Breakdown is hidden below a threshold. `shouldShowScoreBreakdown(score, breakdown)`
   (`src/lib/scoreDisplay.js`, `SCORE_BREAKDOWN_MIN = 20`) gates it; below threshold we show
   *"Not enough data yet — the score sharpens as the buyer shares budget, location and timeline."*
   The **Before You Call** section is unchanged.

## More menu (`MoreTab`, `BottomNav`, `App`)

**Problem:** Follow-ups (a daily-use feature) is buried. Menu descriptions are terse.

**Changes**
1. App polls pending follow-ups and computes an actionable count (overdue + due-today) via
   `actionableFollowupCount(followups, now)` (`src/lib/followups.js`). That count is shown as a
   badge on the **More** bottom-nav icon and on the **Follow-ups** row inside More.
2. Menu descriptions reworded to be action-first and clearer (e.g. Site visits → *"Schedule and
   track property tours"*).

## General

- New **`InfoTip`** primitive in `ui.jsx`: a tappable ⓘ that reveals a short plain-language
  explanation. Used for jargon — **RERA** (Properties list / template composer) and **WhatsApp
  Business / WABA** (onboarding, connected chip).
- Plain-language passes on labels where a code leaked into the UI.
- Every empty state reviewed to include a reason + a next action.

---

## Testing

Pure modules under `src/lib/*.js` are covered by co-located `*.test.js` files using the Node
built-in test runner. `npm test` (repo root) runs `node --test src/lib/`. Server tests remain in
`server/test/` and are unaffected.
