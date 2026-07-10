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
  addContact,
  bulkAddContacts,
  deleteContact,
  normalizePhone,
} from './db.js'
import { generateReply, extractLead, aiConfigured } from './ai.js'
import { sendText, markRead, whatsappConfigured } from './whatsapp.js'
import { signup, login, requireAuth } from './auth.js'
import { handleAgentCommand } from './agentCommands.js'
import adminRouter from './adminRoutes.js'

const { PORT = 8787, WHATSAPP_VERIFY_TOKEN = 'homenex-verify', WHATSAPP_APP_SECRET } = process.env

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// Express 4 doesn't forward rejected-promise errors from async handlers; wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

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
  if (isNewLead) {
    await logActivity(agentId, lead.id, 'lead', agentId
      ? `New lead: ${name || waId} via ${source}`
      : `Unclaimed lead: ${name || waId} messaged the shared number`)
  }

  let reply = null
  if (lead.ai_enabled) {
    reply = await generateReply(await getMessages(lead.id), brokerName)
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
    res.status(401).json({ error: err.message })
  }
}))

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.agent))

// Everything below requires a logged-in agent.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  requireAuth(req, res, next)
})

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
app.get('/api/leads', ah(async (req, res) => res.json(await listLeads(req.agent.id))))

app.get('/api/leads/:id', ah(async (req, res) => {
  const lead = await getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json({ ...lead, messages: await getMessages(lead.id) })
}))

// Claim an unassigned lead from the shared pool, and remember the sender as a client.
app.post('/api/leads/:id/assign', ah(async (req, res) => {
  const lead = await assignLead(req.params.id, req.agent.id)
  if (!lead) return res.status(409).json({ error: 'lead is not available to claim' })
  try {
    await addContact(req.agent.id, lead.wa_id, lead.name || lead.wa_id)
  } catch {
    // Already a contact (or claimed elsewhere) — assignment still stands.
  }
  await logActivity(req.agent.id, lead.id, 'agent', `${req.agent.name} claimed ${lead.name || lead.wa_id}`)
  res.json(lead)
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

// Agent sends a real WhatsApp message from the dashboard.
app.post('/api/leads/:id/reply', ah(async (req, res) => {
  const lead = await getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const text = (req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const waMsgId = await sendText(lead.wa_id, text, req.agent.wa_phone_number_id)
    const msg = await addMessage(lead.id, 'agent', text, waMsgId)
    await recordFirstResponse(lead.id)
    res.json(msg)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
}))

// --- Contacts (My Clients): the agent's known numbers on the shared line ---
app.get('/api/contacts', ah(async (req, res) => res.json(await listContacts(req.agent.id))))

app.post('/api/contacts', ah(async (req, res) => {
  const { phone, name, notes } = req.body ?? {}
  if (!phone || !name) return res.status(400).json({ error: 'phone and name are required' })
  try {
    res.json(await addContact(req.agent.id, phone, name, notes))
  } catch (err) {
    res.status(err.code === 'CONTACT_EXISTS' ? 409 : 400).json({ error: err.message })
  }
}))

app.post('/api/contacts/bulk', ah(async (req, res) => {
  const rows = req.body?.contacts
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'contacts array required' })
  res.json(await bulkAddContacts(req.agent.id, rows))
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

// Start listening only when run directly (`node index.js`), not when imported by tests.
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`HomeNex server on :${PORT}`)
    if (!whatsappConfigured()) console.log('⚠ WhatsApp credentials missing — dashboard works, sends disabled')
    if (!aiConfigured()) console.log('⚠ OPENROUTER_API_KEY missing — AI replies/extraction disabled')
    if (!WHATSAPP_APP_SECRET) console.log('⚠ WHATSAPP_APP_SECRET missing — webhook signature check disabled')
  })
}

export { app }
