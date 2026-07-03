import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  upsertLead,
  getLead,
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
} from './db.js'
import { generateReply, extractLead, aiConfigured } from './ai.js'
import { sendText, markRead, whatsappConfigured } from './whatsapp.js'

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

// Core pipeline: a real inbound buyer message -> persist -> AI reply -> WhatsApp send -> extract BLTC.
async function handleInbound({ waId, name, text, source = 'WhatsApp', send = true }) {
  const lead = upsertLead(waId, name)
  const isNewLead = !lead.ai_summary && getMessages(lead.id, 1).length === 0
  addMessage(lead.id, 'buyer', text)
  if (isNewLead) logActivity(lead.id, 'lead', `New lead: ${name || waId} via ${source}`)

  let reply = null
  if (lead.ai_enabled) {
    reply = await generateReply(getMessages(lead.id))
    if (reply) {
      let waMsgId = null
      if (send) {
        try {
          waMsgId = await sendText(waId, reply)
        } catch (err) {
          console.error(err.message)
          logActivity(lead.id, 'error', `WhatsApp send failed for ${name || waId}`)
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
        logActivity(lead.id, 'hot', `${updated.name || waId} is now HOT (score ${updated.score})`)
      else if (x.score != null)
        logActivity(lead.id, 'ai', `${updated.name || waId} re-scored: ${updated.score}/100`)
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
        for (const msg of value?.messages ?? []) {
          if (msg.type !== 'text') continue
          markRead(msg.id)
          await handleInbound({ waId: msg.from, name: contactName, text: msg.text.body })
        }
      }
    }
  })().catch((err) => console.error('webhook processing error', err))
})

// --- Dashboard API (real data from SQLite) ---
app.get('/api/leads', (_req, res) => res.json(listLeads()))

app.get('/api/leads/:id', (req, res) => {
  const lead = getLead(req.params.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  res.json({ ...lead, messages: getMessages(lead.id) })
})

// Agent takes over / hands back to AI.
app.post('/api/leads/:id/ai', (req, res) => {
  const lead = getLead(req.params.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  setAiEnabled(lead.id, Boolean(req.body?.enabled))
  logActivity(
    lead.id,
    'agent',
    req.body?.enabled
      ? `AI re-enabled for ${lead.name || lead.wa_id}`
      : `Rajesh took over the chat with ${lead.name || lead.wa_id}`,
  )
  res.json(getLead(lead.id))
})

// Agent sends a real WhatsApp message from the dashboard.
app.post('/api/leads/:id/reply', async (req, res) => {
  const lead = getLead(req.params.id)
  if (!lead) return res.status(404).json({ error: 'not found' })
  const text = (req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  try {
    const waMsgId = await sendText(lead.wa_id, text)
    const msg = addMessage(lead.id, 'agent', text, waMsgId)
    recordFirstResponse(lead.id)
    res.json(msg)
  } catch (err) {
    res.status(err.code === 'WA_NOT_CONFIGURED' ? 503 : 502).json({ error: err.message })
  }
})

app.get('/api/stats', (_req, res) => res.json(stats()))
app.get('/api/activity', (_req, res) => res.json(listActivity()))

app.get('/api/network', (_req, res) =>
  res.json({ posts: listNetworkPosts(), matches: computeMatches() }),
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
  const result = await handleInbound({ waId: String(from), name, text, source, send: false })
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
