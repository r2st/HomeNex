import 'dotenv/config'
import express from 'express'
import crypto from 'node:crypto'

const {
  PORT = 8787,
  WHATSAPP_VERIFY_TOKEN = 'homenex-verify',
  WHATSAPP_APP_SECRET,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free',
} = process.env

const app = express()

// Keep the raw body so we can verify Meta's signature.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
)

// In-memory conversation store: wa_id -> { name, messages: [{role, text, at}] }
const conversations = new Map()

const SYSTEM_PROMPT = `You are HomeNex AI, the WhatsApp assistant for Rajesh Kumar of Kumar Realty, a real estate broker in Pune, India.

Your job is to qualify property buyers conversationally using the BLTC framework:
- Budget (in ₹ Lakhs/Crores; ask about loan status — pre-approved, sanctioned, or not applied)
- Location (Pune localities: Wakad, Kharadi, Baner, Balewadi, Hinjewadi, Koregaon Park, Kalyani Nagar, etc.)
- Timeline (when do they want to move in / register)
- Configuration (1/2/3/4 BHK, carpet area, ready vs under-construction)

Rules:
- Be warm, concise and professional. One question at a time. Use occasional emojis like a good Indian broker's assistant would.
- Quote prices in ₹ Lakhs (L) and Crores (Cr). Mention RERA registration when discussing projects.
- Once you have all four BLTC data points, offer a site visit slot (weekends work best) and tell them Rajesh will call to confirm.
- If asked something you don't know (exact legal/loan specifics), say Rajesh will confirm personally.
- Never invent a specific flat you were not told about; speak in realistic ranges for the locality instead.
- Keep replies under 120 words. This is WhatsApp.`

function verifySignature(req) {
  if (!WHATSAPP_APP_SECRET) return true // demo mode: accept unsigned
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

async function askAI(waId) {
  const convo = conversations.get(waId)
  const history = convo.messages.slice(-20).map((m) => ({
    role: m.role === 'buyer' ? 'user' : 'assistant',
    content: m.text,
  }))

  if (!OPENROUTER_API_KEY) {
    return "Thanks for reaching out! Rajesh will get back to you shortly. (HomeNex demo mode — set OPENROUTER_API_KEY for AI replies.)"
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'HomeNex',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
      max_tokens: 300,
      temperature: 0.7,
    }),
  })

  if (!res.ok) {
    console.error('OpenRouter error', res.status, await res.text())
    return 'Thanks for your message! Rajesh will reply personally very soon. 🙏'
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || 'Rajesh will reply shortly. 🙏'
}

async function sendWhatsApp(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`[demo mode] would send to ${to}:`, text)
    return
  }
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  )
  if (!res.ok) console.error('WhatsApp send error', res.status, await res.text())
}

// --- Meta webhook verification (GET) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// --- Incoming WhatsApp messages (POST) ---
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401)
  res.sendStatus(200) // ack fast; Meta retries on timeout

  try {
    const entries = req.body?.entry ?? []
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        const contactName = value?.contacts?.[0]?.profile?.name
        for (const msg of value?.messages ?? []) {
          if (msg.type !== 'text') continue
          const waId = msg.from
          const text = msg.text.body

          if (!conversations.has(waId)) {
            conversations.set(waId, { name: contactName || waId, messages: [] })
          }
          const convo = conversations.get(waId)
          convo.messages.push({ role: 'buyer', text, at: Date.now() })

          const reply = await askAI(waId)
          convo.messages.push({ role: 'ai', text: reply, at: Date.now() })
          await sendWhatsApp(waId, reply)
        }
      }
    }
  } catch (err) {
    console.error('webhook processing error', err)
  }
})

// --- API for the HomeNex frontend ---
app.get('/api/conversations', (_req, res) => {
  res.json(
    [...conversations.entries()].map(([waId, c]) => ({
      waId,
      name: c.name,
      messages: c.messages,
    })),
  )
})

// Local testing without Meta: simulate an inbound buyer message.
app.post('/api/simulate', async (req, res) => {
  const { from = 'demo-buyer', name = 'Demo Buyer', text } = req.body ?? {}
  if (!text) return res.status(400).json({ error: 'text required' })
  if (!conversations.has(from)) conversations.set(from, { name, messages: [] })
  const convo = conversations.get(from)
  convo.messages.push({ role: 'buyer', text, at: Date.now() })
  const reply = await askAI(from)
  convo.messages.push({ role: 'ai', text: reply, at: Date.now() })
  res.json({ reply })
})

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    whatsapp: Boolean(WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
    ai: Boolean(OPENROUTER_API_KEY),
  }),
)

app.listen(PORT, () => {
  console.log(`HomeNex server on :${PORT}`)
  if (!WHATSAPP_ACCESS_TOKEN) console.log('⚠ WhatsApp credentials missing — running in demo mode')
  if (!OPENROUTER_API_KEY) console.log('⚠ OPENROUTER_API_KEY missing — canned replies only')
})
