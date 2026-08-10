// siteVisit.js — pure formatters for the automated WhatsApp confirmations Meta calls
// "utility" messages: sent on booking, ~1 day before, and ~2 hours before (with a
// location pin). Kept side-effect-free so they're trivially testable; the scheduler
// and the booking route own the actual sending.
//
// Localized to the buyer's own language/register (see language.js) — an automated
// reminder landing in English mid-Hindi/Hinglish conversation reads as a canned
// bot message and breaks the "one broker, one number" feel the rest of the app
// works hard to keep. `lang` accepts language.js's detectConversationLanguage()
// output shape ({ language }) directly, or a bare language string; anything
// unrecognized (or omitted) falls back to English, so every existing caller keeps
// working unchanged.

// A shareable "location pin": a Google Maps search link for the property's locality.
// (Meta's location-message type needs lat/long we don't store; a maps link is the
// pragmatic, universally-tappable stand-in.)
export function mapsLink(locality, city) {
  const place = [locality, city].filter(Boolean).join(', ')
  if (!place) return null
  return `https://maps.google.com/?q=${encodeURIComponent(place)}`
}

// Human date/time in IST (the app's default timezone).
function fmtWhen(scheduledAt, timezone = 'Asia/Kolkata') {
  const d = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt)
  return d.toLocaleString('en-IN', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function propertyLine(v) {
  const spec = [v.property_title, [v.property_locality, v.property_city].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' — ')
  return spec || null
}

const LANGS = new Set(['english', 'hindi', 'hinglish'])
// Accept either a detectConversationLanguage() result or a bare string.
function resolveLang(lang) {
  const l = typeof lang === 'string' ? lang : lang?.language
  return LANGS.has(l) ? l : 'english'
}

const COPY = {
  english: {
    confirmedGreeting: (name) => `${name ? `Hi ${name}! ` : ''}Your site visit is confirmed ✅`,
    pickupArranged: (loc) => `🚗 Pickup arranged${loc ? ` from ${loc}` : ''}`,
    confirmedClose: 'See you there. Reply here if anything changes.',
    t1Title: 'Reminder: your site visit is tomorrow 📍',
    t1Pickup: (loc) => `🚗 Pickup${loc ? ` from ${loc}` : ''} — please be ready.`,
    t1Close: 'Reply here to reschedule.',
    t2Title: 'Your site visit is in ~2 hours ⏰',
    t2Location: (pin) => `📍 Location: ${pin}`,
    t2Pickup: (loc) => `🚗 Pickup${loc ? ` from ${loc}` : ''} is on the way.`,
    propertyIcon: '🏠',
    whenIcon: '🗓️',
  },
  hinglish: {
    confirmedGreeting: (name) => `${name ? `Hi ${name}! ` : ''}Aapki site visit confirm ho gayi hai ✅`,
    pickupArranged: (loc) => `🚗 Pickup arranged hai${loc ? ` — ${loc} se` : ''}`,
    confirmedClose: 'Wahin milte hain. Kuch change ho to yahin reply kar dena.',
    t1Title: 'Reminder: aapki site visit kal hai 📍',
    t1Pickup: (loc) => `🚗 Pickup${loc ? ` — ${loc} se` : ''} — ready rehna.`,
    t1Close: 'Reschedule karna ho to yahin reply karein.',
    t2Title: 'Aapki site visit ~2 ghante mein hai ⏰',
    t2Location: (pin) => `📍 Location: ${pin}`,
    t2Pickup: (loc) => `🚗 Pickup${loc ? ` — ${loc} se` : ''} nikal chuka hai.`,
    propertyIcon: '🏠',
    whenIcon: '🗓️',
  },
  hindi: {
    confirmedGreeting: (name) => `${name ? `नमस्ते ${name}! ` : ''}आपकी साइट विज़िट कन्फर्म हो गई है ✅`,
    pickupArranged: (loc) => `🚗 पिकअप की व्यवस्था है${loc ? ` — ${loc} से` : ''}`,
    confirmedClose: 'वहीं मिलते हैं। कुछ बदलाव हो तो यहीं जवाब दें।',
    t1Title: 'याद दिलाना है: आपकी साइट विज़िट कल है 📍',
    t1Pickup: (loc) => `🚗 पिकअप${loc ? ` — ${loc} से` : ''} — तैयार रहें।`,
    t1Close: 'रीशेड्यूल करना हो तो यहीं जवाब दें।',
    t2Title: 'आपकी साइट विज़िट लगभग 2 घंटे में है ⏰',
    t2Location: (pin) => `📍 Location: ${pin}`,
    t2Pickup: (loc) => `🚗 पिकअप${loc ? ` — ${loc} से` : ''} रवाना हो चुका है।`,
    propertyIcon: '🏠',
    whenIcon: '🗓️',
  },
}

// Sent immediately when a visit is booked.
export function bookingConfirmationText(v, { timezone, lang } = {}) {
  const c = COPY[resolveLang(lang)]
  const name = v.lead_name && v.lead_name !== v.lead_wa_id ? v.lead_name.split(' ')[0] : null
  return [
    c.confirmedGreeting(name),
    `${c.whenIcon} ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `${c.propertyIcon} ${propertyLine(v)}`,
    v.pickup_required && c.pickupArranged(v.pickup_location),
    c.confirmedClose,
  ]
    .filter(Boolean)
    .join('\n')
}

// Sent ~1 day before (no location pin yet — just a heads-up).
export function reminderT1Text(v, { timezone, lang } = {}) {
  const c = COPY[resolveLang(lang)]
  return [
    c.t1Title,
    `${c.whenIcon} ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `${c.propertyIcon} ${propertyLine(v)}`,
    v.pickup_required && c.t1Pickup(v.pickup_location),
    c.t1Close,
  ]
    .filter(Boolean)
    .join('\n')
}

// Sent ~2 hours before, WITH the location pin.
export function reminderT2Text(v, { timezone, lang } = {}) {
  const c = COPY[resolveLang(lang)]
  const pin = mapsLink(v.property_locality, v.property_city)
  return [
    c.t2Title,
    `${c.whenIcon} ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `${c.propertyIcon} ${propertyLine(v)}`,
    pin && c.t2Location(pin),
    v.pickup_required && c.t2Pickup(v.pickup_location),
  ]
    .filter(Boolean)
    .join('\n')
}
