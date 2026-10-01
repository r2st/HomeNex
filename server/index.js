import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ready,
  upsertLead,
  upsertUnassignedLead,
  assignLead,
  getLead,
  getLeadForAgent,
  getAssignableLead,
  getAgent,
  getAgentsByIds,
  findAgentByPhone,
  findAgentByPhoneNumberId,
  updateAgentPhoneConfig,
  updateAgentProfileSelf,
  updateAgentPreferences,
  setAgentWaPhone,
  addMessage,
  getMessages,
  recordFirstResponse,
  applyExtraction,
  logActivity,
  listLeads,
  leadCounts,
  listActivity,
  setAiEnabled,
  listNetworkPosts,
  addNetworkPost,
  computeMatches,
  stats,
  findContactByWaId,
  recordContactMessage,
  listContacts,
  contactCount,
  getContactDetail,
  getContactByPhone,
  addContact,
  updateContact,
  deleteContact,
  attachLeadContact,
  updateLeadName,
  updateLeadCrm,
  applyAutofill,
  setLeadStage,
  listPipelineStages,
  pipelineAnalytics,
  leadStageHistory,
  propertyMatchesForLead,
  createProperty,
  listProperties,
  propertyCount,
  getProperty,
  updateProperty,
  deleteProperty,
  createFollowup,
  listFollowups,
  updateFollowup,
  createSiteVisit,
  listSiteVisits,
  updateSiteVisit,
  stampSiteVisitConfirmation,
  createCommission,
  listCommissions,
  updateCommission,
  builderReceivables,
  createCommissionInvoice,
  listCommissionInvoices,
  updateCommissionInvoice,
  createDeal,
  listDeals,
  getDeal,
  updateDeal,
  suggestRentalCommissionPaise,
  dashboard,
  logAudit,
  normalizePhone,
  serviceWindow,
  getPropertyBySlug,
  ensurePropertySlug,
  recordPropertyView,
  propertyViewStats,
  listMessageTemplates,
  createMessageTemplate,
  updateMessageTemplate,
  getMessageTemplate,
  deleteMessageTemplate,
  markLeadRead,
  assignLeadTo,
  listLeadNotes,
  addLeadNote,
  deleteLeadNote,
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
  listMediaAssets,
  getMediaAsset,
  createMediaAsset,
  deleteMediaAsset,
  recordMediaSend,
  mediaIdsSentToLead,
  listLabels,
  createLabel,
  deleteLabel,
  leadLabels,
  setLeadLabel,
  applyAutoLabel,
  createFestiveSchedule,
  listFestiveSchedules,
  cancelFestiveSchedule,
  claimDueFestiveSchedules,
  finishFestiveSchedule,
  festiveRecipients,
  computeLeadDecay,
  computeHybridScore,
  recomputeLeadScore,
  recomputeAgentScores,
  leadPageViews,
  worklist,
  propertyViewAnalytics,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  recordSend,
  sendsToday,
  contactSendStatsBatch,
  sendStatsKey,
  ensureBulkSendStarted,
  createGroup,
  listGroups,
  updateGroup,
  deleteGroup,
  groupMembers,
  addGroupMembers,
  removeGroupMember,
  autoGroupContacts,
  resolveSegment,
  findAgentByIngestToken,
  regenerateIngestToken,
  recordCtwaReferral,
  createLeadSourceEvent,
  listLeadSourceEvents,
  leadSourceStats,
  listPortalIntegrations,
  upsertPortalIntegration,
  listSyndications,
  getMeta,
  setMeta,
} from './db.js'
import { paiseToDisplay } from './money.js'
import { bookingConfirmationText } from './siteVisit.js'
import { detectConversationLanguage } from './language.js'
import { generateReply, extractLead, suggestReplies, aiConfigured, buildAutofillSuggestions } from './ai.js'
import { emiReplyFor, parseEmiQuery, formatEmiMessage } from './emi.js'
import { FESTIVALS, getFestival, personalizeGreeting } from './festivals.js'
import { renderMicroPage } from './micropage.js'
import { buildBriefing } from './briefing.js'
import { evaluateSend, warmupDailyCap } from './sendLimiter.js'
import { runDueJobs } from './scheduler.js'
import { sendText, sendMedia, markRead, whatsappConfigured, checkToken } from './whatsapp.js'
import { renderTemplate, waMediaType } from './inbox.js'
import fs from 'node:fs'
import { privacyPage, termsPage } from './legal.js'
import { setupGuidePage } from './setupGuide.js'
import { signup, login, changePhone, changePassword, requestPasswordReset, resetPassword, requireAuth } from './auth.js'
import { handleAgentCommand } from './agentCommands.js'
import adminRouter from './adminRoutes.js'
import teamRouter from './teamRoutes.js'
import { getAgentTeam, pickRoundRobin, stampLeadTeam, teamLeadOwnerForWaId } from './db.js'
import {
  createTicket,
  listTickets,
  getTicket,
  addTicketMessage,
  billingOverview,
  getInvoice,
  requestTemplateReview,
} from './adminPortal.js'
import {
  ingestAddress,
  parsePortalEmail,
  parseLeadgenFields,
  extractReferral,
  ingestLead,
  freeEntryWindow,
  waDeepLink,
  syndicateProperty,
  formatListingForPortal,
  SYNDICATION_PORTALS,
} from './leadSources.js'
import { fetchLeadgenData } from './whatsapp.js'
import { dbPing, closePool } from './db.js'
import {
  securityHeaders, cors, requestLogger, rateLimit, clientIp, errorCodes, validateIdParams,
  ensureBody, boundedText, TEXT, boundedNumber, NUM, boundedUrl,
} from './middleware.js'
import { validateEnv } from './env.js'
import { verifyWebhookSignature, verifyWebhookChallenge } from './webhookSignature.js'

const { PORT = 8787, WHATSAPP_APP_SECRET } = process.env

// Fail fast on a misconfigured production deploy; only warn in dev/test.
const envCheck = validateEnv(process.env)
for (const w of envCheck.warnings) console.warn('⚠ ' + w)
// Unreachable in-process: importing this module under `node --test` means NODE_ENV is
// 'test' and the config is the valid one the suite set up, so the body never runs.
// It is not untested — bootstrap.test.js boots a real child on a broken production
// config and asserts both the message and the exit code. What that test cannot do is
// pay for the lines, because a child's V8 profile is deliberately kept out of the merge
// (childEnv() in test/helpers.js). Excluded here so the report says "not measured here"
// rather than borrowing a number from a race.
/* node:coverage ignore next 7 */
if (!envCheck.ok) {
  for (const e of envCheck.errors) console.error('✖ config error: ' + e)
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to start with an invalid production configuration.')
    process.exit(1)
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// Express 4 doesn't forward rejected-promise errors from async handlers; wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// Copy only the defined keys of an allowlist — buildSet in db.js writes NULL for
// keys that are present-but-undefined, so absent fields must stay absent.
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]))

// Postgres errors that mean "the client sent a bad value", not "the server broke":
// check violation, foreign key violation, invalid text -> int/timestamp casts.
const pgBadRequest = (err) => ['23514', '23503', '22P02', '22007', '22008', '22003'].includes(err.code)

// Media library uploads land here and are served publicly at /uploads (WhatsApp must
// be able to fetch them by URL). PUBLIC_BASE_URL makes the stored URL absolute so a
// link-based media send works in production; it falls back to a relative path (fine
// for same-origin display and for tests where WhatsApp is unconfigured).
const UPLOAD_DIR = path.join(__dirname, 'uploads')
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'application/pdf': 'pdf' }
// /uploads is served by express.static same-origin (WhatsApp and the dashboard both
// need a plain URL), so express derives the response Content-Type from this file
// extension alone. Without an allowlist, an authenticated agent could upload
// something like a .html/.svg file and get it served back as text/html/image+xml on
// our own origin — a same-origin stored-XSS vector that could steal another agent's
// (or an admin's) session token. Only file types the product actually needs
// (photos/brochures/videos/spreadsheets) make it to disk.
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', // images
  'mp4', 'mov', // video
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', // documents
])
// Base64 inflates raw bytes by ~4/3, so the 25MB express.json() body cap already caps
// a decoded upload at ~18.75MB before this ever runs (a bigger payload 413s at the
// body-parser). This is a lower, cleaner ceiling with headroom for the JSON wrapper,
// enforced here so the error is a clear 400 rather than depending on that arithmetic.
const UPLOAD_SIZE_LIMIT_BYTES = 15 * 1024 * 1024 // 15MB decoded

// Write a base64 (or data-URL) payload to the uploads dir under a random name and
// return its public URL, canonical filename, mime and byte size. Throws on an empty
// payload, an oversized payload, or a file extension outside ALLOWED_UPLOAD_EXTENSIONS.
function saveUpload(dataBase64, filename, mime) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  let b64 = String(dataBase64)
  const m = b64.match(/^data:([^;]+);base64,(.*)$/s)
  if (m) {
    mime = mime || m[1]
    b64 = m[2]
  }
  const buf = Buffer.from(b64, 'base64')
  if (!buf.length) throw new Error('empty upload')
  if (buf.length > UPLOAD_SIZE_LIMIT_BYTES) {
    const err = new Error(`File too large — max ${UPLOAD_SIZE_LIMIT_BYTES / (1024 * 1024)}MB`)
    err.code = 'UPLOAD_TOO_LARGE'
    throw err
  }
  const extFromName = filename && path.extname(filename).replace(/^\./, '')
  const ext = (extFromName || EXT_BY_MIME[mime] || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    const err = new Error(`Unsupported file type${ext ? `: .${ext}` : ''} — allowed: images, video, PDF, Office documents`)
    err.code = 'UPLOAD_TYPE_REJECTED'
    throw err
  }
  const stored = `${crypto.randomBytes(12).toString('hex')}.${ext}`
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf)
  return { url: `${PUBLIC_BASE_URL}/uploads/${stored}`, filename: filename || stored, mime: mime || null, size: buf.length }
}

// nginx sits in front in production; trust one proxy hop so req.ip / rate-limit keys
// and secure-cookie logic see the real client address, not the proxy's.
app.set('trust proxy', 1)
// Don't advertise Express (minor fingerprinting reduction).
app.disable('x-powered-by')

// Cross-cutting middleware runs before any route: safe security headers on every
// response, optional CORS (off unless CORS_ORIGIN is set), a stable machine-readable
// `code` on every error body, and a compact access log (silent under test /
// LOG_REQUESTS=0).
app.use(securityHeaders)
app.use(cors())
app.use(errorCodes)
// Same shape as the config check above: the guard's whole purpose is that it is false
// under test, so the mount cannot run in-process. serverProcess.test.js boots a child
// with LOG_REQUESTS=1 and asserts an access log line comes out; middleware.test.js
// covers requestLogger() itself, including the no-argument form mounted here.
/* node:coverage ignore next 3 */
if (process.env.NODE_ENV !== 'test' && process.env.LOG_REQUESTS !== '0') {
  app.use(requestLogger())
}

const captureRawBody = (req, _res, buf) => {
  req.rawBody = buf
}

// The 25MB ceiling below exists for exactly one caller — the media library, which
// posts a photo as base64 — and it was being extended to the two public ingest routes,
// which post a lead. A lead is a few hundred bytes. That gap mattered because the
// ingest token is not a secret: it is the local part of the address agents publish on
// their 99acres and MagicBricks listings, so anyone who can read a listing can post
// here. /ingest/portal then stores the WHOLE body as JSONB (`raw: b`), and boundedText
// only measures the named string fields, so the bulk travels in an unlisted key and
// lands on disk untouched. 25MB a request at 240 requests a minute is a disk-filling
// primitive, not a lead.
//
// Mounted before the general parser: body-parser marks a request parsed and the later
// one skips it, so /ingest gets this limit and answers 413 above it. 2MB is generous
// against the largest thing the routes themselves permit — /ingest/email bounds `text`
// and `html` at 512KB each, and JSON escaping inflates — while being 12x tighter than
// what it replaces.
app.use('/ingest', express.json({ limit: '2mb', verify: captureRawBody }))
// Same argument for /webhook, and it bites harder: the signature check that makes this
// route Meta-only lives INSIDE the handler, so the parse happens first. Every caller on
// the internet — signature or not — can make the server buffer 25MB and JSON.parse it
// before verifySignature gets a say and answers 401. Parsing is synchronous, so that is
// the event loop, and /healthz stops answering with it.
//
// 1MB against a real Meta payload: a batched `entry[]` of message events is a few KB,
// and a leadgen change carries an id rather than the answers (processLeadgen fetches
// those from the Graph API). So this is ~100x the largest thing Meta actually sends and
// 25x tighter than what it replaces.
app.use('/webhook', express.json({ limit: '1mb', verify: captureRawBody }))
app.use(
  express.json({
    limit: '25mb', // media library uploads arrive as base64 JSON
    verify: captureRawBody,
  }),
)
// Immediately after the parser, so every handler below can read req.body as an
// object without saying so itself. See ensureBody for why it is not simply assumed.
app.use(ensureBody)

// Rate limits on the routes an anonymous caller can reach. Auth is tight (blunts
// credential stuffing); the public ingest/webhook endpoints get a higher ceiling so
// a legitimate portal/Meta burst isn't dropped. Kept as handles so shutdown can stop
// their sweeps.
//
// The suite signs hundreds of agents up in a few seconds, so a 20/minute ceiling
// would throttle the tests rather than the attacker — hence off by default under
// test. But "off under test" meant the WIRING had no coverage at all: the limiter
// itself is well tested as a unit in hardening.test.js, while the part that can
// actually regress silently — whether /api/auth is still the path it is mounted on —
// was never executed. Renaming a route or reordering these lines would disarm the
// login limiter and no test would notice.
//
// So the threshold is drivable from the environment, exactly as UPLOAD_RATE_LIMIT
// already is for uploads: a test sets AUTH_RATE_LIMIT to something small and drives
// the real mounted middleware. Unset, behaviour is unchanged in both directions —
// 20/minute in production, off under test.
const rateLimiters = []
const authRateLimit = Number(process.env.AUTH_RATE_LIMIT) > 0 ? Number(process.env.AUTH_RATE_LIMIT) : null
const pageRateLimit = Number(process.env.PAGE_RATE_LIMIT) > 0 ? Number(process.env.PAGE_RATE_LIMIT) : null
if (process.env.NODE_ENV !== 'test' || authRateLimit || pageRateLimit) {
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: authRateLimit ?? 20,
    message: 'Too many attempts — please wait a minute and try again.',
  })
  const ingestLimiter = rateLimit({ windowMs: 60_000, max: 240 })
  // /p/:slug is the third anonymous route that costs us something per request, and it
  // was the one without a ceiling. It is not a read: every hit INSERTs a row into
  // property_page_views and bumps properties.page_views, so anyone holding a slug —
  // and slugs are meant to be pasted into broker WhatsApp groups — can both grow the
  // table without bound and forge the engagement number the agent uses to decide which
  // listing is working. "94 views this week" is a decision an agent acts on.
  //
  // Same ceiling and reasoning as ingest: generous enough that a link genuinely doing
  // the rounds of a group is never throttled (real viewers arrive on their own mobile
  // IPs; this is per-IP), low enough that one client cannot sit on it in a loop.
  const pageLimiter = rateLimit({ windowMs: 60_000, max: pageRateLimit ?? 240 })
  rateLimiters.push(authLimiter, ingestLimiter, pageLimiter)
  app.use('/api/auth', authLimiter)
  app.use('/webhook', ingestLimiter)
  app.use('/ingest', ingestLimiter)
  app.use('/p', pageLimiter)
}

// Uploads are the one authenticated request that both costs real disk and accepts a
// 25MB body, so they get their own ceiling — keyed by agent id, not IP, because the
// cost lands on us per account and a whole office can share one NAT address. This one
// stays on under test (the suite uploads a handful of files, well under the ceiling);
// UPLOAD_RATE_LIMIT makes the threshold drivable from a test.
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.UPLOAD_RATE_LIMIT) > 0 ? Number(process.env.UPLOAD_RATE_LIMIT) : 60,
  // Both routes wearing this limiter sit under the `/api` requireAuth middleware,
  // so req.agent is always populated by the time the key is computed. The IP arm is
  // the correct key for an unauthenticated upload route, if one is ever added.
  /* node:coverage ignore next */
  key: (req) => (req.agent ? `agent:${req.agent.id}` : `ip:${clientIp(req)}`),
  message: 'Too many uploads — please wait a minute before uploading more files.',
})
rateLimiters.push(uploadLimiter)

// Publicly serve uploaded media so WhatsApp (and the dashboard) can fetch it by URL.
app.use('/uploads', express.static(UPLOAD_DIR))

// Lightweight liveness/readiness probe for load balancers and uptime monitors.
// No auth, no external Graph API call — just "is the process up and can it reach the
// database". 200 when healthy, 503 when the DB is unreachable so an orchestrator can
// pull the node out of rotation. (Rich WhatsApp/AI status stays on /api/health.)
app.get('/healthz', (_req, res) => {
  dbPing()
    .then(() => res.json({ ok: true, db: true, uptime: Math.round(process.uptime()) }))
    .catch((err) => {
      console.error('healthz db ping failed', err.message)
      res.status(503).json({ ok: false, db: false })
    })
})

// NODE_ENV is read per-request rather than captured at import so the fail-closed
// branch is observable in tests (and so a process that boots before its environment
// is finalised can't get stuck on the permissive answer).
function verifySignature(req) {
  return verifyWebhookSignature({
    secret: WHATSAPP_APP_SECRET,
    isProd: process.env.NODE_ENV === 'production',
    signature: req.get('x-hub-signature-256'),
    rawBody: req.rawBody,
  })
}

// Core pipeline for one inbound buyer message on the shared WhatsApp number:
// persist -> AI reply -> WhatsApp send (from the shared number) -> extract BLTC.
// agentId is null for the unassigned pool (an unknown sender); brokerName personalises the AI.
// waMessageId is Meta's id for this inbound message. Meta redelivers webhook events on
// any ack hiccup (slow response, network blip, restart mid-request) — without a dedupe
// check the same buyer message would be persisted, AI-replied-to and extracted twice.
// The buyer message is inserted FIRST (before any AI/send work) so a unique-constraint
// conflict on wa_message_id (migration 015) lets us detect "already processed" and bail
// out before doing anything expensive or user-visible a second time.
async function handleInbound({ agentId = null, brokerName, waId, name, text, source = 'WhatsApp', phoneNumberId = null, send = true, referral = null, waMessageId = null }) {
  const lead = agentId ? await upsertLead(agentId, waId, name) : await upsertUnassignedLead(waId, name)
  const isNewLead = !lead.ai_summary && (await getMessages(lead.id, 1)).length === 0
  if (waMessageId) {
    try {
      await addMessage(lead.id, 'buyer', text, waMessageId)
    } catch (err) {
      if (err.code === '23505') return { lead, reply: null, duplicate: true }
      throw err
    }
  } else {
    await addMessage(lead.id, 'buyer', text)
  }
  // Click-to-WhatsApp attribution: capture the ad referral and (re)open the 72h free window.
  if (referral) {
    await recordCtwaReferral(lead.id, referral)
    if (isNewLead) {
      await createLeadSourceEvent({
        agent_id: agentId, lead_id: lead.id, channel: 'ctwa',
        external_id: referral.ctwa_clid || null, status: 'created',
        contact_phone: waId, contact_name: name,
        auto_reply_status: 'sent', raw: referral,
      }).catch(() => {})
      await logActivity(agentId, lead.id, 'lead',
        `Click-to-WhatsApp lead: ${name || waId}${referral.headline ? ` · "${referral.headline}"` : ''}`)
    }
  }
  await recordContactMessage(waId) // stamp first/last message time on the CRM contact, if known
  // CRM: link the lead to its auto-captured contact and drop it into the pipeline.
  if (agentId) {
    const contact = await getContactByPhone(waId)
    if (contact?.agent_id === agentId) await attachLeadContact(lead.id, contact.id)
    // Team members: tag the lead so it shows up in the team's shared inbox and
    // manager views. Only needed once, when the lead is first created.
    if (isNewLead) await stampLeadTeam(lead.id, agentId)
  }
  if (isNewLead) {
    await logActivity(agentId, lead.id, 'lead', agentId
      ? `New lead: ${name || waId} via ${source}`
      : `Unclaimed lead: ${name || waId} messaged the shared number`)
    if (agentId) await applyAutoLabel(lead.id, agentId, 'new')
  }

  let reply = null
  if (lead.ai_enabled) {
    // EMI questions get an instant, deterministic calculation — no AI round-trip,
    // and it works even when the AI provider is down.
    reply = emiReplyFor(text) || (await generateReply(await getMessages(lead.id), brokerName, lead))
    if (reply) {
      let waMsgId = null
      if (send) {
        try {
          waMsgId = await sendText(waId, reply, phoneNumberId)
        } catch (err) {
          console.error('agent reply send failed', err.message)
          const note = err.code === 'WA_TOKEN_EXPIRED'
            ? `WhatsApp token expired — reply to ${name || waId} not delivered`
            : `WhatsApp send failed for ${name || waId}`
          await logActivity(agentId, lead.id, 'error', note)
        }
      }
      await addMessage(lead.id, 'ai', reply, waMsgId)
      await recordFirstResponse(lead.id)
    }
  }

  // Best-effort structured extraction after every buyer message.
  try {
    const prevTemp = lead.temp
    const x = await extractLead(await getMessages(lead.id))
    if (x) {
      await applyExtraction(lead.id, x)
      const updated = await getLead(lead.id)
      if (updated.temp === 'Hot' && prevTemp !== 'Hot') {
        await logActivity(agentId, lead.id, 'hot', `${updated.name || waId} is now HOT (score ${updated.score})`)
        if (agentId) await applyAutoLabel(lead.id, agentId, 'hot')
      } else if (x.score != null)
        await logActivity(agentId, lead.id, 'ai', `${updated.name || waId} re-scored: ${updated.score}/100`)
      // A buyer who identifies as a broker/dealer gets the Broker label automatically.
      if (agentId && x.intent === 'broker') await applyAutoLabel(lead.id, agentId, 'broker')
    }
  } catch (err) {
    console.error('extraction failed', err)
  }

  return { lead: await getLead(lead.id), reply }
}

// Turn any inbound WhatsApp message type into readable text so nothing is silently
// dropped from the conversation/lead-capture pipeline. We don't download the actual
// media (a bigger feature — needs Graph media-URL auth + storage); a placeholder is
// enough for the message to be recorded, show up in the inbox, and prompt a human
// follow-up. Returns null for message types with no useful text (reactions, system
// messages, unrecognised/unsupported types), which the caller skips entirely.
export function inboundMessageText(msg) {
  switch (msg.type) {
    case 'text':
      return msg.text?.body || null
    case 'image':
      return msg.image?.caption ? `📷 ${msg.image.caption}` : '📷 Photo'
    case 'video':
      return msg.video?.caption ? `🎥 ${msg.video.caption}` : '🎥 Video'
    case 'document':
      return `📄 Document${msg.document?.filename ? `: ${msg.document.filename}` : ''}`
    case 'audio':
      return msg.audio?.voice ? '🎤 Voice message' : '🎵 Audio'
    case 'sticker':
      return '💬 Sticker'
    case 'location':
      return msg.location?.name ? `📍 Shared location: ${msg.location.name}` : '📍 Shared location'
    case 'contacts':
      return '👤 Shared a contact'
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null
    case 'button':
      return msg.button?.text || null
    default:
      return null
  }
}

// Decide which agent handles an inbound on a team member's line. Solo agents (and
// any strategy other than round-robin) always keep their own line. For a round-robin
// team, a returning sender stays with their existing owner; a new sender goes to the
// next member in rotation. Returns the resolved agent record.
async function resolveTeamLineAgent(lineOwner, waId) {
  const team = await getAgentTeam(lineOwner.id)
  if (!team || team.assignment_strategy !== 'round_robin') return lineOwner
  const existingOwnerId = await teamLeadOwnerForWaId(team.id, waId)
  // The id came from a join through team_members, so the agent row exists; the
  // `|| lineOwner` is the safe answer if it were deleted between the two queries.
  /* node:coverage ignore next */
  if (existingOwnerId) return (await getAgent(existingOwnerId)) || lineOwner
  const pickedId = await pickRoundRobin(team.id)
  return pickedId && pickedId !== lineOwner.id ? (await getAgent(pickedId)) || lineOwner : lineOwner
}

// Attribute a Meta Lead Ads leadgen to an agent: a form_id→agent map (set via the
// Lead Sources screen) wins, else the configured default agent, else unmatched.
async function resolveLeadgenAgent(formId) {
  if (formId) {
    const mapped = await getMeta(`leadgen_form:${formId}`)
    if (mapped) return getAgent(Number(mapped))
  }
  const dflt = process.env.META_LEADGEN_DEFAULT_AGENT_ID
  return dflt ? getAgent(Number(dflt)) : null
}

// Turn one Meta Lead Ads leadgen change into a CRM lead. The webhook only carries a
// leadgen_id, so the answers are fetched from the Graph API (needs a Page access token).
async function processLeadgen(value) {
  const leadgenId = value?.leadgen_id
  const formId = value?.form_id
  if (!leadgenId) return
  const agent = await resolveLeadgenAgent(formId)
  const data = await fetchLeadgenData(leadgenId)
  const parsed = data?.field_data ? parseLeadgenFields(data.field_data) : {}
  const raw = { value, field_data: data?.field_data || null, ad_name: data?.ad_name }

  if (!agent) {
    await createLeadSourceEvent({
      agent_id: null, channel: 'meta_lead_ad', external_id: leadgenId, status: 'unmatched',
      contact_name: parsed.name || null, error: `no agent mapped for form ${formId || '?'}`, raw,
    }).catch(() => {})
    return
  }
  if (!parsed.phone) {
    await createLeadSourceEvent({
      agent_id: agent.id, channel: 'meta_lead_ad', external_id: leadgenId, status: 'failed',
      contact_name: parsed.name || null, error: 'no phone in leadgen (Page access token configured?)', raw,
    }).catch(() => {})
    return
  }
  await ingestLead({
    agent, channel: 'meta_lead_ad', external_id: leadgenId,
    name: parsed.name, phone: parsed.phone, email: parsed.email,
    source_ref: parsed.property || data?.ad_name || null,
    message: parsed.property ? `Interested in ${parsed.property}` : null,
    source_meta: {
      ad_id: value?.ad_id || data?.ad_id, ad_name: data?.ad_name, form_id: formId,
      campaign_id: value?.campaign_id || data?.campaign_id, city: parsed.city, budget: parsed.budget,
    },
    raw,
  })
}

// --- Meta webhook verification (GET) ---
app.get('/webhook', (req, res) => {
  // NODE_ENV is read per request, not captured at import, for the same reason the
  // signature check does it: the fail-closed arm is the one that must not be baked in
  // by whatever the environment happened to be when the module loaded.
  const ok = verifyWebhookChallenge({
    configured: process.env.WHATSAPP_VERIFY_TOKEN,
    isProd: process.env.NODE_ENV === 'production',
    mode: req.query['hub.mode'],
    presented: req.query['hub.verify_token'],
  })
  if (!ok) return res.sendStatus(403)
  // text/plain, deliberately. This route's whole job is to echo a caller-supplied
  // string back, and res.send(aString) labels it text/html — which makes /webhook a
  // reflected-XSS sink on the very origin that serves the SPA and stores agent tokens,
  // for anyone who clears the handshake. Meta compares the body bytes and does not
  // care what they are labelled, so nothing is lost by saying what this actually is.
  res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''))
})

// --- Real incoming WhatsApp messages (POST) ---
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401)
  res.sendStatus(200) // ack fast; Meta retries on timeout

  ;(async () => {
    for (const entry of req.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        // Meta Lead Ads: a leadgen webhook carries only a leadgen_id — fetch the answers
        // and turn them into a lead with an instant templated WhatsApp reply.
        if (change.field === 'leadgen') {
          for (const lg of Array.isArray(value) ? value : [value]) {
            await processLeadgen(lg).catch((err) => console.error('leadgen processing error', err.message))
          }
          continue
        }
        const waProfileName = value?.contacts?.[0]?.profile?.name
        // Which WhatsApp Business number received this message?
        const phoneNumberId = value?.metadata?.phone_number_id
        // Per-agent routing: if this phone_number_id belongs to a specific agent,
        // every message on that line belongs to them (no shared pool needed).
        const lineOwner = await findAgentByPhoneNumberId(phoneNumberId)
        for (const msg of value?.messages ?? []) {
          // One message must not take the rest of the delivery with it. Meta batches
          // messages into a single POST, and everything below runs in one shared async
          // block — so before this, a throw on the first message abandoned the second
          // and third silently. That is unrecoverable rather than merely lossy: the 200
          // was already sent above (Meta retries on timeout, so the ack has to be fast),
          // so Meta considers the whole batch delivered and never sends it again. The
          // buyer's enquiry is simply gone, with nothing in the inbox to show for it.
          //
          // Real triggers are ordinary: a payload with no `from` (wa_id is NOT NULL, so
          // upsertLead throws), a deadlock on one lead's row, a failure inside one
          // agent command. None of them are reasons to drop a different buyer's message.
          // The leadgen arm above already works this way — per item, not per batch.
          try {
            // FIRST: is the sender one of our registered agents? Then this is an agent
            // command (add a client, list clients, ...), not a buyer conversation.
            const agent = await findAgentByPhone(msg.from)
            if (agent) {
              markRead(msg.id, phoneNumberId)
              await handleAgentCommand({ agent, msg, phoneNumberId })
              continue
            }
            // Non-text messages (photos, documents, voice notes, location, button/list
            // taps, ...) used to be silently dropped — the buyer's message vanished with
            // no record and no reply. We don't download/store the media itself, but a
            // readable placeholder keeps the conversation and lead-capture pipeline
            // intact so a human agent can follow up. Reactions and other message types
            // with no useful text (unsupported/system/order) are still skipped.
            const text = inboundMessageText(msg)
            if (!text) continue
            markRead(msg.id, phoneNumberId)
            // Click-to-WhatsApp ads attach a referral to the opening message.
            const referral = extractReferral(msg)

            // Per-agent line: if this number belongs to a specific agent, route directly
            // to them. When that agent runs a round-robin team, a brand-new sender is
            // handed to the next member instead; a returning sender stays with whoever
            // already owns them. The sender is auto-remembered as a contact of whoever
            // ends up handling them.
            if (lineOwner) {
              const assignee = await resolveTeamLineAgent(lineOwner, msg.from)
              try {
                await addContact(assignee.id, msg.from, waProfileName || msg.from)
                await logActivity(assignee.id, null, 'lead', `Auto-added client: ${waProfileName || msg.from} (${msg.from})`)
              } catch { /* already exists */ }
              await handleInbound({
                agentId: assignee.id,
                brokerName: assignee.name,
                waId: msg.from,
                name: waProfileName,
                text,
                phoneNumberId,
                referral,
                waMessageId: msg.id,
              })
              continue
            }

            // Shared-number fallback: match the sender against every agent's saved clients.
            const contact = await findContactByWaId(msg.from)
            if (contact) {
              await handleInbound({
                agentId: contact.agent_id,
                brokerName: (await getAgent(contact.agent_id))?.name,
                waId: msg.from,
                name: contact.name || waProfileName,
                text,
                phoneNumberId,
                referral,
                waMessageId: msg.id,
              })
            } else {
              // Unknown sender on a shared number → unassigned pool, visible to all agents to claim.
              await handleInbound({
                agentId: null,
                brokerName: 'the HomeNex team',
                waId: msg.from,
                name: waProfileName,
                text,
                phoneNumberId,
                referral,
                waMessageId: msg.id,
              })
            }
          } catch (err) {
            console.error('inbound message processing error', msg?.id, err.message)
          }
        }
      }
    }
  })().catch((err) => console.error('webhook processing error', err))
})

// --- Portal lead ingestion by email (§1.7) ---
// Each workspace has a unique address  lead-<token>@<domain>  that agents set as the
// contact email on 99acres/MagicBricks/Housing. An email provider's inbound-parse
// webhook (Mailgun / SendGrid / Cloudflare Email Worker) POSTs the message here as JSON:
//   { from, to, subject, text, html }
//
// Bounded like every other body-accepting route, and the only public one that wasn't:
// this is the endpoint that hands an unauthenticated caller's text to the regex chain
// in parsePortalEmail. See TEXT.EMAIL_PART for what that costs unbounded.
app.post('/ingest/email/:token', boundedText({
  from: TEXT.BLURB, subject: TEXT.BLURB, text: TEXT.EMAIL_PART, html: TEXT.EMAIL_PART,
}), ah(async (req, res) => {
  const agent = await findAgentByIngestToken(req.params.token)
  if (!agent) return res.status(404).json({ error: 'unknown ingest address' })
  const { from = '', subject = '', text = '', html = '' } = req.body
  const parsed = parsePortalEmail({ from, subject, text, html })
  if (!parsed || !parsed.phone) {
    await createLeadSourceEvent({
      agent_id: agent.id, channel: 'portal_email', status: 'failed',
      error: 'no contact phone parsed from email', raw: { from, subject },
    }).catch(() => {})
    return res.status(202).json({ ok: false, reason: 'no_lead_parsed' })
  }
  const result = await ingestLead({
    agent, channel: 'portal_email', portal: parsed.portal, external_id: parsed.external_id,
    name: parsed.name, phone: parsed.phone, email: parsed.email,
    source_ref: parsed.property, message: parsed.message,
    source_meta: { budget: parsed.budget, subject, from },
    raw: { from, subject, text: String(text || '').slice(0, 4000) },
  })
  res.json({
    ok: result.ok !== false, duplicate: Boolean(result.duplicate),
    lead_id: result.lead?.id || null, portal: parsed.portal, auto_reply: result.autoReplyStatus || null,
  })
}))

// --- Direct portal API / push integration (§5.2) ---
// A portal (or Zapier/middleware bridge) pushes a structured lead as JSON, keyed by the
// workspace ingest token and portal:  { name, phone, email, property, message, budget, external_id }
app.post('/ingest/portal/:token/:portal', boundedText({
  name: TEXT.LINE, phone: TEXT.LINE, email: TEXT.LINE, external_id: TEXT.LINE,
  lead_id: TEXT.LINE, property: TEXT.BLURB, project: TEXT.BLURB, message: TEXT.PROSE,
}), ah(async (req, res) => {
  const agent = await findAgentByIngestToken(req.params.token)
  if (!agent) return res.status(404).json({ error: 'unknown ingest token' })
  const portal = req.params.portal
  if (!SYNDICATION_PORTALS.includes(portal)) return res.status(400).json({ error: 'unknown portal' })
  const b = req.body
  if (!b.phone) return res.status(400).json({ error: 'phone required' })
  const result = await ingestLead({
    agent, channel: 'portal_api', portal, external_id: b.external_id || b.lead_id || null,
    name: b.name || null, phone: b.phone, email: b.email || null,
    source_ref: b.property || b.project || null, message: b.message || null,
    source_meta: { budget: b.budget || null, config: b.config || null, city: b.city || null },
    raw: b,
  })
  res.json({
    ok: result.ok !== false, duplicate: Boolean(result.duplicate),
    lead_id: result.lead?.id || null, auto_reply: result.autoReplyStatus || null,
  })
}))

// --- Auth: one-screen signup (name, phone, email, password) and login ---
//
// The only two routes an anonymous caller can POST a body to other than the ingest
// pair, and until now the only body-accepting routes in the app wearing no bound at
// all — so every field here arrived with express.json()'s 25MB ceiling as its only
// limit. Each one is then handed to something that charges by the character: `email`
// to the address check (see isValidEmail for what that used to cost), `password` to
// scryptSync, `phone` to normalizePhone's four passes and then to Postgres.
const AUTH_TEXT_LIMITS = {
  name: TEXT.LINE, phone: TEXT.LINE, email: TEXT.LINE,
  password: TEXT.PASSWORD, wa_phone_number: TEXT.LINE,
}

app.post('/api/auth/signup', boundedText(AUTH_TEXT_LIMITS), ah(async (req, res) => {
  try {
    res.json(await signup(req.body))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

app.post('/api/auth/login', boundedText(AUTH_TEXT_LIMITS), ah(async (req, res) => {
  try {
    res.json(await login(req.body))
  } catch (err) {
    // 403, not 401: the credentials were right, the account is suspended.
    res.status(err.code === 'DEACTIVATED' ? 403 : 401).json({ error: err.message })
  }
}))

app.post('/api/auth/request-reset', boundedText({ phone: TEXT.LINE }), ah(async (req, res) => {
  try {
    const { agentId, code, phone } = await requestPasswordReset(req.body)
    // Send the code via WhatsApp if configured, otherwise return it for dev/test.
    try {
      const { sendText, whatsappConfigured } = await import('./whatsapp.js')
      if (whatsappConfigured()) {
        await sendText(phone, `Your HomeNex password reset code is: ${code}\n\nIt expires in 15 minutes. If you didn't request this, ignore this message.`)
      }
    } catch { /* WhatsApp not available — code still stored for manual recovery */ }
    res.json({ agentId, sent: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

app.post('/api/auth/reset-password', boundedText({ agentId: TEXT.LINE, code: TEXT.LINE, newPassword: TEXT.PASSWORD }), ah(async (req, res) => {
  try {
    res.json(await resetPassword(req.body))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.agent))

// Everything below requires a logged-in agent.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  requireAuth(req, res, next)
})

// Agent changes their own WhatsApp (login) number. Requires the current password.
const PHONE_ERROR_STATUS = { BAD_PASSWORD: 403, PHONE_TAKEN: 409, NOT_FOUND: 404 }
app.put('/api/agent/phone', boundedText({ phone: TEXT.LINE, password: TEXT.PASSWORD }), ah(async (req, res) => {
  const { phone, password } = req.body
  const previous = req.agent.phone
  try {
    const agent = await changePhone(req.agent.id, { phone, password })
    if (agent.phone !== previous) {
      await logAudit(agent.id, 'agent', agent.id, 'phone_changed', { from: previous, to: agent.phone })
    }
    res.json(agent)
  } catch (err) {
    res.status(PHONE_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// Agent changes their own password. Requires the current password.
const PASSWORD_ERROR_STATUS = { BAD_PASSWORD: 403, WEAK_PASSWORD: 400, SAME_PASSWORD: 400, NOT_FOUND: 404 }
// Both fields reach scryptSync, and this route runs it up to three times (verify the
// current one, check the new one isn't the same, hash the new one) — so it is the most
// expensive password route in the app and was the least bounded.
app.put('/api/agent/password', boundedText({ current_password: TEXT.PASSWORD, new_password: TEXT.PASSWORD }), ah(async (req, res) => {
  const { current_password, new_password } = req.body
  try {
    // The change signs every other device out, so the caller gets a token signed
    // with the new version back — without it this device would 401 on its next
    // request, having just been logged out by its own password change.
    const { agent, token } = await changePassword(req.agent.id, { current_password, new_password })
    await logAudit(agent.id, 'agent', agent.id, 'password_changed', {})
    res.json({ ...agent, token })
  } catch (err) {
    res.status(PASSWORD_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// Agent edits their own profile. Phone lives on PUT /api/agent/phone (password-gated).
const PROFILE_FIELDS = ['name', 'email', 'business_name', 'city', 'bio', 'rera_id', 'rera_state', 'rera_expiry', 'avatar_url']
const PROFILE_ERROR_STATUS = { EMAIL_TAKEN: 409, NOT_FOUND: 404 }
// No boundedText here: updateAgentProfileSelf already caps every one of these, and
// does it better — its limits are per-field (name 80, bio 500, RERA id 64) and its
// message names the field the way the form labels it.
app.put('/api/agent/profile', ah(async (req, res) => {
  const fields = pick(req.body, PROFILE_FIELDS)
  try {
    const agent = await updateAgentProfileSelf(req.agent.id, fields)
    // The photo is a data: URI — log which fields moved, never their contents.
    await logAudit(agent.id, 'agent', agent.id, 'profile_updated', { fields: Object.keys(fields) })
    res.json(agent)
  } catch (err) {
    res.status(PROFILE_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// Locale and notification preferences.
const PREFERENCE_FIELDS = [
  'timezone',
  'language',
  'notify_new_lead',
  'notify_followup_due',
  'notify_daily_digest',
  'quiet_hours_start',
  'quiet_hours_end',
]
app.put('/api/agent/preferences', boundedText({ timezone: TEXT.LINE, language: TEXT.LINE }), ah(async (req, res) => {
  const fields = pick(req.body, PREFERENCE_FIELDS)
  try {
    const agent = await updateAgentPreferences(req.agent.id, fields)
    await logAudit(agent.id, 'agent', agent.id, 'preferences_updated', fields)
    res.json(agent)
  } catch (err) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message })
  }
}))

// --- Per-agent WhatsApp Business number configuration ---
app.get('/api/agent/phone-config', ah(async (req, res) => {
  const agent = await getAgent(req.agent.id)
  res.json({
    wa_phone_number: agent.wa_phone_number || null,
    wa_phone_number_id: agent.wa_phone_number_id || null,
  })
}))

// wa_phone_number is normalised down to digits before it is stored, but
// wa_phone_number_id is written to its column exactly as it arrives.
app.put('/api/agent/phone-config', boundedText({ wa_phone_number: TEXT.LINE, wa_phone_number_id: TEXT.LINE }), ah(async (req, res) => {
  const { wa_phone_number, wa_phone_number_id } = req.body
  try {
    const agent = await updateAgentPhoneConfig(req.agent.id, wa_phone_number || null, wa_phone_number_id || null)
    res.json(agent)
  } catch (err) {
    res.status(err.code === 'PHONE_ID_TAKEN' ? 409 : 400).json({ error: err.message })
  }
}))

// Agent sets/updates their WA Business phone number (for WABA registration).
app.put('/api/agent/wa-phone', boundedText({ wa_phone_number: TEXT.LINE }), ah(async (req, res) => {
  const { wa_phone_number } = req.body
  if (!wa_phone_number) return res.status(400).json({ error: 'wa_phone_number is required' })
  // normalizePhone is total, and the only remaining failure is the UPDATE itself —
  // an infrastructure fault, which ah() turns into a 500 rather than blaming the client.
  const norm = normalizePhone(wa_phone_number)
  if (norm.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter a valid phone number' })
  // A single number is used for login and WhatsApp Business, so the WABA number may
  // match the agent's login number — no "must differ" check.
  res.json(await setAgentWaPhone(req.agent.id, norm))
}))

// --- Dashboard API — every route is scoped to the logged-in agent. ---

// Paged: `limit` (default 100, hard max 500) and `offset`. A caller that sends neither
// gets the first page rather than the whole table — at 10k leads the unbounded body was
// ~12MB, re-fetched every few seconds by both the inbox and the pipeline board.
// There is no `total` in this response on purpose: the body stays a plain array for
// every existing client, and anything that needs totals asks /api/leads/count, which is
// one grouped query instead of a full page of rows. A short page means the end.
app.get('/api/leads', ah(async (req, res) =>
  res.json(await listLeads(req.agent.id, {
    pipelineType: req.query.pipeline_type || '',
    stage: req.query.stage || '',
    search: req.query.q || '',
    limit: req.query.limit,
    offset: req.query.offset,
  })),
))

// Counts for the pipeline chips and the board's column headers, without shipping the
// leads themselves. Registered before /api/leads/:id so "count" isn't parsed as an id.
app.get('/api/leads/count', ah(async (req, res) => res.json(await leadCounts(req.agent.id))))

app.get('/api/leads/:id', ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const hybrid = await computeHybridScore(lead)
  const decay = hybrid.decay
  res.json({
    ...lead,
    // Fresh decayed scoring, computed live so the label is never "was hot once".
    effective_score: decay.effectiveScore,
    effective_temp: decay.temperature,
    engagement_score: decay.engagementScore,
    score_factors: decay.factors,
    // Rules + LLM hybrid verdict: Hot/Warm/Cold with an explainable reason string.
    hybrid_temp: hybrid.temperature,
    hybrid_reason: hybrid.reason,
    hybrid_source: hybrid.source,
    service_window: serviceWindow(lead),
    // Click-to-WhatsApp free-messaging window (72h) — null unless this is an ad lead.
    free_entry_window: freeEntryWindow(lead),
    messages: await getMessages(lead.id),
    followups: await listFollowups(req.agent.id, { leadId: lead.id }),
    site_visits: await listSiteVisits(req.agent.id, { leadId: lead.id }),
    stage_history: await leadStageHistory(lead.id, req.agent.id),
    // Unified inbox layer: internal notes, labels, and media already sent here.
    notes: await listLeadNotes(lead.id),
    labels: await leadLabels(lead.id),
    media_sent_ids: await mediaIdsSentToLead(lead.id),
    assigned_agent_id: lead.assigned_agent_id || lead.agent_id,
    contact: lead.contact_id ? await getContactDetail(lead.contact_id, req.agent.id).then((c) => c && { ...c, leads: undefined }) : null,
  })
}))

// Mark a thread read (clears the unread badge in the inbox list).
app.post('/api/leads/:id/read', ah(async (req, res) => {
  const lead = await markLeadRead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

// Reassign a thread to another agent (owner only). assignee_id null hands it back.
// The assignee is validated before the write for two reasons: leads.assigned_agent_id
// is a foreign key, so an unknown id used to surface as an opaque 500 instead of a
// usable error; and an unchecked id would let an owner push their thread into the
// inbox of any agent on the platform. A thread may only move to yourself or to a
// member of your own team.
app.post('/api/leads/:id/assign-to', ah(async (req, res) => {
  const raw = req.body.assignee_id ?? null
  let assigneeId = null
  if (raw !== null) {
    assigneeId = Number(raw)
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      // Phrased for the agent, not the caller: friendlyError.js shows a 4xx message
      // through to the screen verbatim, and hides any that reads technical behind a
      // generic line. "must be an agent id or null" was hidden by the word "null" —
      // a specific, fixable error arriving as "Some details look incorrect".
      return res.status(400).json({
        error: 'Choose an agent to hand this chat to, or clear the assignment.',
        code: 'BAD_ASSIGNEE_ID',
      })
    }
    const target = await getAgent(assigneeId)
    if (!target || target.is_active !== 1) {
      return res.status(404).json({ error: 'assignee not found', code: 'ASSIGNEE_NOT_FOUND' })
    }
    if (target.id !== req.agent.id) {
      const [mine, theirs] = await Promise.all([getAgentTeam(req.agent.id), getAgentTeam(target.id)])
      if (!mine || !theirs || mine.id !== theirs.id) {
        return res.status(403).json({
          error: 'You can only reassign a chat to someone on your team.',
          code: 'NOT_TEAMMATE',
        })
      }
    }
  }
  const lead = await assignLeadTo(req.params.id, req.agent.id, assigneeId)
  if (!lead) return res.status(404).json({ error: 'not found' })
  await logActivity(req.agent.id, lead.id, 'agent', `${req.agent.name} reassigned the chat`)
  res.json(lead)
}))

// --- Internal notes on a thread (private to the team, never sent to WhatsApp) ---
app.get('/api/leads/:id/notes', ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json(await listLeadNotes(lead.id))
}))

app.post('/api/leads/:id/notes', boundedText({ body: TEXT.PROSE }), ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  try {
    res.json(await addLeadNote(lead.id, req.agent.id, req.body.body))
  } catch (err) {
    if (!/note body is required/.test(err.message)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.delete('/api/leads/:id/notes/:noteId', ah(async (req, res) => {
  const ok = await deleteLeadNote(req.params.noteId, req.agent.id)
  res.status(ok ? 200 : 404).json({ ok })
}))

// --- Labels on a thread ---
app.put('/api/leads/:id/labels/:labelId', ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const on = req.body.on !== false // default to adding
  const labels = await setLeadLabel(lead.id, Number(req.params.labelId), req.agent.id, on)
  if (labels === null) return res.status(404).json({ error: 'label not found' })
  res.json(labels)
}))

// Pre-contact briefing: "Before you call" — rule-based talking points (instant,
// free, no LLM) over data HomeNex already stores. Makes the score auditable.
app.get('/api/leads/:id/briefing', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const [messages, siteVisits, decay] = await Promise.all([
    getMessages(lead.id),
    listSiteVisits(req.agent.id, { leadId: lead.id }),
    computeLeadDecay(lead),
  ])
  const pageViews = await leadPageViews(lead.id)
  res.json(buildBriefing({ lead, messages, siteVisits, pageViews, serviceWindow: serviceWindow(lead), decay }))
}))

// AI-suggested replies for the agent's composer. Tap-to-insert only — the agent
// always reviews and sends; nothing is auto-sent. Empty list when AI is off.
app.get('/api/leads/:id/suggestions', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const messages = await getMessages(lead.id)
  const last = messages[messages.length - 1]
  // Suggestions only make sense when the buyer is waiting on a reply.
  if (!last || last.role !== 'buyer') return res.json({ suggestions: [] })
  try {
    res.json({ suggestions: await suggestReplies(messages, lead, req.agent.name) })
    // suggestReplies never rejects: ai.js's chat() catches the queue's final
    // rejection and returns null, and everything after it is parsing that tolerates
    // null. This catch is what keeps that a property of ai.js rather than of the
    // lead detail page — an optional side panel must not 500 the whole route.
    /* node:coverage ignore next 4 */
  } catch (err) {
    console.error('suggestions failed', err)
    res.json({ suggestions: [] })
  }
}))

// AI auto-fill: per-field values the agent can accept or reject into the lead card.
// Reads the stored extraction by default (instant, free); ?fresh=1 re-runs the
// categorizer over the thread. Nothing is applied here — this is a proposal only.
app.get('/api/leads/:id/autofill', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  let extraction = lead.ai_extracted
  if (req.query.fresh) {
    try {
      extraction = (await extractLead(await getMessages(lead.id))) || extraction
    } catch (err) {
      console.error('autofill fresh extraction failed', err.message)
    }
  }
  res.json({ suggestions: buildAutofillSuggestions(lead, extraction) })
}))

// Apply the agent-accepted subset of auto-fill suggestions. Body: { accepted: {field: value} }.
app.post('/api/leads/:id/autofill/apply', ah(async (req, res) => {
  const accepted = req.body.accepted
  if (!accepted || typeof accepted !== 'object') return res.status(400).json({ error: 'accepted map is required' })
  try {
    const lead = await applyAutofill(req.params.id, req.agent.id, accepted)
    if (!lead) return res.status(404).json({ error: 'not found' })
    await logActivity(req.agent.id, lead.id, 'agent', `Auto-fill accepted: ${Object.keys(accepted).join(', ')}`)
    res.json(lead)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// Update a lead's CRM fields (budget in paise, BHK, property type, localities, ...).
app.put('/api/leads/:id', boundedText({
  name: TEXT.LINE, pipeline_type: TEXT.LINE, bhk: TEXT.LINE, property_type: TEXT.LINE,
  timeline: TEXT.LINE, financing: TEXT.LINE, preferred_localities: TEXT.BLURB, notes: TEXT.PROSE,
// A budget is paise, and it is the number the matcher compares every listing against.
// A negative one silently matched nothing; a fractional one is not a paise.
}), boundedNumber({ budget_min: NUM.PAISE, budget_max: NUM.PAISE }), ah(async (req, res) => {
  const fields = pick(req.body, [
    'name', 'pipeline_type', 'budget_min', 'budget_max', 'bhk', 'property_type',
    'preferred_localities', 'timeline', 'financing', 'notes',
  ])
  try {
    // `name` lives outside LEAD_CRM_FIELDS' allowlist — handle it explicitly.
    if (fields.name !== undefined) {
      const lead = await getLeadForAgent(req.params.id, req.agent.id)
      if (!lead) return res.status(404).json({ error: 'not found' })
      await updateLeadName(lead.id, String(fields.name || '').trim() || null)
      delete fields.name
    }
    const lead = await updateLeadCrm(req.params.id, req.agent.id, fields)
    if (!lead) return res.status(404).json({ error: 'not found' })
    res.json(lead)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// Move a lead between pipeline stages. Moving to Lost requires a lost_reason.
app.put('/api/leads/:id/stage', boundedText({ stage: TEXT.LINE, lost_reason: TEXT.BLURB }), ah(async (req, res) => {
  const { stage, lost_reason } = req.body
  if (!stage) return res.status(400).json({ error: 'stage is required' })
  try {
    const lead = await setLeadStage(req.params.id, req.agent.id, { stage, lost_reason })
    if (!lead) return res.status(404).json({ error: 'not found' })
    await logActivity(req.agent.id, lead.id, 'agent',
      `${lead.name || lead.wa_id} moved to ${stage}${stage === 'Lost' ? ` (${lead.lost_reason})` : ''}`)
    await logAudit(req.agent.id, 'lead', lead.id, 'stage_change', { stage, lost_reason: lead.lost_reason })
    // Stage events are a scoring signal (e.g. "Site Visit Done" flips visit-agreed):
    // recompute the decayed engagement score so the worklist stays honest. Best-effort.
    await recomputeLeadScore(lead.id).catch((e) => console.error('rescore on stage failed', e.message))
    res.json(lead)
  } catch (err) {
    if (err.code === 'BAD_STAGE' || err.code === 'LOST_REASON_REQUIRED') {
      return res.status(400).json({ error: err.message })
    }
    throw err
  }
}))

app.get('/api/pipeline-stages', ah(async (req, res) =>
  res.json(await listPipelineStages(req.query.type || null)),
))

// Pipeline analytics: funnel counts, average time-in-stage, and lost-reason mix,
// computed from the lead_stage_events transition log.
app.get('/api/pipeline/analytics', ah(async (req, res) => {
  const type = req.query.type || 'buy_primary'
  if (!['buy_primary', 'buy_resale', 'rental'].includes(type)) {
    return res.status(400).json({ error: 'bad pipeline type' })
  }
  res.json(await pipelineAnalytics(req.agent.id, type))
}))

// Quick match: inventory that fits this lead's budget / BHK / locality.
app.get('/api/leads/:id/property-matches', ah(async (req, res) => {
  const matches = await propertyMatchesForLead(req.params.id, req.agent.id)
  if (matches === null) return res.status(404).json({ error: 'lead not found' })
  res.json(matches)
}))

// Claim an unassigned lead from the shared pool, and remember the sender as a client.
//
// assignLead refuses three different ways, and they are not the same answer to give:
// the lead may not exist, it may already have been claimed by someone else in the
// seconds since the list was polled, or it may sit in ANOTHER team's pool — which the
// caller should not learn exists, so it reads as a 404 exactly like a missing id.
// Only the second case is a 409 worth retrying, and telling the three apart is one
// primary-key lookup on a path that has already failed.
app.post('/api/leads/:id/assign', ah(async (req, res) => {
  const lead = await assignLead(req.params.id, req.agent.id)
  if (!lead) {
    const existing = await getLead(req.params.id)
    // Still unassigned, yet the claim was refused: the only remaining reason is the
    // team guard, and that lead is none of this caller's business.
    if (!existing || existing.agent_id == null) return res.status(404).json({ error: 'not found' })
    return res.status(409).json({
      error: 'Another agent claimed this lead first.',
      code: 'LEAD_ALREADY_CLAIMED',
    })
  }
  try {
    await addContact(req.agent.id, lead.wa_id, lead.name || lead.wa_id)
  } catch {
    // Already a contact (or claimed elsewhere) — assignment still stands.
  }
  const contact = await getContactByPhone(lead.wa_id)
  if (contact?.agent_id === req.agent.id) await attachLeadContact(lead.id, contact.id)
  await logActivity(req.agent.id, lead.id, 'agent', `${req.agent.name} claimed ${lead.name || lead.wa_id}`)
  res.json(await getLead(lead.id))
}))

// Agent takes over / hands back to AI.
app.post('/api/leads/:id/ai', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  await setAiEnabled(lead.id, Boolean(req.body.enabled))
  await logActivity(
    req.agent.id,
    lead.id,
    'agent',
    req.body.enabled
      ? `AI re-enabled for ${lead.name || lead.wa_id}`
      : `${req.agent.name} took over the chat with ${lead.name || lead.wa_id}`,
  )
  res.json(await getLead(lead.id))
}))

// Agent sends a real WhatsApp message from the dashboard. Outside the 24-hour
// service window Meta only accepts template messages, so free-text replies are
// rejected with 409 and the client must send a template (template_id) instead.
app.post('/api/leads/:id/reply', boundedText({ text: TEXT.WHATSAPP }), ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })

  const templateId = req.body.template_id
  let text
  if (templateId) {
    const tpl = await getMessageTemplate(Number(templateId), req.agent.id)
    if (!tpl) return res.status(404).json({ error: 'template not found' })
    // Agents fill variables; the approved body is never edited here. Marketing
    // templates get the RERA number appended automatically.
    const { text: rendered, missing } = renderTemplate(tpl, req.body.variables || {}, req.agent)
    if (missing.length) {
      return res.status(400).json({ error: `Fill in: ${missing.join(', ')}`, code: 'TEMPLATE_VARS_MISSING', missing })
    }
    text = rendered
  } else {
    text = (req.body.text || '').trim()
    if (!text) return res.status(400).json({ error: 'text required' })
    const win = serviceWindow(lead)
    // Only enforce when we know the window state (legacy leads have no anchor).
    if (lead.last_inbound_at && !win.open) {
      return res.status(409).json({
        error: 'The 24-hour service window has closed — send an approved template instead',
        code: 'WINDOW_EXPIRED',
        service_window: win,
      })
    }
  }

  try {
    const waMsgId = await sendText(lead.wa_id, text, req.agent.wa_phone_number_id)
    const msg = await addMessage(lead.id, 'agent', text, waMsgId)
    await recordFirstResponse(lead.id)
    res.json(msg)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message, code: err.code })
  }
}))

// --- EMI calculator: agents can compute an EMI for any client question ---
// The structured form (principal/rate/tenure) goes straight into the formula, so
// `{ principal_l: 1e9, rate_pct: 1e6, years: 1e6 }` used to return a confident,
// WhatsApp-ready message quoting an EMI in the quintillions. These are the bounds a
// home loan actually has: up to ₹1,000 crore, a rate that is a percentage, and a
// tenure that fits inside a career. Free text is parsed, not trusted, so it keeps its
// own path.
app.post('/api/emi', boundedText({ text: TEXT.BLURB }), boundedNumber({
  principal_l: { min: 0, max: 100_000 },
  rate_pct: NUM.PERCENT,
  years: { min: 0, max: 50 },
}), ah(async (req, res) => {
  const { text, principal_l, rate_pct, years } = req.body
  const parsed = text
    ? parseEmiQuery(text)
    : principal_l != null
      ? {
          principalLakhs: Number(principal_l),
          ratePct: rate_pct != null ? Number(rate_pct) : 8.5,
          years: years != null ? Number(years) : 20,
          assumedRate: rate_pct == null,
          assumedTenure: years == null,
        }
      : null
  if (!parsed || !(parsed.principalLakhs > 0)) {
    return res.status(400).json({ error: 'Could not find a loan amount — try "80L at 8.5% for 20 years"' })
  }
  const message = formatEmiMessage(parsed)
  if (!message) return res.status(400).json({ error: 'Invalid EMI inputs' })
  res.json({ ...parsed, message })
}))

// --- Contacts: auto-captured from WhatsApp conversations. There is no manual
// "add contact" API — contacts are created by the inbound webhook (or when an
// agent claims a pooled lead / texts a client to the shared number).
// Paged: `limit` (default 100, hard max 500) and `offset`, exactly like /api/leads. A
// caller that sends neither gets the first page rather than every number the agent has
// ever captured. The body stays a plain array so existing clients keep working, and a
// short page means the end; anything that needs the true total asks /api/contacts/count.
app.get('/api/contacts', ah(async (req, res) =>
  res.json(await listContacts(req.agent.id, {
    search: req.query.q || '',
    source: req.query.source || '',
    limit: req.query.limit,
    offset: req.query.offset,
  })),
))

// Registered before /api/contacts/:id so "count" isn't parsed as an id. Takes the same
// q/source filters as the list, so the header total describes the list underneath it.
app.get('/api/contacts/count', ah(async (req, res) =>
  res.json(await contactCount(req.agent.id, {
    search: req.query.q || '',
    source: req.query.source || '',
  })),
))

app.get('/api/contacts/:id', ah(async (req, res) => {
  const contact = await getContactDetail(req.params.id, req.agent.id)
  if (!contact) return res.status(404).json({ error: 'not found' })
  res.json(contact)
}))

app.put('/api/contacts/:id', boundedText({ name: TEXT.LINE, notes: TEXT.PROSE, opt_in_status: TEXT.LINE }), ah(async (req, res) => {
  try {
    const contact = await updateContact(
      req.params.id,
      req.agent.id,
      pick(req.body, ['name', 'notes', 'opt_in_status', 'labels']),
    )
    if (!contact) return res.status(404).json({ error: 'not found' })
    res.json(contact)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.delete('/api/contacts/:id', ah(async (req, res) => {
  if (!(await deleteContact(req.params.id, req.agent.id))) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

app.get('/api/stats', ah(async (req, res) => res.json(await stats(req.agent.id))))
app.get('/api/activity', ah(async (req, res) => res.json(await listActivity(req.agent.id))))

app.get('/api/network', ah(async (req, res) =>
  res.json({ posts: await listNetworkPosts(), matches: await computeMatches(req.agent.id) }),
))
// A network post is the one thing in HomeNex every agent on the platform can read,
// so its fields are coerced and bounded here rather than trusted: the budget columns
// are DOUBLE PRECISION (a non-numeric string reached Postgres as a 500) and the text
// columns are unbounded (a multi-megabyte post would be broadcast to everyone).
const NETWORK_TEXT_LIMITS = { broker: 120, firm: 120, text: 2000, config: 60, locality: 120 }
app.post('/api/network', ah(async (req, res) => {
  const p = req.body
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())
  const post = { type: str(p.type) }
  if (!['INVENTORY', 'REQUIREMENT'].includes(post.type)) {
    return res.status(400).json({ error: post.type ? 'bad type' : 'type, broker, text required' })
  }
  for (const [field, max] of Object.entries(NETWORK_TEXT_LIMITS)) {
    const value = str(p[field])
    if (value.length > max) return res.status(400).json({ error: `${field} must be ${max} characters or fewer` })
    post[field] = value || null
  }
  if (!post.broker || !post.text) return res.status(400).json({ error: 'type, broker, text required' })
  for (const field of ['budget_min_l', 'budget_max_l']) {
    if (p[field] == null || p[field] === '') {
      post[field] = null
      continue
    }
    const n = Number(p[field])
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${field} must be a number in lakhs` })
    post[field] = n
  }
  res.json(await addNetworkPost(post))
}))

// --- Properties: the agent's inventory ---
const PROPERTY_BODY_FIELDS = [
  'title', 'property_type', 'bhk', 'size_sqft', 'size_unit', 'price_paise', 'locality', 'city',
  'status', 'rera_project_number', 'builder_name', 'owner_name', 'facing', 'floor', 'total_floors',
  'amenities', 'photos', 'brochure_url', 'video_url', 'notes',
]
// The text half of that same list, shared by create and edit so the two can never
// drift apart. `amenities`/`photos` are JSONB arrays and `size_sqft`/`price_paise`/
// `floor` are numbers, so neither belongs here; everything else is a TEXT column a
// listing card shows, and one of them (title) is what a public micro-page prints as
// its heading.
const PROPERTY_TEXT_LIMITS = {
  title: TEXT.LINE, property_type: TEXT.LINE, bhk: TEXT.LINE, size_unit: TEXT.LINE,
  locality: TEXT.LINE, city: TEXT.LINE, status: TEXT.LINE, rera_project_number: TEXT.LINE,
  builder_name: TEXT.LINE, owner_name: TEXT.LINE, facing: TEXT.LINE,
  brochure_url: TEXT.URL, video_url: TEXT.URL, notes: TEXT.PROSE,
}
// And the numeric half. The column types alone let a listing be saved at minus fifty
// lakhs on minus nine hundred square feet — accepted by Postgres, priced into every
// buyer match, and rendered on the card as "-₹50L".
const PROPERTY_NUMBER_LIMITS = {
  price_paise: NUM.PAISE, size_sqft: NUM.AREA, floor: NUM.FLOOR, total_floors: NUM.FLOOR,
}
// And the link half. `brochure_url` is the one the app renders into an href, so it is
// the one that could carry a script; the other two are bounded with it because they
// are the same kind of field and a listing is shared across a whole team.
const PROPERTY_URL_FIELDS = ['brochure_url', 'video_url', 'photos']

// The filter set shared by the property list and its count, so the header total can
// never describe a different set of rows than the page beneath it.
const propertyQuery = (query) => ({
  status: query.status || '',
  propertyType: query.type || '',
  bhk: query.bhk || '',
  locality: query.locality || '',
  city: query.city || '',
  minPrice: query.min_price ? Number(query.min_price) : null,
  maxPrice: query.max_price ? Number(query.max_price) : null,
  search: query.q || '',
})

// The price band is the one filter that reaches Postgres as a number rather than a
// string, so it is the one that has to be a number before it gets there. Guarded on
// the count as well as the list: they take the same filters and must agree, including
// about which of them are rejected.
const propertyPriceBand = boundedNumber({ min_price: NUM.PAISE, max_price: NUM.PAISE }, { from: 'query' })

// Paged like /api/leads and /api/contacts: `limit` (default 100, max 500) and `offset`,
// body still a plain array, a short page means the end. Anything that needs the true
// total asks /api/properties/count.
app.get('/api/properties', propertyPriceBand, ah(async (req, res) =>
  res.json(await listProperties(req.agent.id, {
    ...propertyQuery(req.query),
    limit: req.query.limit,
    offset: req.query.offset,
  })),
))

// Registered before /api/properties/:id so "count" isn't parsed as an id.
app.get('/api/properties/count', propertyPriceBand, ah(async (req, res) =>
  res.json(await propertyCount(req.agent.id, propertyQuery(req.query))),
))

app.get('/api/properties/:id', ah(async (req, res) => {
  const property = await getProperty(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'not found' })
  res.json(property)
}))

app.post('/api/properties', boundedText(PROPERTY_TEXT_LIMITS), boundedNumber(PROPERTY_NUMBER_LIMITS), boundedUrl(PROPERTY_URL_FIELDS), ah(async (req, res) => {
  try {
    const property = await createProperty(req.agent.id, pick(req.body, PROPERTY_BODY_FIELDS))
    await logAudit(req.agent.id, 'property', property.id, 'create', { title: property.title })
    res.json(property)
  } catch (err) {
    if (!pgBadRequest(err) && !/title is required/.test(err.message)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/properties/:id', boundedText(PROPERTY_TEXT_LIMITS), boundedNumber(PROPERTY_NUMBER_LIMITS), boundedUrl(PROPERTY_URL_FIELDS), ah(async (req, res) => {
  try {
    const property = await updateProperty(req.params.id, req.agent.id, pick(req.body, PROPERTY_BODY_FIELDS))
    if (!property) return res.status(404).json({ error: 'not found' })
    res.json(property)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.delete('/api/properties/:id', ah(async (req, res) => {
  if (!(await deleteProperty(req.params.id, req.agent.id))) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

// Micro-page share link: ensures the property has a public slug and returns the
// URL plus view stats. Idempotent — safe to call every time the share sheet opens.
app.post('/api/properties/:id/micro-page', ah(async (req, res) => {
  const property = await ensurePropertySlug(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'not found' })
  res.json({
    slug: property.micro_page_slug,
    url: `${req.protocol}://${req.get('host')}/p/${property.micro_page_slug}`,
    page_views: property.page_views || 0,
    stats: await propertyViewStats(property.id),
  })
}))

// Format a property as a WhatsApp-ready message.
export function formatPropertyMessage(p) {
  const spec = [p.bhk && `${p.bhk} BHK`, p.property_type, p.size_sqft && `${p.size_sqft} ${p.size_unit || 'sqft'}`]
    .filter(Boolean)
    .join(' · ')
  const who = p.builder_name ? `🏗️ ${p.builder_name}` : p.owner_name ? `👤 ${p.owner_name}` : null
  return [
    `🏠 *${p.title}*`,
    spec || null,
    (p.locality || p.city) && `📍 ${[p.locality, p.city].filter(Boolean).join(', ')}`,
    p.price_paise != null && `💰 ${paiseToDisplay(p.price_paise)}`,
    who,
    p.rera_project_number && `✅ RERA: ${p.rera_project_number}`,
    p.brochure_url && `📄 Brochure: ${p.brochure_url}`,
  ]
    .filter(Boolean)
    .join('\n')
}

// "Send to chat": push a formatted property card into a lead's WhatsApp conversation.
app.post('/api/properties/:id/send-to-chat', ah(async (req, res) => {
  const { lead_id } = req.body
  if (!lead_id) return res.status(400).json({ error: 'lead_id is required' })
  const property = await getProperty(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'property not found' })
  const lead = await getLeadForAgent(lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  // Attach a lead-tracked micro-page link so a page open becomes a per-lead
  // engagement signal (the ?l=<leadId> ref is read by the public /p route).
  const withSlug = await ensurePropertySlug(property.id, req.agent.id)
  let text = formatPropertyMessage(property)
  if (withSlug?.micro_page_slug) {
    text += `\n\n🔗 ${req.protocol}://${req.get('host')}/p/${withSlug.micro_page_slug}?l=${lead.id}`
  }
  try {
    const waMsgId = await sendText(lead.wa_id, text, req.agent.wa_phone_number_id)
    const msg = await addMessage(lead.id, 'agent', text, waMsgId)
    await logActivity(req.agent.id, lead.id, 'agent', `Sent "${property.title}" to ${lead.name || lead.wa_id}`)
    await logAudit(req.agent.id, 'property', property.id, 'send_to_chat', { lead_id: lead.id })
    res.json({ ok: true, message: msg })
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message, code: err.code })
  }
}))

// --- Follow-ups & reminders ---
// `lead_id` reaches an integer column, so a non-numeric one is a 400 here rather than
// a 22P02 the route never catches. Same for the site-visit list below.
app.get('/api/followups', boundedNumber({ lead_id: NUM.ID }, { from: 'query' }), ah(async (req, res) =>
  res.json(await listFollowups(req.agent.id, {
    pendingOnly: req.query.pending === '1',
    today: req.query.today === '1',
    overdueOnly: req.query.overdue === '1',
    byHeat: req.query.by_heat === '1',
    leadId: req.query.lead_id || null,
  })),
))

app.post('/api/followups', boundedText({ note: TEXT.PROSE, type: TEXT.LINE }), ah(async (req, res) => {
  const { lead_id, due_at, note, type } = req.body
  if (!lead_id || !due_at) return res.status(400).json({ error: 'lead_id and due_at are required' })
  const lead = await getLeadForAgent(lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  try {
    res.json(await createFollowup(req.agent.id, { lead_id: lead.id, due_at, note, type }))
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/followups/:id', boundedText({ note: TEXT.PROSE, type: TEXT.LINE }), ah(async (req, res) => {
  try {
    const followup = await updateFollowup(
      req.params.id,
      req.agent.id,
      pick(req.body, ['completed', 'due_at', 'note', 'type']),
    )
    if (!followup) return res.status(404).json({ error: 'not found' })
    res.json(followup)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// --- Site visits ---
app.get('/api/site-visits', boundedNumber({ lead_id: NUM.ID }, { from: 'query' }), ah(async (req, res) =>
  res.json(await listSiteVisits(req.agent.id, {
    leadId: req.query.lead_id || null,
    status: req.query.status || '',
    today: req.query.today === '1',
  })),
))

app.post('/api/site-visits', boundedText({ pickup_location: TEXT.BLURB }), ah(async (req, res) => {
  const { lead_id, property_id, scheduled_at, pickup_required, pickup_location, builder_preregistered } = req.body
  if (!lead_id || !scheduled_at) return res.status(400).json({ error: 'lead_id and scheduled_at are required' })
  const lead = await getLeadForAgent(lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  if (property_id && !(await getProperty(property_id, req.agent.id))) {
    return res.status(404).json({ error: 'property not found' })
  }
  try {
    const visit = await createSiteVisit(req.agent.id, {
      lead_id: lead.id, property_id, scheduled_at, pickup_required, pickup_location, builder_preregistered,
    })
    await logActivity(req.agent.id, lead.id, 'agent', `Site visit scheduled for ${lead.name || lead.wa_id}`)
    // A booked visit is the strongest buying signal there is, and it feeds both the
    // hard Hot rule and the decay's commitment term — recompute now so the hot-lead
    // count, notifications and worklist reflect it immediately instead of at the next
    // twice-daily decay pass. Best-effort: never fail the booking over a rescore.
    await recomputeLeadScore(lead.id).catch((e) => console.error('rescore on visit booking failed', e.message))
    // Fire the automated WhatsApp booking confirmation (best-effort: a WhatsApp
    // outage or closed service window must not fail the scheduling itself).
    const property = property_id ? await getProperty(property_id, req.agent.id) : null
    // Mirror the buyer's own language/register (see language.js) — a booking
    // confirmation landing in English mid-Hindi/Hinglish thread reads as a bot.
    const lang = detectConversationLanguage(await getMessages(lead.id))
    const text = bookingConfirmationText({
      lead_name: lead.name, lead_wa_id: lead.wa_id, scheduled_at: visit.scheduled_at,
      property_title: property?.title, property_locality: property?.locality, property_city: property?.city,
      pickup_required: visit.pickup_required, pickup_location: visit.pickup_location,
    }, { timezone: req.agent.timezone, lang })
    let confirmation_sent = false
    try {
      const waMsgId = await sendText(lead.wa_id, text, req.agent.wa_phone_number_id)
      await addMessage(lead.id, 'agent', text, waMsgId)
      await stampSiteVisitConfirmation(visit.id, req.agent.id)
      confirmation_sent = true
    } catch {
      // WhatsApp not configured / window closed — the T-1 and T-2h reminders still run.
    }
    res.json({ ...visit, confirmation_sent })
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/site-visits/:id', boundedText({ pickup_location: TEXT.BLURB, status: TEXT.LINE, outcome_notes: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const visit = await updateSiteVisit(
      req.params.id,
      req.agent.id,
      pick(req.body, [
        'scheduled_at', 'pickup_required', 'pickup_location', 'status', 'outcome_notes',
        'builder_preregistered', 'property_id',
      ]),
    )
    if (!visit) return res.status(404).json({ error: 'not found' })
    res.json(visit)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// --- §5.4: deals, commissions, builder receivables + aging, GST invoices ---

// Shared by create and edit on each side of the ledger, so a field can't be bounded
// on the way in and unbounded on the way back through an edit.
const DEAL_TEXT_LIMITS = {
  deal_type: TEXT.LINE, builder_name: TEXT.LINE, stage_captured: TEXT.LINE,
  status: TEXT.LINE, notes: TEXT.PROSE,
}
// Money on a deal is what the commission is a percentage of, so a negative one is a
// negative commission, a negative invoice, and a receivables ledger that owes the
// builder money.
const DEAL_NUMBER_LIMITS = {
  lead_id: NUM.ID, property_id: NUM.ID, deal_value_paise: NUM.PAISE, monthly_rent_paise: NUM.PAISE,
}
const COMMISSION_TEXT_LIMITS = {
  payer_type: TEXT.LINE, builder_name: TEXT.LINE, status: TEXT.LINE, notes: TEXT.PROSE,
}
// commission_pct is NUMERIC(5,2): 5000% overflowed the column and answered with
// Postgres's own "numeric field overflow", which tells the agent nothing about which
// field they typed wrong.
const COMMISSION_NUMBER_LIMITS = {
  lead_id: NUM.ID, deal_id: NUM.ID, deal_value_paise: NUM.PAISE,
  commission_pct: NUM.PERCENT, commission_flat_paise: NUM.PAISE,
}

// Deals are captured automatically at the booking stage, but can also be listed,
// created, and edited by hand.
app.get('/api/deals', ah(async (req, res) =>
  res.json(await listDeals(req.agent.id, { status: req.query.status || '', dealType: req.query.type || '' })),
))

app.post('/api/deals', boundedText(DEAL_TEXT_LIMITS), boundedNumber(DEAL_NUMBER_LIMITS), ah(async (req, res) => {
  const body = req.body
  if (!body.lead_id) return res.status(400).json({ error: 'lead_id is required' })
  const lead = await getLeadForAgent(body.lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  try {
    res.json(await createDeal(req.agent.id, pick(body, [
      'lead_id', 'property_id', 'deal_type', 'builder_name', 'deal_value_paise',
      'monthly_rent_paise', 'stage_captured', 'status', 'notes',
    ])))
  } catch (err) {
    if (!pgBadRequest(err) && err.code !== '23505') throw err
    res.status(400).json({ error: err.code === '23505' ? 'a deal already exists for this lead' : err.message })
  }
}))

app.get('/api/deals/:id', ah(async (req, res) => {
  const deal = await getDeal(req.params.id, req.agent.id)
  if (!deal) return res.status(404).json({ error: 'not found' })
  res.json({ ...deal, suggested_rental_commission_paise: suggestRentalCommissionPaise(deal) })
}))

app.put('/api/deals/:id', boundedText(DEAL_TEXT_LIMITS), boundedNumber(DEAL_NUMBER_LIMITS), ah(async (req, res) => {
  try {
    const deal = await updateDeal(req.params.id, req.agent.id, pick(req.body, [
      'property_id', 'deal_type', 'builder_name', 'deal_value_paise', 'monthly_rent_paise', 'status', 'notes',
    ]))
    if (!deal) return res.status(404).json({ error: 'not found' })
    res.json(deal)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.get('/api/commissions', ah(async (req, res) =>
  res.json(await listCommissions(req.agent.id, { status: req.query.status || undefined })),
))

// Builder receivables ledger + aging report (0-30 / 31-60 / 61-90 / 90+ days).
app.get('/api/commissions/receivables', ah(async (req, res) =>
  res.json(await builderReceivables(req.agent.id)),
))

app.post('/api/commissions', boundedText(COMMISSION_TEXT_LIMITS), boundedNumber(COMMISSION_NUMBER_LIMITS), ah(async (req, res) => {
  const body = req.body
  if (!body.lead_id) return res.status(400).json({ error: 'lead_id is required' })
  const lead = await getLeadForAgent(body.lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  try {
    res.json(await createCommission(req.agent.id, pick(body, [
      'lead_id', 'deal_id', 'deal_value_paise', 'commission_pct', 'commission_flat_paise',
      'payer_type', 'builder_name', 'expected_payout_date', 'status', 'notes',
    ])))
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/commissions/:id', boundedText(COMMISSION_TEXT_LIMITS), boundedNumber(COMMISSION_NUMBER_LIMITS), ah(async (req, res) => {
  try {
    const commission = await updateCommission(req.params.id, req.agent.id, pick(req.body, [
      'deal_id', 'deal_value_paise', 'commission_pct', 'commission_flat_paise', 'payer_type',
      'builder_name', 'expected_payout_date', 'actual_payout_date', 'status', 'notes',
    ]))
    if (!commission) return res.status(404).json({ error: 'not found' })
    res.json(commission)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// Raise a GST-aware invoice for a commission (18% GST by default, split in paise).
// No boundedNumber for gst_rate: createCommissionInvoice already checks it, does it
// more thoroughly (it rejects `[]` and `'18%'`, which coerce), and answers with
// INVALID_GST_RATE — a code a client can branch on and a generic range error would
// only shadow.
app.post('/api/commissions/:id/invoice', boundedText({ invoice_number: TEXT.LINE, notes: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const invoice = await createCommissionInvoice(req.agent.id, req.params.id, pick(req.body, ['gst_rate', 'invoice_number', 'notes']))
    if (!invoice) return res.status(404).json({ error: 'commission not found' })
    res.json(invoice)
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'invoice number already exists' })
    const rejected = err.code === 'NO_AMOUNT' || err.code === 'INVALID_GST_RATE'
    if (!pgBadRequest(err) && !rejected) throw err
    res.status(400).json({ error: err.message, ...(rejected && { code: err.code }) })
  }
}))

app.get('/api/commission-invoices', boundedNumber({ commission_id: NUM.ID }, { from: 'query' }), ah(async (req, res) =>
  res.json(await listCommissionInvoices(req.agent.id, {
    commissionId: req.query.commission_id || null,
    status: req.query.status || '',
  })),
))

app.put('/api/commission-invoices/:id', boundedText({ status: TEXT.LINE, notes: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const invoice = await updateCommissionInvoice(req.params.id, req.agent.id, pick(req.body, ['status', 'notes']))
    if (!invoice) return res.status(404).json({ error: 'not found' })
    res.json(invoice)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// --- Message templates (used by the template-only composer after the 24h window) ---
// A template body is sent to Meta for approval and then to buyers, so it is bounded
// at what WhatsApp will actually carry. `variables` is JSON and is left alone.
const TEMPLATE_TEXT_LIMITS = {
  name: TEXT.LINE, category: TEXT.LINE, meta_status: TEXT.LINE, body: TEXT.WHATSAPP,
}
app.get('/api/templates', ah(async (req, res) => res.json(await listMessageTemplates(req.agent.id))))

app.post('/api/templates', boundedText(TEMPLATE_TEXT_LIMITS), ah(async (req, res) => {
  try {
    res.json(await createMessageTemplate(req.agent.id, pick(req.body, ['name', 'category', 'body', 'variables', 'rera_auto_append'])))
  } catch (err) {
    if (!pgBadRequest(err) && !/name and body are required/.test(err.message) && err.code !== '23505') throw err
    res.status(400).json({ error: err.message })
  }
}))

// Edit a template. Locked templates (system pack, or Meta-approved) accept metadata
// changes but NOT body/name/category edits — agents fill variables, not the wording.
app.put('/api/templates/:id', boundedText(TEMPLATE_TEXT_LIMITS), ah(async (req, res) => {
  const tpl = await getMessageTemplate(Number(req.params.id), req.agent.id)
  if (!tpl) return res.status(404).json({ error: 'not found' })
  const fields = pick(req.body, ['name', 'category', 'body', 'variables', 'rera_auto_append', 'meta_status'])
  const editsBody = ['name', 'category', 'body'].some((k) => k in fields)
  if ((tpl.is_locked || tpl.meta_status === 'approved') && editsBody) {
    return res.status(403).json({
      error: 'This template is approved and locked — you can fill its variables but not edit the wording.',
      code: 'TEMPLATE_LOCKED',
    })
  }
  try {
    res.json(await updateMessageTemplate(tpl.id, req.agent.id, fields))
  } catch (err) {
    if (!pgBadRequest(err) && err.code !== '23505') throw err
    res.status(400).json({ error: err.message })
  }
}))

// Delete a template. System (curated pack) templates can't be removed.
app.delete('/api/templates/:id', ah(async (req, res) => {
  const ok = await deleteMessageTemplate(Number(req.params.id), req.agent.id)
  if (!ok) {
    const tpl = await getMessageTemplate(Number(req.params.id), req.agent.id)
    if (tpl?.is_system) return res.status(403).json({ error: 'System templates cannot be deleted', code: 'TEMPLATE_SYSTEM' })
    return res.status(404).json({ error: 'not found' })
  }
  res.json({ ok: true })
}))

// --- Quick replies: saved snippets with {{name}}/{{property}}/{{visit_time}} ---
app.get('/api/quick-replies', ah(async (req, res) => res.json(await listQuickReplies(req.agent.id))))

app.post('/api/quick-replies', boundedText({ title: TEXT.LINE, body: TEXT.PROSE }), ah(async (req, res) => {
  try {
    res.json(await createQuickReply(req.agent.id, pick(req.body, ['title', 'body'])))
  } catch (err) {
    if (!pgBadRequest(err) && !/title and body are required/.test(err.message) && err.code !== '23505') throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/quick-replies/:id', boundedText({ title: TEXT.LINE, body: TEXT.PROSE }), ah(async (req, res) => {
  const updated = await updateQuickReply(Number(req.params.id), req.agent.id, pick(req.body, ['title', 'body']))
  if (!updated) return res.status(404).json({ error: 'not found' })
  res.json(updated)
}))

app.delete('/api/quick-replies/:id', ah(async (req, res) => {
  const ok = await deleteQuickReply(Number(req.params.id), req.agent.id)
  res.status(ok ? 200 : 404).json({ ok })
}))

// --- Labels: manage the workspace label set ---
app.get('/api/labels', ah(async (req, res) => res.json(await listLabels(req.agent.id))))

app.post('/api/labels', boundedText({ name: TEXT.LINE, color: TEXT.LINE }), ah(async (req, res) => {
  try {
    res.json(await createLabel(req.agent.id, pick(req.body, ['name', 'color'])))
  } catch (err) {
    if (!pgBadRequest(err) && !/label name is required/.test(err.message) && err.code !== '23505') throw err
    res.status(400).json({ error: err.message })
  }
}))

app.delete('/api/labels/:id', ah(async (req, res) => {
  const outcome = await deleteLabel(Number(req.params.id), req.agent.id)
  // A label that isn't there is a 404. Only a real, protected system label earns
  // the 403 — otherwise a stale id (or another workspace's label) came back as
  // "System labels cannot be deleted", which is both wrong and confusing.
  if (outcome === 'system') {
    return res.status(403).json({ error: 'System labels cannot be deleted', code: 'LABEL_SYSTEM' })
  }
  if (outcome === 'missing') return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

// --- Media library: upload once, attach to any chat in two taps ---
// `data_base64` is deliberately absent — an upload's ceiling is saveUpload's decoded
// byte limit, not a character count.
const MEDIA_TEXT_LIMITS = {
  title: TEXT.LINE, kind: TEXT.LINE, caption: TEXT.BLURB, filename: TEXT.LINE,
  mime: TEXT.LINE, url: TEXT.URL,
}
app.get('/api/media', ah(async (req, res) => res.json(await listMediaAssets(req.agent.id))))

// Register an asset. Two modes: { storage:'url', url } for an already-hosted file,
// or { storage:'local', data_base64, filename } to upload a file we host at /uploads.
app.post('/api/media', uploadLimiter, boundedText(MEDIA_TEXT_LIMITS), boundedUrl(['url']), ah(async (req, res) => {
  const b = req.body
  try {
    let asset = pick(b, ['title', 'kind', 'caption'])
    if (b.data_base64) {
      const saved = saveUpload(b.data_base64, b.filename, b.mime)
      asset = { ...asset, storage: 'local', url: saved.url, filename: saved.filename, mime: saved.mime, size_bytes: saved.size }
    } else {
      if (!b.url) return res.status(400).json({ error: 'url or data_base64 is required' })
      asset = { ...asset, storage: 'url', url: b.url, filename: b.filename ?? null, mime: b.mime ?? null }
    }
    res.json(await createMediaAsset(req.agent.id, asset))
  } catch (err) {
    const uploadRejected = err.code === 'UPLOAD_TYPE_REJECTED' || err.code === 'UPLOAD_TOO_LARGE'
    if (!pgBadRequest(err) && !uploadRejected && !/required/.test(err.message)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.delete('/api/media/:id', ah(async (req, res) => {
  const ok = await deleteMediaAsset(Number(req.params.id), req.agent.id)
  res.status(ok ? 200 : 404).json({ ok })
}))

// Generic file upload → hosted URL. Lets forms (e.g. the property photo/brochure
// picker) turn a phone-gallery file into a URL we store, without creating a media
// library record. Returns { url, filename, mime, size }.
app.post('/api/uploads', uploadLimiter, boundedText({ filename: TEXT.LINE, mime: TEXT.LINE }), ah(async (req, res) => {
  const b = req.body
  if (!b.data_base64) return res.status(400).json({ error: 'data_base64 is required' })
  try {
    res.json(saveUpload(b.data_base64, b.filename, b.mime))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// Send a library asset into a chat. Records the send so the UI can show "sent".
// Free-text-window rules don't apply to media the same way, but Meta still requires
// an open session for non-template media, so we enforce the 24h window here too.
app.post('/api/media/:id/send', boundedText({ caption: TEXT.BLURB }), ah(async (req, res) => {
  const lead = await getLeadForAgent(req.body.lead_id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'lead not found' })
  const asset = await getMediaAsset(Number(req.params.id), req.agent.id)
  if (!asset) return res.status(404).json({ error: 'media not found' })
  const win = serviceWindow(lead)
  if (lead.last_inbound_at && !win.open) {
    return res.status(409).json({
      error: 'The 24-hour window has closed — media can only be sent while the chat is open.',
      code: 'WINDOW_EXPIRED', service_window: win,
    })
  }
  const caption = (req.body.caption ?? asset.caption) || asset.title
  try {
    const waMsgId = await sendMedia(
      lead.wa_id,
      { type: waMediaType(asset.kind), link: asset.url, caption, filename: asset.filename },
      req.agent.wa_phone_number_id,
    )
    await recordMediaSend(asset.id, lead.id, req.agent.id, waMsgId)
    const msg = await addMessage(lead.id, 'agent', `📎 ${asset.title}${caption && caption !== asset.title ? ` — ${caption}` : ''}`, waMsgId)
    res.json({ message: msg, media_id: asset.id })
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message, code: err.code })
  }
}))

// --- Festive greeting templates: pre-built Indian festival greetings the agent
// can customise and schedule for the festival date. ---
app.get('/api/templates/festive', ah(async (req, res) =>
  res.json({ festivals: FESTIVALS, scheduled: await listFestiveSchedules(req.agent.id) }),
))

// Deliver one festive greeting blast to an agent's contacts (all non-opted-out).
// Shared bulk sender. Every recipient is gated by the send limiter (sendLimiter.js)
// before a message goes out — per-contact frequency caps, a warmup-ramped daily cap,
// opt-out enforcement and a quiet-hours window — because a WhatsApp number blasted
// at all its contacts at once is exactly what Meta's quality rating punishes.
// `personalize` optionally rewrites the body per contact (festive greetings do).
async function sendToRecipients(agent, recipients, message, kind, { personalize = null, enforceWindow = true } = {}) {
  const startedAt = await ensureBulkSendStarted(agent.id) // stamp warmup anchor on first bulk send
  const dailyCap = warmupDailyCap(startedAt)
  let sentCount = await sendsToday(agent.id)
  let sent = 0
  let failed = 0
  let skipped = 0
  const skips = {}
  // One query for the whole audience instead of one per recipient (see
  // contactSendStatsBatch). Prefetching is only equivalent to querying inside the
  // loop as long as sends made DURING this run are folded back in, which is what
  // sentNowByPhone does: a number already messaged by this run must be seen by a
  // later recipient carrying the same number, not read as never-messaged.
  //
  // No route can currently build such an audience. Both callers draw recipients
  // straight from `contacts`, whose phone column is UNIQUE across the whole table
  // (001_initial_schema.sql) with every write path canonicalising through
  // normalizePhone, and a static group cannot list one contact twice
  // (contact_group_members is keyed on (group_id, contact_id)). The fold-back is
  // kept because the invariant lives in the schema rather than here, and a future
  // recipient source — a merged audience, an imported list, leads joined in beside
  // contacts — would reintroduce duplicates silently. Its cost is one Map.
  const statsByKey = await contactSendStatsBatch(agent.id, recipients)
  const sentNowByPhone = new Map()
  for (const contact of recipients) {
    // contactSendStatsBatch returns an entry for every key it was given, so the
    // literal is a shape guard rather than a live default.
    /* node:coverage ignore next */
    const stats = statsByKey.get(sendStatsKey(contact)) || { lastSentAt: null, monthCount: 0 }
    // Unreachable while UNIQUE(contacts.phone) holds — see the note above.
    /* node:coverage ignore next 5 */
    const justSentAt = sentNowByPhone.get(contact.phone) ?? null
    const verdict = evaluateSend({
      optInStatus: contact.opt_in_status,
      lastSentToContactAt: justSentAt ?? stats.lastSentAt,
      contactSendsThisMonth: stats.monthCount + (justSentAt ? 1 : 0),
      sendsToday: sentCount,
      dailyCap,
      tz: agent.timezone,
      quietStart: agent.quiet_hours_start,
      quietEnd: agent.quiet_hours_end,
      enforceWindow,
    })
    if (!verdict.canSend) {
      skipped++
      skips[verdict.reason] = (skips[verdict.reason] || 0) + 1
      // A cap/window block applies to everyone left too — stop early to save calls.
      if (verdict.reason === 'daily_cap_reached' || verdict.reason === 'outside_send_window') break
      continue
    }
    const body = personalize ? personalize(contact) : message
    try {
      await sendText(contact.phone.replace('+', ''), body, agent.wa_phone_number_id)
      // Both recipient sources are rows straight out of `contacts`, so the id is
      // always there; the `?? null` keeps the column nullable for an audience that
      // is only a phone number (see sendStatsKey, which keys on the same choice).
      /* node:coverage ignore next */
      await recordSend(agent.id, { contact_id: contact.id ?? null, phone: contact.phone, kind })
      sentNowByPhone.set(contact.phone, Date.now())
      sent++
      sentCount++
    } catch (err) {
      failed++
      if (err.code === 'WA_NOT_CONFIGURED') throw err // no point retrying the rest
    }
  }
  return { sent, failed, skipped, skips, recipients: recipients.length }
}

async function deliverFestiveGreeting(agent, message, { enforceWindow = false } = {}) {
  const recipients = await festiveRecipients(agent.id)
  return sendToRecipients(agent, recipients, message, 'festive', {
    enforceWindow,
    personalize: (contact) => personalizeGreeting(message, { name: contact.name, agent: agent.name }),
  })
}

// Send now, or schedule for later (send_at in the future).
app.post('/api/templates/festive/send', boundedText({ festival: TEXT.LINE, message: TEXT.WHATSAPP }), ah(async (req, res) => {
  const { festival, message, send_at } = req.body
  const fest = getFestival(festival)
  if (!fest) return res.status(400).json({ error: 'Unknown festival' })
  const body = (message || '').trim() || fest.default_message

  if (send_at) {
    const when = new Date(send_at)
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid send_at' })
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'send_at must be in the future' })
    const schedule = await createFestiveSchedule(req.agent.id, {
      festival_key: fest.key,
      message: body,
      send_at: when.toISOString(),
    })
    await logActivity(req.agent.id, null, 'agent', `${fest.name} greeting scheduled for ${when.toDateString()}`)
    return res.json({ scheduled: true, schedule })
  }

  try {
    const result = await deliverFestiveGreeting(req.agent, body)
    await logActivity(req.agent.id, null, 'agent', `${fest.name} greeting sent to ${result.sent} contacts`)
    res.json({ scheduled: false, ...result })
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message, code: err.code })
  }
}))

// Cancel a pending scheduled greeting.
app.delete('/api/templates/festive/:id', ah(async (req, res) => {
  const cancelled = await cancelFestiveSchedule(req.params.id, req.agent.id)
  if (!cancelled) return res.status(404).json({ error: 'not found or already sent' })
  res.json(cancelled)
}))

// --- Home dashboard: everything the agent needs to act on right now ---
app.get('/api/dashboard', ah(async (req, res) => res.json(await dashboard(req.agent.id))))

// --- Prioritised daily worklist: who to act on today, ranked. Rule-based, so it's
// fast, deterministic and explainable. Scores are recomputed (with decay) first so
// the ranking is honest — a lead that went quiet has already cooled down.
app.get('/api/worklist', ah(async (req, res) => {
  await recomputeAgentScores(req.agent.id)
  res.json(await worklist(req.agent.id))
}))

// --- Notification queue (written by the scheduler, read by the Today tab) ---
app.get('/api/notifications', ah(async (req, res) => {
  const [items, unread] = await Promise.all([
    listNotifications(req.agent.id, { unreadOnly: req.query.unread === '1' }),
    unreadNotificationCount(req.agent.id),
  ])
  res.json({ notifications: items, unread })
}))

app.post('/api/notifications/read-all', ah(async (req, res) =>
  res.json({ marked: await markAllNotificationsRead(req.agent.id) }),
))

app.put('/api/notifications/:id/read', ah(async (req, res) => {
  const n = await markNotificationRead(req.params.id, req.agent.id)
  if (!n) return res.status(404).json({ error: 'not found or already read' })
  res.json(n)
}))

// --- Property view analytics: surfaces property_page_views (written on every
// micro-page hit, previously read by nothing) — totals, trend, and who's looking.
app.get('/api/properties/:id/analytics', ah(async (req, res) => {
  const analytics = await propertyViewAnalytics(req.params.id, req.agent.id)
  if (!analytics) return res.status(404).json({ error: 'not found' })
  res.json(analytics)
}))

// --- Contact groups / segments + gated bulk send ---
app.get('/api/groups', ah(async (req, res) => res.json(await listGroups(req.agent.id))))

app.post('/api/groups', boundedText({ name: TEXT.LINE, color: TEXT.LINE, kind: TEXT.LINE }), ah(async (req, res) => {
  try {
    const group = await createGroup(req.agent.id, pick(req.body, ['name', 'color', 'kind', 'criteria']))
    res.json(group)
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'a group with that name exists' })
    res.status(400).json({ error: err.message })
  }
}))

app.get('/api/groups/:id/members', ah(async (req, res) => {
  const members = await groupMembers(req.params.id, req.agent.id)
  if (members === null) return res.status(404).json({ error: 'not found' })
  res.json(members)
}))

app.put('/api/groups/:id', boundedText({ name: TEXT.LINE, color: TEXT.LINE }), ah(async (req, res) => {
  const group = await updateGroup(req.params.id, req.agent.id, pick(req.body, ['name', 'color', 'criteria']))
  if (!group) return res.status(404).json({ error: 'not found' })
  res.json(group)
}))

app.delete('/api/groups/:id', ah(async (req, res) => {
  if (!(await deleteGroup(req.params.id, req.agent.id))) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

app.post('/api/groups/:id/members', ah(async (req, res) => {
  const ids = Array.isArray(req.body.contact_ids) ? req.body.contact_ids : []
  const added = await addGroupMembers(req.params.id, req.agent.id, ids)
  if (added === null) return res.status(400).json({ error: 'not found or not a static group' })
  res.json({ added })
}))

app.delete('/api/groups/:id/members/:contactId', ah(async (req, res) => {
  if (!(await removeGroupMember(req.params.id, req.agent.id, req.params.contactId)))
    return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

// One-click auto-grouping by locality / intent / temperature.
app.post('/api/groups/auto', ah(async (req, res) => {
  try {
    res.json(await autoGroupContacts(req.agent.id, req.body.by))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// Preview a dynamic segment without saving it.
app.post('/api/segments/preview', ah(async (req, res) =>
  res.json(await resolveSegment(req.agent.id, req.body.criteria || {})),
))

// Targeted bulk send to a group, every recipient gated by the send limiter — one
// relevant template instead of a blast, which is what keeps the quality rating green.
app.post('/api/groups/:id/send', boundedText({ message: TEXT.WHATSAPP }), ah(async (req, res) => {
  const message = (req.body.message || '').trim()
  if (!message) return res.status(400).json({ error: 'message is required' })
  const recipients = await groupMembers(req.params.id, req.agent.id)
  if (recipients === null) return res.status(404).json({ error: 'group not found' })
  try {
    const result = await sendToRecipients(req.agent, recipients, message, 'marketing', { enforceWindow: false })
    await logActivity(req.agent.id, null, 'agent', `Group blast to ${result.sent}/${recipients.length} (${result.skipped} skipped by limiter)`)
    res.json(result)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message, code: err.code })
  }
}))

// ===========================================================================
// Lead Source Integrations (§1.7, §3.1, §5.2)
// ===========================================================================

// Walk-in / phone lead: the 10-second "Add lead" form. Creates the lead + contact,
// tags the source, and returns a wa.me deep link the agent taps to open the thread
// (plus an instant template send when a lead-intro template is configured).
app.post('/api/leads/quick-add', boundedText({
  phone: TEXT.LINE, name: TEXT.LINE, channel: TEXT.LINE,
  message: TEXT.WHATSAPP, open_message: TEXT.WHATSAPP,
}), ah(async (req, res) => {
  const { phone, name, tags, channel = 'walk_in', message, open_message } = req.body
  if (!phone) return res.status(400).json({ error: 'phone required' })
  if (!['walk_in', 'phone'].includes(channel)) return res.status(400).json({ error: 'invalid channel' })
  const tagList = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').slice(0, 12) : []
  const result = await ingestLead({
    agent: req.agent, channel, name: name || null, phone,
    message: message || (tagList.length ? tagList.join(', ') : null),
    source_meta: { tags: tagList },
    autoReply: false, // walk-ins are opened by the agent via the deep link below
  })
  if (result.ok === false) return res.status(400).json({ error: 'Enter a valid phone number' })
  // Store tags as contact labels so they surface on the lead/contact.
  if (tagList.length && result.lead?.contact_id) {
    await updateContact(result.lead.contact_id, req.agent.id, { labels: tagList }).catch(() => {})
  }
  const opener = open_message ||
    `Hi ${name || 'there'}, thanks for connecting with ${req.agent.business_name || req.agent.name}. How can I help with your property search?`
  res.json({
    lead: result.lead,
    duplicate: Boolean(result.duplicate),
    wa_deeplink: waDeepLink(phone, opener),
  })
}))

// The workspace's lead-source hub: ingest email address, per-channel counts, and the
// recent ingestion feed (portal emails, lead ads, CTWA, walk-ins).
app.get('/api/lead-sources', ah(async (req, res) => {
  res.json({
    ingest_email: ingestAddress(req.agent.ingest_token),
    ingest_token: req.agent.ingest_token,
    stats: await leadSourceStats(req.agent.id),
    events: await listLeadSourceEvents(req.agent.id, { channel: req.query.channel || '', limit: req.query.limit }),
  })
}))

// Rotate the ingest address (invalidates the old one).
app.post('/api/lead-sources/regenerate', ah(async (req, res) => {
  const token = await regenerateIngestToken(req.agent.id)
  res.json({ ingest_token: token, ingest_email: ingestAddress(token) })
}))

// Map a Meta Lead Ads form to this agent so its leadgen webhooks route here.
// The mapping is what decides whose CRM an incoming lead lands in, so a form may
// only ever be claimed once: without this check any logged-in agent could point
// another workspace's form id at themselves and quietly receive that workspace's
// Meta Lead Ads leads. Re-claiming a form you already own stays idempotent.
app.post('/api/lead-sources/leadgen-form', ah(async (req, res) => {
  const formId = String(req.body.form_id || '').trim()
  if (!formId) return res.status(400).json({ error: 'form_id required' })
  if (formId.length > 100 || !/^[\w.:-]+$/.test(formId)) {
    return res.status(400).json({ error: 'form_id must be a plain Meta form identifier' })
  }
  const owner = await getMeta(`leadgen_form:${formId}`)
  if (owner && Number(owner) !== req.agent.id) {
    return res.status(409).json({
      error: 'That form is already connected to another HomeNex workspace.',
      code: 'FORM_TAKEN',
    })
  }
  await setMeta(`leadgen_form:${formId}`, String(req.agent.id))
  res.json({ ok: true, form_id: formId })
}))

// --- Direct portal API integrations (99acres / MagicBricks / Housing / NoBroker) ---
app.get('/api/portal-integrations', ah(async (req, res) =>
  res.json(await listPortalIntegrations(req.agent.id)),
))

app.put('/api/portal-integrations/:portal', boundedText({ api_key: TEXT.LINE, api_secret: TEXT.LINE }), ah(async (req, res) => {
  if (!SYNDICATION_PORTALS.includes(req.params.portal)) return res.status(400).json({ error: 'unknown portal' })
  const fields = pick(req.body, ['enabled', 'api_key', 'api_secret', 'config'])
  const row = await upsertPortalIntegration(req.agent.id, req.params.portal, fields)
  res.json(row)
}))

// --- Listing syndication: compose once, export portal-formatted content ---
app.get('/api/properties/:id/syndications', ah(async (req, res) => {
  const property = await getProperty(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'not found' })
  const saved = await listSyndications(req.agent.id, property.id)
  // Live preview for every portal, so the agent sees the formatted output before exporting.
  const preview = SYNDICATION_PORTALS.map((portal) => formatListingForPortal(property, portal))
  res.json({ portals: SYNDICATION_PORTALS, saved, preview })
}))

app.post('/api/properties/:id/syndicate', ah(async (req, res) => {
  const property = await getProperty(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'not found' })
  const portal = req.body.portal
  if (!SYNDICATION_PORTALS.includes(portal)) return res.status(400).json({ error: 'unknown portal' })
  const row = await syndicateProperty(req.agent, property, portal)
  await logActivity(req.agent.id, null, 'agent', `Exported "${property.title}" to ${portal}`)
  res.json(row)
}))

// --- Support tickets (§7.4): in-app Help. The agent opens/reads/answers their own
// tickets; staff handle them from the admin portal with full tenant context. ---
app.get('/api/support/tickets', ah(async (req, res) =>
  res.json(await listTickets({ agentId: req.agent.id, status: String(req.query.status || '').trim() })),
))

app.post('/api/support/tickets', boundedText({
  subject: TEXT.LINE, body: TEXT.PROSE, category: TEXT.LINE, priority: TEXT.LINE,
}), ah(async (req, res) => {
  try {
    const ticket = await createTicket(req.agent.id, pick(req.body, ['subject', 'body', 'category', 'priority']))
    res.json(ticket)
  } catch (err) {
    // createTicket reports both missing-field validation and bad column values the
    // same way — as the client's fault. Same shape as the reply route below.
    res.status(400).json({ error: err.message })
  }
}))

app.get('/api/support/tickets/:id', ah(async (req, res) => {
  const ticket = await getTicket(Number(req.params.id), { agentId: req.agent.id })
  if (!ticket) return res.status(404).json({ error: 'not found' })
  res.json(ticket)
}))

app.post('/api/support/tickets/:id/reply', boundedText({ body: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const msg = await addTicketMessage(
      Number(req.params.id),
      { authorAgentId: req.agent.id, isStaff: false, body: req.body.body },
      { agentId: req.agent.id },
    )
    res.json(msg)
  } catch (err) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message })
  }
}))

// --- Billing (§7.3): the agent sees their own plan, live usage and invoices. ---
app.get('/api/billing', ah(async (req, res) => res.json(await billingOverview(req.agent.id))))

app.get('/api/billing/invoices/:id', ah(async (req, res) => {
  const invoice = await getInvoice(Number(req.params.id), { agentId: req.agent.id })
  if (!invoice) return res.status(404).json({ error: 'not found' })
  res.json(invoice)
}))

// --- Template review request (§7.2): agent submits a draft for staff approval. ---
app.post('/api/templates/:id/request-review', ah(async (req, res) => {
  try {
    res.json(await requestTemplateReview(req.agent.id, Number(req.params.id)))
  } catch (err) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message })
  }
}))

// --- Team API (§5.3): team CRUD, roles, assignment, manager views. Privacy walls
// are enforced inside the router (see teamRoutes.js). ---
app.use('/api/team', teamRouter)

// --- Admin API (requires admin privileges; see adminRoutes.js) ---
app.use('/api/admin', adminRouter)

// A malformed path id is the caller's mistake, answered with a 400 before any
// handler runs. app.param() doesn't reach into a mounted Router, so each of the two
// sub-routers is armed separately.
validateIdParams(app)
validateIdParams(teamRouter)
validateIdParams(adminRouter)

// Dev/test endpoint: pushes a message through the SAME real pipeline (DB + AI),
// without an outbound WhatsApp send. Useful before the Meta webhook is wired up.
app.post('/api/simulate', boundedText({
  from: TEXT.LINE, name: TEXT.LINE, source: TEXT.LINE, text: TEXT.WHATSAPP,
}), ah(async (req, res) => {
  const { from = 'test-' + Date.now(), name = 'Test Buyer', text, source = 'Test', wa_message_id = null } = req.body
  if (!text) return res.status(400).json({ error: 'text required' })
  const result = await handleInbound({
    agentId: req.agent.id,
    brokerName: req.agent.name,
    waId: String(from),
    name,
    text,
    source,
    send: false,
    waMessageId: wa_message_id,
  })
  res.json(result)
}))

// Cache the live token probe so a polling dashboard doesn't hit the Graph API on every request.
let waTokenCache = { at: 0, result: null }
async function waTokenStatus() {
  if (!whatsappConfigured()) return { ok: false, reason: 'not_configured' }
  const now = Date.now()
  if (waTokenCache.result && now - waTokenCache.at < 60_000) return waTokenCache.result
  const result = await checkToken()
  waTokenCache = { at: now, result }
  return result
}

app.get('/api/health', ah(async (_req, res) => {
  // whatsapp = credentials present; whatsapp_send = the token can actually send right now.
  const token = await waTokenStatus()
  res.json({
    ok: true,
    whatsapp: whatsappConfigured(),
    whatsapp_send: token.ok,
    whatsapp_reason: token.ok ? undefined : (token.expired ? 'token_expired' : token.reason),
    ai: aiConfigured(),
    signature: Boolean(WHATSAPP_APP_SECRET),
  })
}))

// --- Public property micro-page: /p/:slug — shareable in broker groups, no auth.
// Every hit is recorded as an engagement signal on the property.
app.get('/p/:slug', ah(async (req, res) => {
  const property = await getPropertyBySlug(req.params.slug)
  if (!property) {
    return res.status(404).send('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:sans-serif;text-align:center;margin-top:20vh">🏠 This property page is no longer available.</p>')
  }
  // ?l=<leadId> attributes the view to a lead (set on the tracked share link). Only
  // honour it when that lead belongs to this property's owner — no cross-tenant leak.
  let leadId = Number(req.query.l)
  if (!Number.isInteger(leadId) || leadId <= 0) leadId = null
  else {
    const owner = await getLeadForAgent(leadId, property.agent_id)
    if (!owner) leadId = null
  }
  recordPropertyView(property.id, req.get('referer') || null, leadId).catch((err) =>
    console.error('page view tracking failed', err),
  )
  res.type('html').send(renderMicroPage(property))
}))

// Public legal pages — needed for Meta app review (Privacy Policy + Terms URLs).
// Must be registered before the SPA catch-all so they aren't swallowed by index.html.
app.get('/privacy', (_req, res) => res.type('html').send(privacyPage()))
app.get('/terms', (_req, res) => res.type('html').send(termsPage()))

// In-app WhatsApp Business onboarding guide, linked from Settings. Public (no auth)
// so it can be opened in a new tab and shared with agents who aren't signed in yet.
app.get('/setup-guide', (_req, res) => res.type('html').send(setupGuidePage()))

// Serve the built admin site at /admin (built with `npm run build:admin`).
const adminDist = path.join(__dirname, '..', 'admin', 'dist')
app.use('/admin', express.static(adminDist))
app.get(/^\/admin(\/.*)?$/, (_req, res) => res.sendFile(path.join(adminDist, 'index.html')))

// Unknown /api routes must return JSON, not the SPA's index.html — otherwise a
// client typo silently gets a 200 HTML page and a confusing JSON-parse failure.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }))

// Serve the built dashboard so one process hosts everything in production.
const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get(/^\/(?!api|webhook|admin).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))

// Last-resort error handler. Malformed JSON and over-limit bodies are the client's
// fault (400/413), not a server failure — map them so callers get an actionable code
// instead of a generic 500. Everything else is an unexpected server error.
app.use((err, _req, res, _next) => {
  if (res.headersSent) return
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid request body — expected valid JSON.', code: 'BAD_JSON' })
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large.', code: 'PAYLOAD_TOO_LARGE' })
  }
  // A client-supplied foreign id that doesn't belong to this agent (db.assertOwned).
  // 404 rather than 403 — telling them it exists but isn't theirs is itself a leak.
  if (err.code === 'NOT_OWNED') {
    return res.status(404).json({ error: err.message, code: 'NOT_FOUND' })
  }
  console.error('unhandled error', err)
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' })
})

// Migrations must be applied before any request touches the schema.
await ready

// Deliver due festive greetings. Runs once a minute in production; exported so
// tests can drive it directly.
export async function deliverDueFestiveSchedules() {
  const due = await claimDueFestiveSchedules()
  if (!due.length) return 0
  // One read for every agent with a greeting due, rather than one inside the loop: a
  // festival is the one moment every agent on the box has a schedule land in the same
  // minute, which is exactly when the extra round trips are least affordable.
  const agents = await getAgentsByIds(due.map((s) => s.agent_id))
  for (const schedule of due) {
    try {
      const agent = agents.get(schedule.agent_id)
      // festive_schedules.agent_id is a foreign key and the two queries run back to
      // back, so the lookup always hits. Throwing rather than skipping means a
      // schedule for a vanished agent is marked failed instead of retried forever.
      /* node:coverage ignore next */
      if (!agent) throw new Error(`agent ${schedule.agent_id} no longer exists`)
      const fest = getFestival(schedule.festival_key)
      // A scheduled delivery is automated — enforce the quiet-hours/night window.
      const result = await deliverFestiveGreeting(agent, schedule.message, { enforceWindow: true })
      await finishFestiveSchedule(schedule.id, { sentCount: result.sent })
      await logActivity(agent.id, null, 'agent', `${fest?.name || schedule.festival_key} greeting delivered to ${result.sent} contacts`)
    } catch (err) {
      console.error(`festive schedule #${schedule.id} delivery failed:`, err.message)
      await finishFestiveSchedule(schedule.id, { sentCount: 0, failed: true }).catch(() => {})
    }
  }
  return due.length
}

// Start listening only when run directly (`node index.js`), not when imported by tests.
//
// Coverage is switched off for the whole block rather than left showing red. It is
// not untested — serverProcess.test.js spawns a real `node` process with NODE_ENV
// unset and drives the boot banner, the once-a-minute job tick and all four ways the
// process can be asked to stop. That child is a separate process with no coverage
// instrumentation, so none of what it exercises can be credited here, and the guard
// on the next line is precisely what stops this running in the measured process.
/* node:coverage disable */
if (process.env.NODE_ENV !== 'test') {
  // A rejected promise or thrown error with no local handler must be logged, never
  // swallowed silently. We keep running on an unhandled rejection (usually one bad
  // request, not a corrupt process) but treat an uncaught exception as fatal and shut
  // down cleanly — the process manager (systemd) restarts us into a known-good state.
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason instanceof Error ? reason.stack : reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err.stack || err)
    shutdown('uncaughtException', 1)
  })

  // One tick a minute drives every background job: festive delivery plus the
  // scheduler's due jobs (service-window watch, hot-lead detection, stale-lead
  // follow-ups, score decay, site-visit reminders, commission sweep).
  const jobTimer = setInterval(() => {
    deliverDueFestiveSchedules().catch((err) => console.error('festive scheduler error', err))
    runDueJobs().catch((err) => console.error('scheduler error', err))
  }, 60_000)

  const server = app.listen(PORT, () => {
    console.log(`HomeNex server on :${PORT}`)
    if (!whatsappConfigured()) console.log('⚠ WhatsApp credentials missing — dashboard works, sends disabled')
    if (!aiConfigured()) console.log('⚠ OPENROUTER_API_KEY missing — AI replies/extraction disabled')
    if (!WHATSAPP_APP_SECRET) {
      console.log(
        process.env.NODE_ENV === 'production'
          ? '⚠ WHATSAPP_APP_SECRET missing — inbound webhooks are being REJECTED (401) until it is set'
          : '⚠ WHATSAPP_APP_SECRET missing — webhook signature check disabled (dev only)',
      )
    }
  })

  // Graceful shutdown: stop the background jobs and rate-limit sweeps, stop accepting
  // new connections, drain the Postgres pool, then exit. A backstop timer force-exits
  // if a hung connection won't drain, so a deploy is never blocked indefinitely.
  let shuttingDown = false
  async function shutdown(signal, code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n${signal} received — shutting down gracefully…`)
    clearInterval(jobTimer)
    for (const limiter of rateLimiters) limiter.stop?.()
    const force = setTimeout(() => {
      console.error('shutdown timed out — forcing exit')
      process.exit(code || 1)
    }, 10_000)
    force.unref()
    server.close(async () => {
      try {
        await closePool()
      } catch (err) {
        console.error('error closing pool', err.message)
      }
      clearTimeout(force)
      process.exit(code)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
/* node:coverage enable */

export { app }
