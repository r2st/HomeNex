// siteVisit.js — pure formatters for the automated WhatsApp confirmations Meta calls
// "utility" messages: sent on booking, ~1 day before, and ~2 hours before (with a
// location pin). Kept side-effect-free so they're trivially testable; the scheduler
// and the booking route own the actual sending.

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

// Sent immediately when a visit is booked.
export function bookingConfirmationText(v, { timezone } = {}) {
  const name = v.lead_name && v.lead_name !== v.lead_wa_id ? v.lead_name.split(' ')[0] : null
  return [
    `${name ? `Hi ${name}! ` : ''}Your site visit is confirmed ✅`,
    `🗓️ ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `🏠 ${propertyLine(v)}`,
    v.pickup_required && `🚗 Pickup arranged${v.pickup_location ? ` from ${v.pickup_location}` : ''}`,
    `See you there. Reply here if anything changes.`,
  ]
    .filter(Boolean)
    .join('\n')
}

// Sent ~1 day before (no location pin yet — just a heads-up).
export function reminderT1Text(v, { timezone } = {}) {
  return [
    `Reminder: your site visit is tomorrow 📍`,
    `🗓️ ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `🏠 ${propertyLine(v)}`,
    v.pickup_required && `🚗 Pickup${v.pickup_location ? ` from ${v.pickup_location}` : ''} — please be ready.`,
    `Reply here to reschedule.`,
  ]
    .filter(Boolean)
    .join('\n')
}

// Sent ~2 hours before, WITH the location pin.
export function reminderT2Text(v, { timezone } = {}) {
  const pin = mapsLink(v.property_locality, v.property_city)
  return [
    `Your site visit is in ~2 hours ⏰`,
    `🗓️ ${fmtWhen(v.scheduled_at, timezone)}`,
    propertyLine(v) && `🏠 ${propertyLine(v)}`,
    pin && `📍 Location: ${pin}`,
    v.pickup_required && `🚗 Pickup${v.pickup_location ? ` from ${v.pickup_location}` : ''} is on the way.`,
  ]
    .filter(Boolean)
    .join('\n')
}
