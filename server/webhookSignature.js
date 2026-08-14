// X-Hub-Signature-256 verification for Meta's webhook, kept out of index.js so every
// branch can be unit-tested without booting the server.
//
// The important rule is the FIRST one: what happens when no app secret is configured.
// This used to return `true` unconditionally — convenient in dev, but it meant a
// production deploy that simply forgot WHATSAPP_APP_SECRET would silently accept
// ANY unsigned POST to the public /webhook endpoint. Anyone who knows the URL could
// inject fabricated inbound "buyer" messages: fake leads, AI replies sent from the
// broker's real WhatsApp number, poisoned lead scores. A missing env var should
// degrade a feature, never open the front door — so in production we now fail closed
// and reject everything until the secret is set. Dev and test keep the permissive
// behaviour, because that's what makes local webhook replay and the (many) test files
// that never configure a secret workable.
import crypto from 'node:crypto'

/**
 * @param {object} o
 * @param {string} [o.secret]     WHATSAPP_APP_SECRET, if configured
 * @param {boolean} [o.isProd]    true when NODE_ENV=production
 * @param {string} [o.signature]  the X-Hub-Signature-256 header
 * @param {Buffer|string} [o.rawBody] exact bytes express.json() parsed
 * @returns {boolean} true only when the request may be processed
 */
export function verifyWebhookSignature({ secret, isProd, signature, rawBody }) {
  if (!secret) return !isProd // fail closed in production, permissive in dev/test
  if (!signature || !rawBody) return false
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    // Lengths differ for a truncated/garbage header, and timingSafeEqual throws
    // rather than returning false — that must be a 401, not a 500.
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

// The token the GET handshake accepts when none is configured. It is a published
// constant — it is right here in the source — so it is a development convenience and
// nothing more. Production must set WHATSAPP_VERIFY_TOKEN; see below.
export const DEV_VERIFY_TOKEN = 'homenex-verify'

/**
 * Meta's subscription handshake, GET /webhook.
 *
 * This used to fall back to DEV_VERIFY_TOKEN everywhere, production included, which
 * is the same shape of hole the signature check above was fixed for: a value anyone
 * can read off the repository is not a secret, so on a deploy that never set the env
 * var the handshake was open to anyone. That matters twice over. It lets a stranger
 * point their own Meta app at our endpoint; and because the route's job is to echo
 * hub.challenge back, passing it hands the caller a 200 carrying text they chose, on
 * the origin that holds every agent's session. (The echo is served as text/plain for
 * that second reason — see the route.)
 *
 * So: fail closed in production until the token is set, stay convenient in dev/test.
 *
 * @param {object} o
 * @param {string} [o.configured] WHATSAPP_VERIFY_TOKEN, if set
 * @param {boolean} [o.isProd]    true when NODE_ENV=production
 * @param {unknown} [o.mode]      the hub.mode query parameter
 * @param {unknown} [o.presented] the hub.verify_token query parameter
 * @returns {boolean} true only when the challenge may be echoed
 */
export function verifyWebhookChallenge({ configured, isProd, mode, presented }) {
  if (mode !== 'subscribe') return false
  const expected = configured || (isProd ? null : DEV_VERIFY_TOKEN)
  if (!expected) return false
  // A repeated query parameter (?hub.verify_token=a&hub.verify_token=b) arrives as an
  // array, and Buffer.from would throw on it — reject anything that is not a string.
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
