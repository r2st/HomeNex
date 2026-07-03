import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  upsertLead,
  getLead,
  getLeadForAgent,
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
  matchAgentByBusinessNumber,
  setAgentPhoneNumberId,
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

// Core pipeline for ONE agent's inbound buyer message:
// persist -> AI reply (as that agent) -> WhatsApp send (from that agent's number) -> extract BLTC.
async function handleInbound({ agent, waId, name, text, source = 'WhatsApp', phoneNumberId = null, send = true }) {
  const agentId = agent.id
  const lead = upsertLead(agentId, waId, name)
  const isNewLead = !lead.ai_summary && getMessages(lead.id, 1).length === 0
  addMessage(lead.id, 'buyer', text)
  if (isNewLead) logActivity(agentId, lead.id, 'lead', `New lead: ${name || waId} via ${source}`)

  let reply = null
  if (lead.ai_enabled) {
    reply = await generateReply(getMessages(lead.id), agent.name)
    if (reply) {
      let waMsgId = null
      if (send) {
        try {
          waMsgId = await sendText(waId, reply, phoneNumberId || agent.wa_phone_number_id)
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
        const contactName = value?.contacts?.[0]?.profile?.name
        // Which registered agent owns the business number this message was sent to?
        const displayNumber = value?.metadata?.display_phone_number
        const phoneNumberId = value?.metadata?.phone_number_id
        const agent = matchAgentByBusinessNumber(displayNumber)
        if (!agent) {
          if (value?.messages?.length)
            console.warn(`No agent registered for business number ${displayNumber} — dropping message`)
          continue
        }
        // Remember this agent's phone_number_id so dashboard replies go out from their number.
        setAgentPhoneNumberId(agent.id, phoneNumberId)
        for (const msg of value?.messages ?? []) {
          if (msg.type !== 'text') continue
          markRead(msg.id, phoneNumberId)
          await handleInbound({
            agent,
            waId: msg.from,
            name: contactName,
            text: msg.text.body,
            phoneNumberId,
          })
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
  const lead = getLeadForAgent(req.params.id, req.agent.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json({ ...lead, messages: getMessages(lead.id) })
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
  const agent = getAgent(req.agent.id)
  const result = await handleInbound({ agent, waId: String(from), name, text, source, send: false })
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

app.listen(PORT, () => {
  console.log(`HomeNex server on :${PORT}`)
  if (!whatsappConfigured()) console.log('⚠ WhatsApp credentials missing — dashboard works, sends disabled')
  if (!aiConfigured()) console.log('⚠ OPENROUTER_API_KEY missing — AI replies/extraction disabled')
  if (!WHATSAPP_APP_SECRET) console.log('⚠ WHATSAPP_APP_SECRET missing — webhook signature check disabled')
})
