// Lead Source Integrations (FEATURE_RESEARCH §1.7, §3.1, Technical Notes).
//
// One place for turning "a lead arrived from somewhere that isn't an inbound WhatsApp
// message" into a real CRM lead: portal notification emails (99acres/MagicBricks/
// Housing/NoBroker), Meta Lead Ads (leadgen webhooks), click-to-WhatsApp ad referrals,
// walk-in/phone quick-adds, and direct portal API pulls. It also formats an agent's
// listing once and exports it into each portal's shape (syndication).
//
// Parsing is deterministic (regex + label matching) so it works with the AI provider
// down and is fully unit-testable; the WhatsApp auto-reply is best-effort.

import {
  normalizePhone,
  upsertLead,
  getLeadByAgentWaId,
  attachLeadContact,
  getContactByPhone,
  addContact,
  setLeadSourceProvenance,
  createLeadSourceEvent,
  updateLeadSourceEvent,
  logActivity,
  stampLeadTeam,
  upsertSyndication,
} from './db.js'
import { sendTemplate, whatsappConfigured } from './whatsapp.js'

const INGEST_DOMAIN = process.env.INGEST_EMAIL_DOMAIN || 'leads.homenex.in'

// The workspace's unique inbound-lead email address (portals send notifications here).
export const ingestAddress = (token) => `lead-${token}@${INGEST_DOMAIN}`

// Maps our fine-grained channel to the contacts.source enum (migration 002).
const CONTACT_SOURCE = {
  portal_email: 'portal',
  portal_api: 'portal',
  meta_lead_ad: 'facebook',
  ctwa: 'facebook',
  walk_in: 'walk_in',
  phone: 'walk_in',
  referral: 'referral',
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const PORTAL_LABELS = {
  '99acres': ['99acres', '99 acres'],
  magicbricks: ['magicbricks', 'magic bricks'],
  housing: ['housing.com', 'housing'],
  nobroker: ['nobroker', 'no broker'],
}

export function detectPortal({ from = '', subject = '', text = '' } = {}) {
  const hay = `${from} ${subject} ${text}`.toLowerCase()
  for (const [portal, needles] of Object.entries(PORTAL_LABELS)) {
    if (needles.some((n) => hay.includes(n))) return portal
  }
  return null
}

// Very small HTML→text so we can parse portal emails that only ship an HTML body.
function stripHtml(html = '') {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
}

// Find the value that follows any of `labels` ("Name: Ramesh", "Mobile - 98..").
function labelled(text, labels) {
  for (const raw of labels) {
    const label = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = text.match(new RegExp(`${label}\\s*[:\\-–]\\s*([^\\n\\r|]+)`, 'i'))
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i
// Indian mobile: optional +91/91/0 prefix, then a 10-digit number starting 6-9.
const PHONE_RE = /(?:\+?91[\s\-]?|0)?([6-9]\d{4}[\s\-]?\d{5})\b/

function firstMobile(text) {
  const m = text.match(PHONE_RE)
  return m ? m[1].replace(/\D/g, '') : null
}

// Parse a portal lead-notification email into a normalized lead. Returns null when no
// contact phone can be found (nothing actionable). `email` = { from, subject, text, html }.
export function parsePortalEmail(email = {}) {
  const portal = detectPortal(email)
  const body = email.text && email.text.trim() ? email.text : stripHtml(email.html || '')
  const full = `${email.subject || ''}\n${body}`

  const phoneLabelled = labelled(full, ['Mobile', 'Phone', 'Contact No', 'Contact Number', 'Contact', 'Mob'])
  const phone = (phoneLabelled && firstMobile(phoneLabelled)) || firstMobile(body)
  if (!phone) return null

  const name = labelled(full, ['Name', 'Customer Name', 'Enquirer Name', 'Enquirer', 'Posted By', 'User Name', 'Client'])
  const emailAddr =
    labelled(full, ['Email', 'Email ID', 'Email Id', 'E-mail']) || (body.match(EMAIL_RE)?.[0] ?? null)
  const property = labelled(full, [
    'Property', 'Project', 'Interested In', 'Regarding', 'Enquiry for', 'Enquiry For', 'Listing', 'Property Name',
  ])
  const message = labelled(full, ['Message', 'Query', 'Requirement', 'Comments', 'Remarks'])
  const budget = labelled(full, ['Budget', 'Budget Range'])
  const external_id = labelled(full, [
    'Response ID', 'Lead ID', 'Enquiry ID', 'Query ID', 'Reference ID', 'Ref ID', 'Response Id', 'Lead Id',
  ])

  return {
    portal,
    name: cleanName(name),
    phone,
    email: emailAddr && EMAIL_RE.test(emailAddr) ? emailAddr.toLowerCase() : null,
    property,
    message,
    budget,
    external_id,
  }
}

function cleanName(name) {
  if (!name) return null
  const n = name.replace(/\s+/g, ' ').trim()
  return n && n.length <= 80 ? n : n ? n.slice(0, 80) : null
}

// Meta Lead Ads: field_data is [{ name, values: [..] }]. Normalize the common fields.
export function parseLeadgenFields(fieldData = []) {
  const map = {}
  for (const f of fieldData) {
    const key = String(f?.name || '').toLowerCase()
    if (!key) continue
    map[key] = Array.isArray(f.values) ? f.values[0] : f.values
  }
  const pick = (...keys) => {
    for (const k of keys) if (map[k] != null && String(map[k]).trim() !== '') return map[k]
    return null
  }
  const phoneRaw = pick('phone_number', 'phone', 'mobile', 'mobile_number', 'contact_number')
  return {
    name: cleanName(pick('full_name', 'name', 'your_name', 'first_name')),
    phone: phoneRaw ? firstMobile(String(phoneRaw)) || String(phoneRaw).replace(/\D/g, '') : null,
    email: pick('email', 'email_address'),
    property: pick('property', 'project', 'which_property', 'interested_in', 'property_type'),
    budget: pick('budget', 'budget_range', 'your_budget'),
    city: pick('city', 'location', 'preferred_location'),
    raw: map,
  }
}

// Click-to-WhatsApp ad referral rides along the first inbound WhatsApp message.
export function extractReferral(msg) {
  const r = msg?.referral
  if (!r || (!r.ctwa_clid && !r.source_id && !r.source_type)) return null
  return {
    ctwa_clid: r.ctwa_clid || null,
    source_id: r.source_id || null,
    source_type: r.source_type || null, // 'ad' | 'post'
    source_url: r.source_url || null,
    headline: r.headline || null,
    body: r.body || null,
    media_type: r.media_type || null,
  }
}

// Meta gives a 72-hour free customer-service window for messages generated by an ad /
// free entry point (CTWA). Surface how much of it is left so agents act inside it.
const FREE_WINDOW_MS = 72 * 3600_000
export function freeEntryWindow(lead) {
  if (!lead?.free_entry_at) return null
  const expires = new Date(new Date(lead.free_entry_at).getTime() + FREE_WINDOW_MS)
  const remaining = expires.getTime() - Date.now()
  return {
    open: remaining > 0,
    expires_at: expires.toISOString(),
    hours_left: remaining > 0 ? Math.round((remaining / 3600_000) * 10) / 10 : 0,
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

// Best-effort instant WhatsApp intro to a fresh non-WhatsApp lead. The buyer hasn't
// opened a 24h window, so this must be an approved template. Returns a status string
// stored on the source event ('sent' | 'skipped:...' | 'failed:...').
async function sendLeadIntro(agent, waId, { name, sourceRef }) {
  if (!whatsappConfigured()) return 'skipped:not_configured'
  const tpl = process.env.WHATSAPP_LEAD_INTRO_TEMPLATE
  if (!tpl) return 'skipped:no_template'
  try {
    const params = [name || 'there', sourceRef || 'your enquiry', agent.business_name || agent.name || 'HomeNex']
      .map((t) => ({ type: 'text', text: String(t).slice(0, 120) }))
    await sendTemplate(
      waId,
      { name: tpl, language: process.env.WHATSAPP_LEAD_INTRO_LANG || 'en', components: [{ type: 'body', parameters: params }] },
      agent.wa_phone_number_id,
    )
    return 'sent'
  } catch (err) {
    return `failed:${err.code || err.message}`.slice(0, 80)
  }
}

// Core create-or-merge for a lead that arrived off-WhatsApp. Dedupes on external_id
// (via the source event) and on phone (via the existing lead), tags provenance, drops
// the lead onto the pipeline, and fires the instant auto-reply. Returns a summary.
export async function ingestLead({
  agent,
  channel,
  portal = null,
  external_id = null,
  name = null,
  phone,
  email = null,
  message = null,
  source_ref = null,
  source_meta = {},
  ctwa_clid = null,
  free_entry_at = null,
  raw = {},
  autoReply = true,
}) {
  const digits = phone ? normalizePhone(phone).replace(/\D/g, '') : ''
  if (digits.length < 10) {
    await createLeadSourceEvent({
      agent_id: agent?.id ?? null, channel, portal, external_id,
      status: 'failed', contact_name: name, error: 'no valid phone', raw,
    })
    return { ok: false, reason: 'no_phone' }
  }

  // Record the ingest attempt first — this is also our external_id dedupe gate.
  const { event, duplicate } = await createLeadSourceEvent({
    agent_id: agent.id, channel, portal, external_id,
    status: 'received', contact_phone: normalizePhone(phone), contact_name: name, raw,
  })
  if (duplicate) return { ok: true, duplicate: true, event, lead: null }

  const existing = await getLeadByAgentWaId(agent.id, digits)
  const lead = await upsertLead(agent.id, digits, name)
  const isNew = !existing

  // Auto-capture the buyer as a CRM contact (dedup-safe; another agent may own the number).
  try {
    const known = await getContactByPhone(digits)
    if (!known) {
      await addContact(agent.id, digits, name || normalizePhone(phone), message || null, {
        source: CONTACT_SOURCE[channel] || 'referral',
        sourceDetail: portal || channel,
      })
    }
    const contact = await getContactByPhone(digits)
    if (contact?.agent_id === agent.id) await attachLeadContact(lead.id, contact.id)
  } catch { /* number claimed elsewhere / invalid — lead still stands */ }

  // Tag the lead with its owner's team, so it reaches the shared inbox and the
  // manager views. The inbound WhatsApp path has always done this; this one never
  // did, and every lead that does NOT arrive as a WhatsApp message comes through
  // here — walk-ins, phone quick-adds, portal notification emails, Meta Lead Ads,
  // direct portal pulls. For an agency working 99acres and MagicBricks, that is
  // most of the pipeline, and it was invisible to the manager who is supposed to
  // be distributing it: absent from GET /api/team/leads, absent from the board and
  // the leaderboard, and untouchable by auto-assign or pool distribution, which
  // both answer "lead not found in this team".
  //
  // Two leads taken by the same agent on the same morning behaved differently based
  // only on how the buyer happened to make contact.
  if (isNew) await stampLeadTeam(lead.id, agent.id)

  // setLeadSourceProvenance returns the fresh row (with the contact_id just attached).
  const fresh = await setLeadSourceProvenance(lead.id, {
    source: portal || channel,
    source_channel: channel,
    source_portal: portal,
    source_ref,
    source_meta: { ...source_meta, ...(email ? { email } : {}), ...(message ? { message } : {}) },
    ctwa_clid,
    free_entry_at,
  })

  await logActivity(
    agent.id, lead.id, 'lead',
    isNew
      ? `New ${sourceLabel(channel, portal)} lead: ${name || normalizePhone(phone)}${source_ref ? ` · ${source_ref}` : ''}`
      : `${sourceLabel(channel, portal)} touch merged into ${name || normalizePhone(phone)}`,
  )

  let autoReplyStatus = 'skipped:disabled'
  if (autoReply && isNew) autoReplyStatus = await sendLeadIntro(agent, digits, { name, sourceRef: source_ref || portal })

  await updateLeadSourceEvent(event.id, {
    lead_id: lead.id,
    status: isNew ? 'created' : 'merged',
    auto_reply_status: autoReplyStatus,
  })

  return { ok: true, duplicate: false, isNew, lead: fresh, event, autoReplyStatus }
}

function sourceLabel(channel, portal) {
  if (portal) return portal
  return { meta_lead_ad: 'Lead Ad', ctwa: 'Click-to-WhatsApp', walk_in: 'walk-in', phone: 'phone', portal_api: 'portal' }[channel] || channel
}

// A wa.me deep link the agent taps to open a WhatsApp thread with a pre-filled opener.
export function waDeepLink(phone, text) {
  const digits = normalizePhone(phone).replace(/\D/g, '')
  const q = text ? `?text=${encodeURIComponent(text)}` : ''
  return `https://wa.me/${digits}${q}`
}

// ---------------------------------------------------------------------------
// Listing syndication — compose once, export portal-formatted
// ---------------------------------------------------------------------------

function formatPriceINR(paise) {
  if (paise == null) return null
  const rupees = Number(paise) / 100
  if (rupees >= 1e7) return `₹${trimZeros(rupees / 1e7)} Cr`
  if (rupees >= 1e5) return `₹${trimZeros(rupees / 1e5)} L`
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`
}
const trimZeros = (n) => String(Number(n.toFixed(2))).replace(/\.00$/, '')

const PORTALS = ['99acres', 'magicbricks', 'housing', 'nobroker']

// Portal-agnostic core plus a portal-specific field shape. `property` is a properties row.
export function formatListingForPortal(property, portal) {
  if (!PORTALS.includes(portal)) throw new Error(`unknown portal: ${portal}`)
  const price = formatPriceINR(property.price_paise)
  const bhk = property.bhk ? `${property.bhk} BHK` : null
  const area = property.size_sqft ? `${property.size_sqft} ${property.size_unit || 'sqft'}` : null
  const ppsf =
    property.price_paise && property.size_sqft
      ? `₹${Math.round(Number(property.price_paise) / 100 / property.size_sqft).toLocaleString('en-IN')}/sqft`
      : null
  const amenities = Array.isArray(property.amenities) ? property.amenities : []

  const specLine = [bhk, property.property_type, area, property.facing && `${property.facing}-facing`]
    .filter(Boolean).join(' · ')
  const description = [
    `${bhk || property.property_type || 'Property'} in ${property.locality || property.city || ''}${property.city && property.locality ? `, ${property.city}` : ''}.`.trim(),
    price ? `Priced at ${price}${ppsf ? ` (${ppsf})` : ''}.` : null,
    area ? `Carpet/built-up area ${area}.` : null,
    property.floor != null ? `Located on floor ${property.floor}${property.total_floors ? ` of ${property.total_floors}` : ''}.` : null,
    property.builder_name ? `Developed by ${property.builder_name}.` : null,
    amenities.length ? `Amenities: ${amenities.join(', ')}.` : null,
    property.rera_project_number ? `RERA: ${property.rera_project_number}.` : null,
    property.notes || null,
  ].filter(Boolean).join(' ')

  const whatsapp_text = [
    `🏠 ${bhk || ''} ${property.property_type || ''}`.trim() + (property.locality ? ` in ${property.locality}` : ''),
    price ? `💰 ${price}` : null,
    area ? `📐 ${area}` : null,
    property.facing ? `🧭 ${property.facing}-facing` : null,
    property.rera_project_number ? `✅ RERA ${property.rera_project_number}` : null,
    '📞 DM for a site visit!',
  ].filter(Boolean).join('\n')

  // Portal-specific field keys (as each portal's listing form/API expects them).
  const fieldsByPortal = {
    '99acres': {
      propertyTitle: property.title,
      propertyType: property.property_type,
      bedrooms: property.bhk,
      coveredArea: property.size_sqft,
      areaUnit: property.size_unit || 'sqft',
      expectedPrice: property.price_paise ? Number(property.price_paise) / 100 : null,
      city: property.city,
      locality: property.locality,
      facing: property.facing,
      floorNo: property.floor,
      totalFloors: property.total_floors,
      reraId: property.rera_project_number,
      amenities,
      description,
    },
    magicbricks: {
      title: property.title,
      propertyType: property.property_type,
      bhk: property.bhk,
      coveredAreaSqft: property.size_sqft,
      price: property.price_paise ? Number(property.price_paise) / 100 : null,
      city: property.city,
      locality: property.locality,
      facing: property.facing,
      floor: property.floor,
      totalFloors: property.total_floors,
      reraNumber: property.rera_project_number,
      amenities,
      description,
    },
    housing: {
      name: property.title,
      type: property.property_type,
      configuration: property.bhk ? `${property.bhk}BHK` : null,
      carpetArea: property.size_sqft,
      price: property.price_paise ? Number(property.price_paise) / 100 : null,
      city: property.city,
      locality: property.locality,
      facing: property.facing,
      floorNumber: property.floor,
      rera: property.rera_project_number,
      amenities,
      description,
    },
    nobroker: {
      title: property.title,
      propertyType: property.property_type,
      bhkType: property.bhk,
      builtUpArea: property.size_sqft,
      expectedRentOrPrice: property.price_paise ? Number(property.price_paise) / 100 : null,
      city: property.city,
      locality: property.locality,
      facing: property.facing,
      floor: property.floor,
      rera: property.rera_project_number,
      amenities,
      description,
    },
  }

  return {
    portal,
    title: property.title,
    spec: specLine,
    price_display: price,
    price_per_sqft: ppsf,
    description,
    whatsapp_text,
    fields: fieldsByPortal[portal],
  }
}

export const SYNDICATION_PORTALS = PORTALS

// Format + persist a property's listing for a portal (status 'exported').
export async function syndicateProperty(agent, property, portal) {
  const formatted = formatListingForPortal(property, portal)
  const row = await upsertSyndication(property.id, agent.id, portal, {
    status: 'exported',
    formatted,
    exported_at: new Date().toISOString(),
  })
  return { ...row, formatted }
}
