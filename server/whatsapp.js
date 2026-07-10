const GRAPH = 'https://graph.facebook.com/v21.0'

export const whatsappConfigured = () =>
  Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)

// Meta returns code 190 (OAuthException) when the access token is expired or revoked.
// Callers care about this specifically because the fix is "refresh the token", not "retry".
const isTokenError = (error) =>
  error?.code === 190 || error?.type === 'OAuthException'

// Live check that the configured access token can still talk to the Graph API.
// Returns { ok } on success, or { ok:false, expired, reason } so callers (e.g. /api/health)
// can tell an expired token apart from a transient network blip.
export async function checkToken(phoneNumberId) {
  if (!whatsappConfigured()) return { ok: false, reason: 'not_configured' }
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  try {
    const res = await fetch(
      `${GRAPH}/${fromId}?fields=id&access_token=${encodeURIComponent(process.env.WHATSAPP_ACCESS_TOKEN)}`,
    )
    const data = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true }
    return { ok: false, expired: isTokenError(data.error), reason: data.error?.message || `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

// Sends a real text message via the WhatsApp Cloud API. Returns the wa message id.
// phoneNumberId picks the sending business number (per-agent); falls back to the env default.
export async function sendText(to, text, phoneNumberId) {
  if (!whatsappConfigured()) {
    const err = new Error('WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)')
    err.code = 'WA_NOT_CONFIGURED'
    throw err
  }
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  const res = await fetch(`${GRAPH}/${fromId}/messages`, {
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
    if (isTokenError(data.error)) {
      const err = new Error(
        'WhatsApp access token is expired or invalid — refresh WHATSAPP_ACCESS_TOKEN in the server .env',
      )
      err.code = 'WA_TOKEN_EXPIRED'
      throw err
    }
    const err = new Error(`WhatsApp send failed (${res.status}): ${JSON.stringify(data.error || data)}`)
    err.code = 'WA_SEND_FAILED'
    throw err
  }
  return data.messages?.[0]?.id ?? null
}

export async function markRead(messageId, phoneNumberId) {
  if (!whatsappConfigured() || !messageId) return
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  await fetch(`${GRAPH}/${fromId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {})
}
