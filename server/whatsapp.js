import { RequestQueue, RetryableError, isRetryableStatus, retryAfterMs } from './aiQueue.js'

const GRAPH = 'https://graph.facebook.com/v21.0'

// Graph API calls that hang (a stalled connection, not a clean error) used to hold a
// webhook-processing coroutine open forever — no error, no retry, the lead's pipeline
// (reply -> extraction) just never completed. Every request gets a hard deadline.
const WA_TIMEOUT_MS = Number(process.env.WA_TIMEOUT_MS) || 15_000

// Every outbound Graph API call flows through this queue: bounded concurrency (so a
// bulk/festive send fan-out or a burst of simultaneous inbound replies doesn't fire an
// unbounded number of concurrent requests at Meta) and retry-with-backoff on 429 /
// 5xx / network blips / timeouts, honouring Retry-After when Meta sends one. A token
// error (Meta code 190) is never retried — refreshing WHATSAPP_ACCESS_TOKEN is the
// only fix, so it fails fast instead of burning retries on a call that can't succeed.
export const waQueue = new RequestQueue({
  concurrency: Number(process.env.WA_CONCURRENCY) || 4,
  maxRetries: Number(process.env.WA_MAX_RETRIES) || 3,
})

export const whatsappConfigured = () =>
  Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)

// Meta returns code 190 (OAuthException) when the access token is expired or revoked.
// Callers care about this specifically because the fix is "refresh the token", not "retry".
const isTokenError = (error) =>
  error?.code === 190 || error?.type === 'OAuthException'

// One Graph API HTTP attempt with a hard timeout. Throws a RetryableError for
// 429 / 5xx / network blips / timeouts (the queue backs off and retries); throws a
// plain WA_TOKEN_EXPIRED error for an expired/invalid token (never retried); returns
// the parsed JSON body on success (2xx or not — callers classify non-2xx themselves).
async function waFetch(url, options) {
  let res
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(WA_TIMEOUT_MS) })
  } catch (err) {
    throw new RetryableError(`WhatsApp API unreachable: ${err.message}`)
  }
  const data = await res.json().catch(() => ({}))
  if (res.ok) return data
  if (isTokenError(data.error)) {
    const err = new Error(
      'WhatsApp access token is expired or invalid — refresh WHATSAPP_ACCESS_TOKEN in the server .env',
    )
    err.code = 'WA_TOKEN_EXPIRED'
    throw err
  }
  if (isRetryableStatus(res.status)) {
    throw new RetryableError(`WhatsApp API ${res.status}`, {
      status: res.status,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
    })
  }
  const err = new Error(`WhatsApp API failed (${res.status}): ${JSON.stringify(data.error || data)}`)
  err.code = 'WA_SEND_FAILED'
  throw err
}

// Queues + retries a Graph API call and normalises the failure into the error codes
// callers already branch on: WA_TOKEN_EXPIRED (don't retry, needs a human), or
// WA_SEND_FAILED (everything else, including "retried until we gave up").
async function waRequest(url, options) {
  try {
    return await waQueue.enqueue(() => waFetch(url, options))
  } catch (err) {
    if (err.code === 'WA_TOKEN_EXPIRED') throw err
    const failure = new Error(`WhatsApp send failed: ${err.message}`)
    failure.code = 'WA_SEND_FAILED'
    throw failure
  }
}

const authHeaders = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
})

// Live check that the configured access token can still talk to the Graph API.
// Returns { ok } on success, or { ok:false, expired, reason } so callers (e.g. /api/health)
// can tell an expired token apart from a transient network blip.
export async function checkToken(phoneNumberId) {
  if (!whatsappConfigured()) return { ok: false, reason: 'not_configured' }
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  try {
    const res = await fetch(
      `${GRAPH}/${fromId}?fields=id&access_token=${encodeURIComponent(process.env.WHATSAPP_ACCESS_TOKEN)}`,
      { signal: AbortSignal.timeout(WA_TIMEOUT_MS) },
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
  const data = await waRequest(`${GRAPH}/${fromId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  })
  return data.messages?.[0]?.id ?? null
}

// Sends a pre-approved WhatsApp template message (business-initiated). Required when
// there is no open 24-hour service window — e.g. the instant reply to a Meta Lead Ad or
// portal lead, where the buyer hasn't messaged us on WhatsApp yet. `components` follows the
// Cloud API template component schema (body variables, buttons, etc.). Returns the wa id.
export async function sendTemplate(to, { name, language = 'en', components } = {}, phoneNumberId) {
  if (!whatsappConfigured()) {
    const err = new Error('WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)')
    err.code = 'WA_NOT_CONFIGURED'
    throw err
  }
  if (!name) {
    const err = new Error('template name required')
    err.code = 'WA_TEMPLATE_MISSING'
    throw err
  }
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  const template = { name, language: { code: language } }
  if (components && components.length) template.components = components
  const data = await waRequest(`${GRAPH}/${fromId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template }),
  })
  return data.messages?.[0]?.id ?? null
}

// Meta Lead Ads webhooks only carry a leadgen_id — the actual answers must be fetched
// from the Graph API with a Page access token. Returns { field_data, ad_id, form_id, ... }
// or null if unconfigured / the call fails (caller logs and moves on).
export async function fetchLeadgenData(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN
  if (!leadgenId || !token) return null
  try {
    const res = await fetch(
      `${GRAPH}/${leadgenId}?fields=field_data,ad_id,ad_name,form_id,campaign_id,created_time&access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(WA_TIMEOUT_MS) },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('leadgen fetch failed', JSON.stringify(data.error || data))
      return null
    }
    return data
  } catch (err) {
    console.error('leadgen fetch error', err.message)
    return null
  }
}

// Sends a media message (image / video / document) by link — the URL must be
// publicly reachable by Meta. `type` is one of 'image' | 'video' | 'document'.
// filename applies to documents; caption is optional. Returns the wa message id.
export async function sendMedia(to, { type = 'document', link, caption, filename } = {}, phoneNumberId) {
  if (!whatsappConfigured()) {
    const err = new Error('WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)')
    err.code = 'WA_NOT_CONFIGURED'
    throw err
  }
  if (!link) {
    const err = new Error('media link required')
    err.code = 'WA_MEDIA_MISSING'
    throw err
  }
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  const media = { link }
  if (caption) media.caption = caption
  if (type === 'document' && filename) media.filename = filename
  const data = await waRequest(`${GRAPH}/${fromId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type, [type]: media }),
  })
  return data.messages?.[0]?.id ?? null
}

export async function markRead(messageId, phoneNumberId) {
  if (!whatsappConfigured() || !messageId) return
  const fromId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  await fetch(`${GRAPH}/${fromId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    signal: AbortSignal.timeout(WA_TIMEOUT_MS),
  }).catch(() => {})
}
