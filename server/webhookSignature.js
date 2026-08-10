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
