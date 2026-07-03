import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  upsertLead,
  upsertUnassignedLead,
  assignLead,
  getLead,
  getLeadForAgent,
  getAssignableLead,
  getAgent,
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
  listContacts,
  addContact,
  bulkAddContacts,
  deleteContact,
} from './db.js'
import { generateReply, extractLead, aiConfigured } from './ai.js'
import { sendText, markRead, whatsappConfigured } from './whatsapp.js'
import { signup, login, requireAuth } from './auth.js'

const { PORT = 8787, WHATSAPP_VERIFY_TOKEN = 'homenex-verify', WHATSAPP_APP_SECRET } = process.env

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

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
  const lead = agentId ? upsertLead(agentId, waId, name) : upsertUnassignedLead(waId, name)
  const isNewLead = !lead.ai_summary && getMessages(lead.id, 1).length === 0
  addMessage(lead.id, 'buyer', text)
  if (isNewLead) {
    logActivity(agentId, lead.id, 'lead', agentId
      ? `New lead: ${name || waId} via ${source}`
      : `Unclaimed lead: ${name || waId} messaged the shared number`)
  }

  let reply = null
  if (lead.ai_enabled) {
    reply = await generateReply(getMessages(lead.id), brokerName)
    if (reply) {
      let waMsgId = null
      if (send) {
        try {
          waMsgId = await sendText(waId, reply, phoneNumberId)
        } catch (err) {
          console.error(err.message)
          logActivity(agentId, lead.id, 'error', `WhatsApp send failed for ${name || waId}`)
        }
      }
      addMessage(lead.id, 'ai', reply, waMsgId)
      recordFirstResponse(lead.id)
    }
  }

  // Best-effort structured extraction after every buyer message.
  try {
    const prevTemp = lead.temp
    const x = await extractLead(getMessages(lead.id))
    if (x) {
      applyExtraction(lead.id, x)
      const updated = getLead(lead.id)
      if (updated.temp === 'Hot' && prevTemp !== 'Hot')
        logActivity(agentId, lead.id, 'hot', `${updated.name || waId} is now HOT (score ${updated.score})`)
      else if (x.score != null)
        logActivity(agentId, lead.id, 'ai', `${updated.name || waId} re-scored: ${updated.score}/100`)
    }
  } catch (err) {
    console.error('extraction failed', err)
  }

  return { lead: getLead(lead.id), reply }
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
        // Everything arrives on ONE shared business number; route by who the sender is.
        const phoneNumberId = value?.metadata?.phone_number_id
        for (const msg of value?.messages ?? []) {
          if (msg.type !== 'text') continue
          markRead(msg.id, phoneNumberId)
          // Match the sender against every agent's saved clients.
          const contact = findContactByWaId(msg.from)
          if (contact) {
            await handleInbound({
              agentId: contact.agent_id,
              brokerName: getAgent(contact.agent_id)?.name,
              waId: msg.from,
              name: contact.name || waProfileName,
              text: msg.text.body,
              phoneNumberId,
            })
          } else {
            // Unknown sender → unassigned pool, visible to all agents to claim.
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
app.post('/api/auth/signup', (req, res) => {
  try {
    res.json(signup(req.body ?? {}))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/auth/login', (req, res) => {
  try {
    res.json(login(req.body ?? {}))
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.agent))

// Everything below requires a logged-in agent.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  requireAuth(req, res, next)
})

// --- Dashboard API (real data from SQLite) — every route is scoped to the logged-in agent. ---
app.get('/api/leads', (req, res) => res.json(listLeads(req.agent.id)))

app.get('/api/leads/:id', (req, res) => {
  const lead = getAssignableLead(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json({ ...lead, messages: getMessages(lead.id) })
})

// Claim an unassigned lead from the shared pool, and remember the sender as a client.
app.post('/api/leads/:id/assign', (req, res) => {
  const lead = assignLead(req.params.id, req.agent.id)
  if (!lead) return res.status(409).json({ error: 'lead is not available to claim' })
  try {
    addContact(req.agent.id, lead.wa_id, lead.name || lead.wa_id)
  } catch {
    // Already a contact (or claimed elsewhere) — assignment still stands.
  }
  logActivity(req.agent.id, lead.id, 'agent', `${req.agent.name} claimed ${lead.name || lead.wa_id}`)
  res.json(lead)
})

// Agent takes over / hands back to AI.
app.post('/api/leads/:id/ai', (req, res) => {
  const lead = getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  setAiEnabled(lead.id, Boolean(req.body?.enabled))
  logActivity(
    req.agent.id,
    lead.id,
    'agent',
    req.body?.enabled
      ? `AI re-enabled for ${lead.name || lead.wa_id}`
      : `${req.agent.name} took over the chat with ${lead.name || lead.wa_id}`,
  )
  res.json(getLead(lead.id))
})

// Agent sends a real WhatsApp message from the dashboard.
app.post('/api/leads/:id/reply', async (req, res) => {
  const lead = getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const text = (req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const waMsgId = await sendText(lead.wa_id, text, req.agent.wa_phone_number_id)
    const msg = addMessage(lead.id, 'agent', text, waMsgId)
    recordFirstResponse(lead.id)
    res.json(msg)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
})

// --- Contacts (My Clients): the agent's known numbers on the shared line ---
app.get('/api/contacts', (req, res) => res.json(listContacts(req.agent.id)))

app.post('/api/contacts', (req, res) => {
  const { phone, name, notes } = req.body ?? {}
  if (!phone || !name) return res.status(400).json({ error: 'phone and name are required' })
  try {
    res.json(addContact(req.agent.id, phone, name, notes))
  } catch (err) {
    res.status(err.code === 'CONTACT_EXISTS' ? 409 : 400).json({ error: err.message })
  }
})

app.post('/api/contacts/bulk', (req, res) => {
  const rows = req.body?.contacts
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'contacts array required' })
  res.json(bulkAddContacts(req.agent.id, rows))
})

app.delete('/api/contacts/:id', (req, res) => {
  if (!deleteContact(req.params.id, req.agent.id)) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
})

app.get('/api/stats', (req, res) => res.json(stats(req.agent.id)))
app.get('/api/activity', (req, res) => res.json(listActivity(req.agent.id)))

app.get('/api/network', (req, res) =>
  res.json({ posts: listNetworkPosts(), matches: computeMatches(req.agent.id) }),
)
app.post('/api/network', (req, res) => {
  const p = req.body ?? {}
  if (!p.type || !p.broker || !p.text) return res.status(400).json({ error: 'type, broker, text required' })
  if (!['INVENTORY', 'REQUIREMENT'].includes(p.type)) return res.status(400).json({ error: 'bad type' })
  res.json(addNetworkPost(p))
})

// Dev/test endpoint: pushes a message through the SAME real pipeline (DB + AI),
// without an outbound WhatsApp send. Useful before the Meta webhook is wired up.
app.post('/api/simulate', async (req, res) => {
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
})

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    whatsapp: whatsappConfigured(),
    ai: aiConfigured(),
    signature: Boolean(WHATSAPP_APP_SECRET),
  }),
)

// Serve the built dashboard so one process hosts everything in production.
const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get(/^\/(?!api|webhook).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))

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
