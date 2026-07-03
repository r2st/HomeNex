const GRAPH = 'https://graph.facebook.com/v21.0'

export const whatsappConfigured = () =>
  Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)

// Sends a real text message via the WhatsApp Cloud API. Returns the wa message id.
export async function sendText(to, text) {
  if (!whatsappConfigured()) {
    const err = new Error('WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)')
    err.code = 'WA_NOT_CONFIGURED'
    throw err
  }
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`WhatsApp send failed (${res.status}): ${JSON.stringify(data.error || data)}`)
    err.code = 'WA_SEND_FAILED'
    throw err
  }
  return data.messages?.[0]?.id ?? null
}

export async function markRead(messageId) {
  if (!whatsappConfigured() || !messageId) return
  await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {})
}
