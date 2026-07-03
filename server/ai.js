const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const REPLY_PROMPT = `You are HomeNex AI, the WhatsApp assistant for Rajesh Kumar of Kumar Realty, a real estate broker in Pune, India.

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

const EXTRACT_PROMPT = `You are a real-estate lead analyst. Given a WhatsApp conversation between a property buyer and a broker's assistant in Pune, India, extract the lead's qualification state.

Return ONLY a JSON object (no markdown fences, no prose) with these keys — use null for anything not yet known:
{
  "name": string|null,            // buyer's name if mentioned
  "config": string|null,          // e.g. "2 BHK"
  "config_note": string|null,     // e.g. "ready possession only, higher floor"
  "locality": string|null,        // primary locality, e.g. "Wakad"
  "location_note": string|null,
  "budget_min_l": number|null,    // budget lower bound in ₹ Lakhs (1 Cr = 100)
  "budget_max_l": number|null,
  "budget_note": string|null,     // loan status etc.
  "timeline": string|null,        // e.g. "2-3 months"
  "timeline_note": string|null,
  "temp": "Hot"|"Warm"|"Cold",    // Hot: urgent timeline + clear budget; Cold: just browsing
  "score": number,                // 0-100 lead quality
  "score_breakdown": [ {"label": string, "value": number}, ... ],  // 3-5 factors, value 0-100
  "summary": string,              // 2-3 sentences for the broker: who they are, intent, what to do
  "next_step": string             // one concrete action for the broker
}`

async function chat(messages, { json = false, maxTokens = 500 } = {}) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'HomeNex',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
      messages,
      max_tokens: maxTokens,
      temperature: json ? 0.2 : 0.7,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  if (!res.ok) {
    console.error('OpenRouter error', res.status, await res.text())
    return null
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || null
}

function historyToMessages(messages) {
  return messages.slice(-24).map((m) => ({
    role: m.role === 'buyer' ? 'user' : 'assistant',
    content: m.text,
  }))
}

export async function generateReply(messages) {
  return chat([{ role: 'system', content: REPLY_PROMPT }, ...historyToMessages(messages)])
}

export async function extractLead(messages) {
  const transcript = messages
    .slice(-40)
    .map((m) => `${m.role === 'buyer' ? 'BUYER' : 'ASSISTANT'}: ${m.text}`)
    .join('\n')
  const raw = await chat(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: transcript },
    ],
    { json: true, maxTokens: 700 },
  )
  if (!raw) return null
  try {
    const cleaned = raw.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
    const x = JSON.parse(cleaned)
    if (x.score != null) x.score = Math.max(0, Math.min(100, Math.round(x.score)))
    if (x.temp && !['Hot', 'Warm', 'Cold'].includes(x.temp)) x.temp = null
    return x
  } catch (e) {
    console.error('extraction parse failed:', e.message, raw.slice(0, 200))
    return null
  }
}

export const aiConfigured = () => Boolean(process.env.OPENROUTER_API_KEY)
