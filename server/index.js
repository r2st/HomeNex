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
  listActivity,
  setAiEnabled,
  listNetworkPosts,
  addNetworkPost,
  computeMatches,
  stats,
  findContactByWaId,
  recordContactMessage,
  listContacts,
  getContactDetail,
  getContactByPhone,
  addContact,
  updateContact,
  deleteContact,
  attachLeadContact,
  updateLeadName,
  updateLeadCrm,
  setLeadStage,
  listPipelineStages,
  createProperty,
  listProperties,
  getProperty,
  updateProperty,
  deleteProperty,
  createFollowup,
  listFollowups,
  updateFollowup,
  createSiteVisit,
  listSiteVisits,
  updateSiteVisit,
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
  createFestiveSchedule,
  listFestiveSchedules,
  cancelFestiveSchedule,
  claimDueFestiveSchedules,
  finishFestiveSchedule,
  festiveRecipients,
  computeLeadDecay,
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
  contactSendStats,
  ensureBulkSendStarted,
  createGroup,
  listGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  groupMembers,
  addGroupMembers,
  removeGroupMember,
  autoGroupContacts,
  resolveSegment,
} from './db.js'
import { paiseToDisplay } from './money.js'
import { generateReply, extractLead, suggestReplies, aiConfigured } from './ai.js'
import { emiReplyFor, parseEmiQuery, formatEmiMessage } from './emi.js'
import { FESTIVALS, getFestival, personalizeGreeting } from './festivals.js'
import { renderMicroPage } from './micropage.js'
import { buildBriefing } from './briefing.js'
import { evaluateSend, warmupDailyCap, SEND_BLOCK_REASONS } from './sendLimiter.js'
import { runDueJobs } from './scheduler.js'
import { sendText, markRead, whatsappConfigured } from './whatsapp.js'
import { signup, login, changePhone, changePassword, requireAuth } from './auth.js'
import { handleAgentCommand } from './agentCommands.js'
import adminRouter from './adminRoutes.js'

const { PORT = 8787, WHATSAPP_VERIFY_TOKEN = 'homenex-verify', WHATSAPP_APP_SECRET } = process.env

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

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
)

function verifySignature(req) {
  if (!WHATSAPP_APP_SECRET) return true // signature check requires the app secret
  const sig = req.get('x-hub-signature-256')
  if (!sig || !req.rawBody) return false
  const expected =
    'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(req.rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  } catch {
    return false
  }
}

// Core pipeline for one inbound buyer message on the shared WhatsApp number:
// persist -> AI reply -> WhatsApp send (from the shared number) -> extract BLTC.
// agentId is null for the unassigned pool (an unknown sender); brokerName personalises the AI.
async function handleInbound({ agentId = null, brokerName, waId, name, text, source = 'WhatsApp', phoneNumberId = null, send = true }) {
  const lead = agentId ? await upsertLead(agentId, waId, name) : await upsertUnassignedLead(waId, name)
  const isNewLead = !lead.ai_summary && (await getMessages(lead.id, 1)).length === 0
  await addMessage(lead.id, 'buyer', text)
  await recordContactMessage(waId) // stamp first/last message time on the CRM contact, if known
  // CRM: link the lead to its auto-captured contact and drop it into the pipeline.
  if (agentId) {
    const contact = await getContactByPhone(waId)
    if (contact?.agent_id === agentId) await attachLeadContact(lead.id, contact.id)
  }
  if (isNewLead) {
    await logActivity(agentId, lead.id, 'lead', agentId
      ? `New lead: ${name || waId} via ${source}`
      : `Unclaimed lead: ${name || waId} messaged the shared number`)
  }

  let reply = null
  if (lead.ai_enabled) {
    // EMI questions get an instant, deterministic calculation — no AI round-trip,
    // and it works even when the AI provider is down.
    reply = emiReplyFor(text) || (await generateReply(await getMessages(lead.id), brokerName))
    if (reply) {
      let waMsgId = null
      if (send) {
        try {
          waMsgId = await sendText(waId, reply, phoneNumberId)
        } catch (err) {
          console.error(err.message)
          await logActivity(agentId, lead.id, 'error', `WhatsApp send failed for ${name || waId}`)
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
      if (updated.temp === 'Hot' && prevTemp !== 'Hot')
        await logActivity(agentId, lead.id, 'hot', `${updated.name || waId} is now HOT (score ${updated.score})`)
      else if (x.score != null)
        await logActivity(agentId, lead.id, 'ai', `${updated.name || waId} re-scored: ${updated.score}/100`)
    }
  } catch (err) {
    console.error('extraction failed', err)
  }

  return { lead: await getLead(lead.id), reply }
}

// --- Meta webhook verification (GET) ---
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === WHATSAPP_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query['hub.challenge'])
  }
  res.sendStatus(403)
})

// --- Real incoming WhatsApp messages (POST) ---
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401)
  res.sendStatus(200) // ack fast; Meta retries on timeout

  ;(async () => {
    for (const entry of req.body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        const waProfileName = value?.contacts?.[0]?.profile?.name
        // Which WhatsApp Business number received this message?
        const phoneNumberId = value?.metadata?.phone_number_id
        // Per-agent routing: if this phone_number_id belongs to a specific agent,
        // every message on that line belongs to them (no shared pool needed).
        const lineOwner = await findAgentByPhoneNumberId(phoneNumberId)
        for (const msg of value?.messages ?? []) {
          // FIRST: is the sender one of our registered agents? Then this is an agent
          // command (add a client, list clients, ...), not a buyer conversation.
          const agent = await findAgentByPhone(msg.from)
          if (agent) {
            markRead(msg.id, phoneNumberId)
            await handleAgentCommand({ agent, msg, phoneNumberId })
            continue
          }
          if (msg.type !== 'text') continue
          markRead(msg.id, phoneNumberId)

          // Per-agent line: if this number belongs to a specific agent, route directly
          // to them. The sender is auto-remembered as a contact for future reference.
          if (lineOwner) {
            try {
              await addContact(lineOwner.id, msg.from, waProfileName || msg.from)
              await logActivity(lineOwner.id, null, 'lead', `Auto-added client: ${waProfileName || msg.from} (${msg.from})`)
            } catch { /* already exists */ }
            await handleInbound({
              agentId: lineOwner.id,
              brokerName: lineOwner.name,
              waId: msg.from,
              name: waProfileName,
              text: msg.text.body,
              phoneNumberId,
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
              text: msg.text.body,
              phoneNumberId,
            })
          } else {
            // Unknown sender on a shared number → unassigned pool, visible to all agents to claim.
            await handleInbound({
              agentId: null,
              brokerName: 'the HomeNex team',
              waId: msg.from,
              name: waProfileName,
              text: msg.text.body,
              phoneNumberId,
            })
          }
        }
      }
    }
  })().catch((err) => console.error('webhook processing error', err))
})

// --- Auth: one-screen signup (name, phone, email, password) and login ---
app.post('/api/auth/signup', ah(async (req, res) => {
  try {
    res.json(await signup(req.body ?? {}))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

app.post('/api/auth/login', ah(async (req, res) => {
  try {
    res.json(await login(req.body ?? {}))
  } catch (err) {
    // 403, not 401: the credentials were right, the account is suspended.
    res.status(err.code === 'DEACTIVATED' ? 403 : 401).json({ error: err.message })
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
app.put('/api/agent/phone', ah(async (req, res) => {
  const { phone, password } = req.body ?? {}
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
app.put('/api/agent/password', ah(async (req, res) => {
  const { current_password, new_password } = req.body ?? {}
  try {
    const agent = await changePassword(req.agent.id, { current_password, new_password })
    await logAudit(agent.id, 'agent', agent.id, 'password_changed', {})
    res.json(agent)
  } catch (err) {
    res.status(PASSWORD_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// Agent edits their own profile. Phone lives on PUT /api/agent/phone (password-gated).
const PROFILE_FIELDS = ['name', 'email', 'business_name', 'city', 'bio', 'rera_id', 'avatar_url']
const PROFILE_ERROR_STATUS = { EMAIL_TAKEN: 409, NOT_FOUND: 404 }
app.put('/api/agent/profile', ah(async (req, res) => {
  const fields = pick(req.body ?? {}, PROFILE_FIELDS)
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
app.put('/api/agent/preferences', ah(async (req, res) => {
  const fields = pick(req.body ?? {}, PREFERENCE_FIELDS)
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

app.put('/api/agent/phone-config', ah(async (req, res) => {
  const { wa_phone_number, wa_phone_number_id } = req.body ?? {}
  try {
    const agent = await updateAgentPhoneConfig(req.agent.id, wa_phone_number || null, wa_phone_number_id || null)
    res.json(agent)
  } catch (err) {
    res.status(err.code === 'PHONE_ID_TAKEN' ? 409 : 400).json({ error: err.message })
  }
}))

// Agent sets/updates their WA Business phone number (for WABA registration).
app.put('/api/agent/wa-phone', ah(async (req, res) => {
  const { wa_phone_number } = req.body ?? {}
  if (!wa_phone_number) return res.status(400).json({ error: 'wa_phone_number is required' })
  try {
    const norm = normalizePhone(wa_phone_number)
    if (norm.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter a valid phone number' })
    // Must differ from personal number
    if (norm === req.agent.phone) {
      return res.status(400).json({ error: 'Your WhatsApp Business number must be different from your personal WhatsApp number' })
    }
    res.json(await setAgentWaPhone(req.agent.id, norm))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// --- Dashboard API — every route is scoped to the logged-in agent. ---
app.get('/api/leads', ah(async (req, res) =>
  res.json(await listLeads(req.agent.id, {
    pipelineType: req.query.pipeline_type || '',
    stage: req.query.stage || '',
  })),
))

app.get('/api/leads/:id', ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const decay = await computeLeadDecay(lead)
  res.json({
    ...lead,
    // Fresh decayed scoring, computed live so the label is never "was hot once".
    effective_score: decay.effectiveScore,
    effective_temp: decay.temperature,
    engagement_score: decay.engagementScore,
    score_factors: decay.factors,
    service_window: serviceWindow(lead),
    messages: await getMessages(lead.id),
    followups: await listFollowups(req.agent.id, { leadId: lead.id }),
    site_visits: await listSiteVisits(req.agent.id, { leadId: lead.id }),
    contact: lead.contact_id ? await getContactDetail(lead.contact_id, req.agent.id).then((c) => c && { ...c, leads: undefined }) : null,
  })
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
  } catch (err) {
    console.error('suggestions failed', err)
    res.json({ suggestions: [] })
  }
}))

// Update a lead's CRM fields (budget in paise, BHK, property type, localities, ...).
app.put('/api/leads/:id', ah(async (req, res) => {
  const fields = pick(req.body ?? {}, [
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
app.put('/api/leads/:id/stage', ah(async (req, res) => {
  const { stage, lost_reason } = req.body ?? {}
  if (!stage) return res.status(400).json({ error: 'stage is required' })
  try {
    const lead = await setLeadStage(req.params.id, req.agent.id, { stage, lost_reason })
    if (!lead) return res.status(404).json({ error: 'not found' })
    await logActivity(req.agent.id, lead.id, 'agent',
      `${lead.name || lead.wa_id} moved to ${stage}${stage === 'Lost' ? ` (${lead.lost_reason})` : ''}`)
    await logAudit(req.agent.id, 'lead', lead.id, 'stage_change', { stage, lost_reason: lead.lost_reason })
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

// Claim an unassigned lead from the shared pool, and remember the sender as a client.
app.post('/api/leads/:id/assign', ah(async (req, res) => {
  const lead = await assignLead(req.params.id, req.agent.id)
  if (!lead) return res.status(409).json({ error: 'lead is not available to claim' })
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
  await setAiEnabled(lead.id, Boolean(req.body?.enabled))
  await logActivity(
    req.agent.id,
    lead.id,
    'agent',
    req.body?.enabled
      ? `AI re-enabled for ${lead.name || lead.wa_id}`
      : `${req.agent.name} took over the chat with ${lead.name || lead.wa_id}`,
  )
  res.json(await getLead(lead.id))
}))

// Agent sends a real WhatsApp message from the dashboard. Outside the 24-hour
// service window Meta only accepts template messages, so free-text replies are
// rejected with 409 and the client must send a template (template_id) instead.
app.post('/api/leads/:id/reply', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })

  const templateId = req.body?.template_id
  let text
  if (templateId) {
    const tpl = (await listMessageTemplates(req.agent.id)).find((t) => t.id === Number(templateId))
    if (!tpl) return res.status(404).json({ error: 'template not found' })
    text = tpl.body
  } else {
    text = (req.body?.text || '').trim()
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
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
}))

// --- EMI calculator: agents can compute an EMI for any client question ---
app.post('/api/emi', ah(async (req, res) => {
  const { text, principal_l, rate_pct, years } = req.body ?? {}
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
app.get('/api/contacts', ah(async (req, res) =>
  res.json(await listContacts(req.agent.id, { search: req.query.q || '', source: req.query.source || '' })),
))

app.get('/api/contacts/:id', ah(async (req, res) => {
  const contact = await getContactDetail(req.params.id, req.agent.id)
  if (!contact) return res.status(404).json({ error: 'not found' })
  res.json(contact)
}))

app.put('/api/contacts/:id', ah(async (req, res) => {
  try {
    const contact = await updateContact(
      req.params.id,
      req.agent.id,
      pick(req.body ?? {}, ['name', 'notes', 'opt_in_status', 'labels']),
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
app.post('/api/network', ah(async (req, res) => {
  const p = req.body ?? {}
  if (!p.type || !p.broker || !p.text) return res.status(400).json({ error: 'type, broker, text required' })
  if (!['INVENTORY', 'REQUIREMENT'].includes(p.type)) return res.status(400).json({ error: 'bad type' })
  res.json(await addNetworkPost(p))
}))

// --- Properties: the agent's inventory ---
const PROPERTY_BODY_FIELDS = [
  'title', 'property_type', 'bhk', 'size_sqft', 'size_unit', 'price_paise', 'locality', 'city',
  'status', 'rera_project_number', 'builder_name', 'owner_name', 'facing', 'floor', 'total_floors',
  'amenities', 'photos', 'brochure_url', 'video_url', 'notes',
]

app.get('/api/properties', ah(async (req, res) =>
  res.json(await listProperties(req.agent.id, {
    status: req.query.status || '',
    propertyType: req.query.type || '',
    bhk: req.query.bhk || '',
    locality: req.query.locality || '',
    city: req.query.city || '',
    minPrice: req.query.min_price ? Number(req.query.min_price) : null,
    maxPrice: req.query.max_price ? Number(req.query.max_price) : null,
    search: req.query.q || '',
  })),
))

app.get('/api/properties/:id', ah(async (req, res) => {
  const property = await getProperty(req.params.id, req.agent.id)
  if (!property) return res.status(404).json({ error: 'not found' })
  res.json(property)
}))

app.post('/api/properties', ah(async (req, res) => {
  try {
    const property = await createProperty(req.agent.id, pick(req.body ?? {}, PROPERTY_BODY_FIELDS))
    await logAudit(req.agent.id, 'property', property.id, 'create', { title: property.title })
    res.json(property)
  } catch (err) {
    if (!pgBadRequest(err) && !/title is required/.test(err.message)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/properties/:id', ah(async (req, res) => {
  try {
    const property = await updateProperty(req.params.id, req.agent.id, pick(req.body ?? {}, PROPERTY_BODY_FIELDS))
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
  const { lead_id } = req.body ?? {}
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
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
}))

// --- Follow-ups & reminders ---
app.get('/api/followups', ah(async (req, res) =>
  res.json(await listFollowups(req.agent.id, {
    pendingOnly: req.query.pending === '1',
    today: req.query.today === '1',
    leadId: req.query.lead_id || null,
  })),
))

app.post('/api/followups', ah(async (req, res) => {
  const { lead_id, due_at, note, type } = req.body ?? {}
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

app.put('/api/followups/:id', ah(async (req, res) => {
  try {
    const followup = await updateFollowup(
      req.params.id,
      req.agent.id,
      pick(req.body ?? {}, ['completed', 'due_at', 'note', 'type']),
    )
    if (!followup) return res.status(404).json({ error: 'not found' })
    res.json(followup)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

// --- Site visits ---
app.get('/api/site-visits', ah(async (req, res) =>
  res.json(await listSiteVisits(req.agent.id, {
    leadId: req.query.lead_id || null,
    status: req.query.status || '',
    today: req.query.today === '1',
  })),
))

app.post('/api/site-visits', ah(async (req, res) => {
  const { lead_id, property_id, scheduled_at, pickup_required, pickup_location, builder_preregistered } = req.body ?? {}
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
    res.json(visit)
  } catch (err) {
    if (!pgBadRequest(err)) throw err
    res.status(400).json({ error: err.message })
  }
}))

app.put('/api/site-visits/:id', ah(async (req, res) => {
  try {
    const visit = await updateSiteVisit(
      req.params.id,
      req.agent.id,
      pick(req.body ?? {}, [
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

// --- Message templates (used by the template-only composer after the 24h window) ---
app.get('/api/templates', ah(async (req, res) => res.json(await listMessageTemplates(req.agent.id))))

app.post('/api/templates', ah(async (req, res) => {
  try {
    res.json(await createMessageTemplate(req.agent.id, pick(req.body ?? {}, ['name', 'category', 'body', 'variables', 'rera_auto_append'])))
  } catch (err) {
    if (!pgBadRequest(err) && !/name and body are required/.test(err.message) && err.code !== '23505') throw err
    res.status(400).json({ error: err.message })
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
  for (const contact of recipients) {
    const stats = await contactSendStats(agent.id, contact.id ?? null, contact.phone)
    const verdict = evaluateSend({
      optInStatus: contact.opt_in_status,
      lastSentToContactAt: stats.lastSentAt,
      contactSendsThisMonth: stats.monthCount,
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
      await recordSend(agent.id, { contact_id: contact.id ?? null, phone: contact.phone, kind })
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
app.post('/api/templates/festive/send', ah(async (req, res) => {
  const { festival, message, send_at } = req.body ?? {}
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
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
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

app.post('/api/groups', ah(async (req, res) => {
  try {
    const group = await createGroup(req.agent.id, pick(req.body ?? {}, ['name', 'color', 'kind', 'criteria']))
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

app.put('/api/groups/:id', ah(async (req, res) => {
  const group = await updateGroup(req.params.id, req.agent.id, pick(req.body ?? {}, ['name', 'color', 'criteria']))
  if (!group) return res.status(404).json({ error: 'not found' })
  res.json(group)
}))

app.delete('/api/groups/:id', ah(async (req, res) => {
  if (!(await deleteGroup(req.params.id, req.agent.id))) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
}))

app.post('/api/groups/:id/members', ah(async (req, res) => {
  const ids = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : []
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
    res.json(await autoGroupContacts(req.agent.id, req.body?.by))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// Preview a dynamic segment without saving it.
app.post('/api/segments/preview', ah(async (req, res) =>
  res.json(await resolveSegment(req.agent.id, req.body?.criteria || {})),
))

// Targeted bulk send to a group, every recipient gated by the send limiter — one
// relevant template instead of a blast, which is what keeps the quality rating green.
app.post('/api/groups/:id/send', ah(async (req, res) => {
  const message = (req.body?.message || '').trim()
  if (!message) return res.status(400).json({ error: 'message is required' })
  const recipients = await groupMembers(req.params.id, req.agent.id)
  if (recipients === null) return res.status(404).json({ error: 'group not found' })
  try {
    const result = await sendToRecipients(req.agent, recipients, message, 'marketing', { enforceWindow: false })
    await logActivity(req.agent.id, null, 'agent', `Group blast to ${result.sent}/${recipients.length} (${result.skipped} skipped by limiter)`)
    res.json(result)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
}))

// --- Admin API (requires admin privileges; see adminRoutes.js) ---
app.use('/api/admin', adminRouter)

// Dev/test endpoint: pushes a message through the SAME real pipeline (DB + AI),
// without an outbound WhatsApp send. Useful before the Meta webhook is wired up.
app.post('/api/simulate', ah(async (req, res) => {
  const { from = 'test-' + Date.now(), name = 'Test Buyer', text, source = 'Test' } = req.body ?? {}
  if (!text) return res.status(400).json({ error: 'text required' })
  const result = await handleInbound({
    agentId: req.agent.id,
    brokerName: req.agent.name,
    waId: String(from),
    name,
    text,
    source,
    send: false,
  })
  res.json(result)
}))

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    whatsapp: whatsappConfigured(),
    ai: aiConfigured(),
    signature: Boolean(WHATSAPP_APP_SECRET),
  }),
)

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

// Serve the built admin site at /admin (built with `npm run build:admin`).
const adminDist = path.join(__dirname, '..', 'admin', 'dist')
app.use('/admin', express.static(adminDist))
app.get(/^\/admin(\/.*)?$/, (_req, res) => res.sendFile(path.join(adminDist, 'index.html')))

// Serve the built dashboard so one process hosts everything in production.
const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get(/^\/(?!api|webhook|admin).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))

// Last-resort error handler so unexpected DB failures return JSON, not an HTML stack.
app.use((err, _req, res, _next) => {
  console.error('unhandled error', err)
  if (!res.headersSent) res.status(500).json({ error: 'internal error' })
})

// Migrations must be applied before any request touches the schema.
await ready

// Deliver due festive greetings. Runs once a minute in production; exported so
// tests can drive it directly.
export async function deliverDueFestiveSchedules() {
  const due = await claimDueFestiveSchedules()
  for (const schedule of due) {
    try {
      const agent = await getAgent(schedule.agent_id)
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
if (process.env.NODE_ENV !== 'test') {
  // One tick a minute drives every background job: festive delivery plus the
  // scheduler's due jobs (service-window watch, hot-lead detection, stale-lead
  // follow-ups, score decay, site-visit reminders, commission sweep).
  setInterval(() => {
    deliverDueFestiveSchedules().catch((err) => console.error('festive scheduler error', err))
    runDueJobs().catch((err) => console.error('scheduler error', err))
  }, 60_000)
  app.listen(PORT, () => {
    console.log(`HomeNex server on :${PORT}`)
    if (!whatsappConfigured()) console.log('⚠ WhatsApp credentials missing — dashboard works, sends disabled')
    if (!aiConfigured()) console.log('⚠ OPENROUTER_API_KEY missing — AI replies/extraction disabled')
    if (!WHATSAPP_APP_SECRET) console.log('⚠ WHATSAPP_APP_SECRET missing — webhook signature check disabled')
  })
}

export { app }
