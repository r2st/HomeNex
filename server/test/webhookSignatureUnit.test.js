// Every branch of verifyWebhookSignature(), with no server and no database.
//
// webhookSecurity.test.js already proves the ARMED path end-to-end through express.
// What it can't reach is the branch that matters most for a real deploy: what happens
// when WHATSAPP_APP_SECRET is absent. That answer depends on NODE_ENV, and a test file
// can't flip NODE_ENV to 'production' after index.js has been imported. So the
// decision lives in a pure function and gets pinned here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifyWebhookSignature, verifyWebhookChallenge, DEV_VERIFY_TOKEN } from '../webhookSignature.js'

const SECRET = 'test-app-secret'
const RAW = Buffer.from(JSON.stringify({ entry: [{ changes: [] }] }))
const sign = (raw, secret = SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')

// --- no secret configured: the fail-closed rule ------------------------------

test('with no secret, production rejects everything', () => {
  // Unsigned, plausibly signed, and empty-bodied all get the same answer. Nothing a
  // caller can send is acceptable, because there is no key to check it against.
  for (const args of [
    { signature: undefined, rawBody: RAW },
    { signature: sign(RAW), rawBody: RAW },
    { signature: 'sha256=' + 'f'.repeat(64), rawBody: RAW },
    { signature: undefined, rawBody: undefined },
  ]) {
    assert.equal(verifyWebhookSignature({ secret: undefined, isProd: true, ...args }), false)
  }
})

test('with no secret, dev and test stay permissive', () => {
  // Local webhook replay and the ~70 suites that never configure a secret depend on
  // this. If this flips, the whole server test suite goes red — which is the point:
  // the permissive branch is a deliberate dev affordance, not an accident.
  assert.equal(verifyWebhookSignature({ secret: undefined, isProd: false, signature: undefined, rawBody: RAW }), true)
  assert.equal(verifyWebhookSignature({ secret: '', isProd: false, signature: undefined, rawBody: RAW }), true)
})

test('an empty-string secret counts as unset, not as a key', () => {
  // process.env.WHATSAPP_APP_SECRET='' is what a half-filled .env or an empty CI
  // variable actually produces — it must not be used as an HMAC key that a
  // determined caller could reproduce.
  assert.equal(verifyWebhookSignature({ secret: '', isProd: true, signature: sign(RAW, ''), rawBody: RAW }), false)
})

test('a configured secret is checked the same way in prod and in dev', () => {
  for (const isProd of [true, false]) {
    assert.equal(verifyWebhookSignature({ secret: SECRET, isProd, signature: sign(RAW), rawBody: RAW }), true, `prod=${isProd}`)
    assert.equal(verifyWebhookSignature({ secret: SECRET, isProd, signature: sign(RAW, 'other'), rawBody: RAW }), false, `prod=${isProd}`)
  }
})

// --- secret configured: the HMAC itself ---------------------------------------

test('a correct signature over the exact bytes passes', () => {
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(RAW), rawBody: RAW }), true)
})

test('a missing signature header or a missing raw body fails', () => {
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: undefined, rawBody: RAW }), false)
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(RAW), rawBody: undefined }), false)
  // An empty raw body is falsy too — express only sets rawBody in its json verify
  // hook, so "absent" and "empty" are the same failure.
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(RAW), rawBody: '' }), false)
})

test('a signature of the wrong length returns false instead of throwing', () => {
  // crypto.timingSafeEqual throws on unequal buffer lengths; the catch turns that
  // into a plain rejection so a probe gets a 401, not a 500 that confirms the length.
  for (const bogus of ['sha256=abc', 'sha256=', 'garbage', 'sha1=' + 'a'.repeat(40), 'sha256=' + 'a'.repeat(200)]) {
    assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: bogus, rawBody: RAW }), false, bogus)
  }
})

test('a valid signature over a different body fails', () => {
  const other = Buffer.from(JSON.stringify({ entry: [] }))
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(other), rawBody: RAW }), false)
})

test('a single flipped byte in the body invalidates the signature', () => {
  const tampered = Buffer.from(RAW)
  tampered[tampered.length - 2] ^= 0x01
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(RAW), rawBody: tampered }), false)
})

test('the raw body is accepted as a string as well as a Buffer', () => {
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: sign(RAW), rawBody: RAW.toString('utf8') }), true)
})

test('the prefix must be sha256=, not a bare hex digest of the right length', () => {
  const bare = sign(RAW).slice('sha256='.length)
  assert.equal(verifyWebhookSignature({ secret: SECRET, isProd: true, signature: bare, rawBody: RAW }), false)
})

// --- verifyWebhookChallenge: the GET handshake -------------------------------
//
// Here for the same reason as everything above: the branch that matters for a real
// deploy is the one where the env var is absent, and that answer depends on NODE_ENV,
// which no test file can flip after index.js has been imported.

test('production refuses the handshake until a verify token is configured', () => {
  const attempt = (presented) =>
    verifyWebhookChallenge({ configured: undefined, isProd: true, mode: 'subscribe', presented })

  // The published dev constant is the value an unconfigured deploy used to accept, so
  // it is the one an attacker would try first. In production it is not a key at all.
  assert.equal(attempt(DEV_VERIFY_TOKEN), false)
  assert.equal(attempt(''), false)
  assert.equal(attempt(undefined), false)
  assert.equal(attempt('anything'), false)
})

test('dev keeps the published default so local webhook replay still works', () => {
  const inDev = (presented) =>
    verifyWebhookChallenge({ configured: undefined, isProd: false, mode: 'subscribe', presented })

  assert.equal(inDev(DEV_VERIFY_TOKEN), true)
  assert.equal(inDev('wrong'), false)
})

test('a configured token is the only one accepted, in either environment', () => {
  for (const isProd of [true, false]) {
    const check = (presented) => verifyWebhookChallenge({ configured: 'real-token', isProd, mode: 'subscribe', presented })
    assert.equal(check('real-token'), true, `isProd=${isProd}`)
    assert.equal(check('wrong'), false, `isProd=${isProd}`)
    // Configuring a token replaces the dev default rather than adding to it.
    assert.equal(check(DEV_VERIFY_TOKEN), false, `isProd=${isProd}`)
  }
})

test('only hub.mode=subscribe is a handshake', () => {
  for (const mode of ['unsubscribe', '', undefined, 'SUBSCRIBE']) {
    assert.equal(verifyWebhookChallenge({ configured: 'real-token', isProd: true, mode, presented: 'real-token' }), false, String(mode))
  }
})

test('a non-string token is rejected rather than thrown on', () => {
  // Express turns a repeated query parameter into an array, and an object into an
  // object — Buffer.from() throws on both, and a 500 here would be a 500 anyone can
  // trigger on a public route.
  for (const presented of [['real-token', 'x'], { toString: () => 'real-token' }, 5, null, undefined]) {
    assert.equal(
      verifyWebhookChallenge({ configured: 'real-token', isProd: true, mode: 'subscribe', presented }),
      false,
      JSON.stringify(presented) ?? String(presented),
    )
  }
})

test('a token of a different length is rejected without throwing', () => {
  // timingSafeEqual throws on a length mismatch; that has to be a 403, not a 500.
  for (const presented of ['short', 'a-much-longer-token-than-configured', '']) {
    assert.equal(verifyWebhookChallenge({ configured: 'real-token', isProd: true, mode: 'subscribe', presented }), false, presented)
  }
})
