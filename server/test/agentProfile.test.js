// Tests for agent self-service: profile fields, locale/notification preferences,
// and password change. Run with: npm test  (from server/) — needs a local PostgreSQL.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and skip listen() before importing the app.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('agentprofile')

const { app } = await import('../index.js')
const {
  closePool,
  getAgent,
  listAuditLogs,
  updateAgentPassword,
  updateAgentProfileSelf,
  updateAgentPreferences,
  agentTimezone,
  normalizeAvatar,
  isValidTimezone,
} = await import('../db.js')
const { hashPassword, verifyPassword, changePassword, issueToken } = await import('../auth.js')

let server
let base
let tokenA
let tokenB
let agentA
let agentB

const PASSWORD_A = 'secret123'
const PASSWORD_B = 'secret456'

// A real 1x1 transparent PNG, the shape the browser produces after downscaling.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const req = (method, url, body, tok = tokenA) =>
  fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Password tests mutate the credential; restore it so tests stay order-independent.
// Restoring it also rotates the agent's token version — that is the whole point of a
// password change — so the suite's session token has to be re-minted with it, or
// every later request in the file would 401 on a token the reset just revoked.
const resetPassword = async (agent, password, setToken) => {
  const fresh = await updateAgentPassword(agent.id, hashPassword(password))
  setToken(await issueToken(fresh.id, fresh.token_version))
  return fresh
}
const resetPasswordA = () => resetPassword(agentA, PASSWORD_A, (t) => (tokenA = t))
const resetPasswordB = () => resetPassword(agentB, PASSWORD_B, (t) => (tokenB = t))

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const resA = await req('POST', '/api/auth/signup', {
    name: 'Agent Alpha',
    phone: '+919876543210',
    email: 'alpha@homenex.in',
    password: PASSWORD_A,
  }, null)
  ;({ token: tokenA, agent: agentA } = await resA.json())

  const resB = await req('POST', '/api/auth/signup', {
    name: 'Agent Beta',
    phone: '+919800000002',
    email: 'beta@homenex.in',
    password: PASSWORD_B,
  }, null)
  ;({ token: tokenB, agent: agentB } = await resB.json())
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Defaults from the migration ---

test('a new agent gets sensible profile defaults', async () => {
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.timezone, 'Asia/Kolkata')
  assert.equal(me.language, 'en')
  assert.equal(me.is_active, 1)
  assert.equal(me.deactivated_at, null)
  assert.equal(me.notify_new_lead, 1)
  assert.equal(me.notify_followup_due, 1)
  assert.equal(me.notify_daily_digest, 0)
  assert.equal(me.quiet_hours_start, null)
  assert.equal(me.quiet_hours_end, null)
  assert.equal(me.business_name, null)
  assert.equal(me.avatar_url, null)
})

test('/api/auth/me never exposes the password hash', async () => {
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.password_hash, undefined)
})

// --- PUT /api/agent/profile ---

test('PUT /api/agent/profile updates every profile field at once', async () => {
  const res = await req('PUT', '/api/agent/profile', {
    name: 'Alpha Sharma',
    email: 'Alpha.Sharma@HomeNex.in',
    business_name: 'Sharma Realty',
    city: 'Pune',
    bio: 'Resale specialist in Baner and Balewadi.',
    rera_id: 'A52100012345',
    avatar_url: PNG_1PX,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.name, 'Alpha Sharma')
  assert.equal(body.email, 'alpha.sharma@homenex.in', 'email is lowercased')
  assert.equal(body.business_name, 'Sharma Realty')
  assert.equal(body.city, 'Pune')
  assert.equal(body.bio, 'Resale specialist in Baner and Balewadi.')
  assert.equal(body.rera_id, 'A52100012345')
  assert.equal(body.avatar_url, PNG_1PX)
  assert.equal(body.password_hash, undefined)
})

test('PUT /api/agent/profile leaves omitted fields untouched', async () => {
  await req('PUT', '/api/agent/profile', { city: 'Mumbai' })
  const me = await (await req('GET', '/api/auth/me')).json()
  assert.equal(me.city, 'Mumbai')
  assert.equal(me.business_name, 'Sharma Realty', 'untouched')
  assert.equal(me.name, 'Alpha Sharma', 'untouched')
  await req('PUT', '/api/agent/profile', { city: 'Pune' })
})

test('PUT /api/agent/profile clears an optional field with an empty string', async () => {
  await req('PUT', '/api/agent/profile', { bio: '   ' })
  assert.equal((await getAgent(agentA.id)).bio, null)
  await req('PUT', '/api/agent/profile', { bio: 'Resale specialist in Baner and Balewadi.' })
})

test('PUT /api/agent/profile trims whitespace', async () => {
  const body = await (await req('PUT', '/api/agent/profile', { business_name: '  Sharma Realty  ' })).json()
  assert.equal(body.business_name, 'Sharma Realty')
})

test('PUT /api/agent/profile rejects an empty name', async () => {
  const res = await req('PUT', '/api/agent/profile', { name: '   ' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Name cannot be empty/)
  assert.equal((await getAgent(agentA.id)).name, 'Alpha Sharma', 'unchanged')
})

test('PUT /api/agent/profile rejects an invalid email', async () => {
  for (const email of ['not-an-email', 'a@b', 'a b@c.in']) {
    const res = await req('PUT', '/api/agent/profile', { email })
    assert.equal(res.status, 400, `${email} should be rejected`)
    assert.match((await res.json()).error, /valid email/)
  }
})

test('PUT /api/agent/profile rejects an email another agent already uses with 409', async () => {
  const res = await req('PUT', '/api/agent/profile', { email: 'beta@homenex.in' })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /Another agent already uses this email/)
  assert.equal((await getAgent(agentA.id)).email, 'alpha.sharma@homenex.in', 'unchanged')
})

test('PUT /api/agent/profile lets an agent keep their own email', async () => {
  const res = await req('PUT', '/api/agent/profile', { email: 'alpha.sharma@homenex.in' })
  assert.equal(res.status, 200)
})

test('PUT /api/agent/profile clears the email when sent empty', async () => {
  await req('PUT', '/api/agent/profile', { email: '' })
  assert.equal((await getAgent(agentA.id)).email, null)
  await req('PUT', '/api/agent/profile', { email: 'alpha.sharma@homenex.in' })
})

test('PUT /api/agent/profile enforces length caps', async () => {
  const cases = [
    ['name', 'x'.repeat(81), /Name is too long/],
    ['business_name', 'x'.repeat(121), /Business name is too long/],
    ['city', 'x'.repeat(81), /City is too long/],
    ['bio', 'x'.repeat(501), /About you is too long/],
    ['rera_id', 'x'.repeat(65), /RERA registration ID is too long/],
  ]
  for (const [field, value, pattern] of cases) {
    const res = await req('PUT', '/api/agent/profile', { [field]: value })
    assert.equal(res.status, 400, `${field} over cap should be rejected`)
    assert.match((await res.json()).error, pattern)
  }
})

test('PUT /api/agent/profile ignores fields outside the allowlist', async () => {
  // is_admin and is_active are admin-only; phone has its own password-gated route.
  const { getAgentPasswordHash } = await import('../db.js')
  const res = await req('PUT', '/api/agent/profile', {
    is_admin: 1,
    is_active: 0,
    phone: '+919999999999',
    password_hash: 'pwned',
  })
  assert.equal(res.status, 200)
  const agent = await getAgent(agentA.id)
  assert.equal(agent.is_admin, 0, 'cannot self-promote')
  assert.equal(agent.is_active, 1, 'cannot self-deactivate')
  assert.equal(agent.phone, '+919876543210', 'phone unchanged')
  assert.ok(verifyPassword(PASSWORD_A, await getAgentPasswordHash(agentA.id)), 'password unchanged')
})

test('PUT /api/agent/profile only ever changes the caller', async () => {
  await req('PUT', '/api/agent/profile', { city: 'Nagpur' }, tokenB)
  assert.equal((await getAgent(agentB.id)).city, 'Nagpur')
  assert.equal((await getAgent(agentA.id)).city, 'Pune', 'agent A untouched')
})

test('PUT /api/agent/profile rejects unauthenticated requests', async () => {
  const res = await req('PUT', '/api/agent/profile', { name: 'Nobody' }, null)
  assert.equal(res.status, 401)
})

test('PUT /api/agent/profile writes an audit entry naming the changed fields only', async () => {
  await req('PUT', '/api/agent/profile', { city: 'Pune', avatar_url: PNG_1PX })
  const entry = (await listAuditLogs(agentA.id)).find((l) => l.action === 'profile_updated')
  assert.ok(entry, 'profile_updated audit entry exists')
  assert.equal(entry.entity_type, 'agent')
  assert.equal(entry.entity_id, agentA.id)
  assert.deepEqual(entry.details.fields.sort(), ['avatar_url', 'city'])
  // The photo payload must never land in the audit log.
  assert.ok(!JSON.stringify(entry.details).includes('base64'), 'no image data in audit details')
})

// --- Profile photo validation ---

test('normalizeAvatar accepts https URLs and inline images', () => {
  assert.equal(normalizeAvatar('https://cdn.homenex.in/a.png'), 'https://cdn.homenex.in/a.png')
  assert.equal(normalizeAvatar(PNG_1PX), PNG_1PX)
  assert.equal(normalizeAvatar('  '), null, 'blank clears the photo')
  assert.equal(normalizeAvatar(null), null)
})

test('normalizeAvatar rejects unsafe or unsupported sources', () => {
  const rejected = [
    'http://cdn.homenex.in/a.png', // plaintext
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=', // not an image
    'data:image/svg+xml;base64,PHN2Zz4=', // SVG can carry script
    '/etc/passwd',
  ]
  for (const value of rejected) {
    assert.throws(() => normalizeAvatar(value), /https URL or an uploaded/, `${value} should be rejected`)
  }
})

test('normalizeAvatar rejects an oversized image', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(300_001)
  assert.throws(() => normalizeAvatar(huge), /too large/)
})

test('PUT /api/agent/profile rejects an unsafe avatar over HTTP', async () => {
  const res = await req('PUT', '/api/agent/profile', { avatar_url: 'data:image/svg+xml;base64,PHN2Zz4=' })
  assert.equal(res.status, 400)
})

// --- PUT /api/agent/preferences ---

test('PUT /api/agent/preferences updates locale and notification flags', async () => {
  const res = await req('PUT', '/api/agent/preferences', {
    timezone: 'Asia/Dubai',
    language: 'hi',
    notify_new_lead: false,
    notify_followup_due: true,
    notify_daily_digest: true,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.timezone, 'Asia/Dubai')
  assert.equal(body.language, 'hi')
  assert.equal(body.notify_new_lead, 0)
  assert.equal(body.notify_followup_due, 1)
  assert.equal(body.notify_daily_digest, 1)
})

test('PUT /api/agent/preferences rejects an unknown timezone', async () => {
  const res = await req('PUT', '/api/agent/preferences', { timezone: 'Mars/Olympus_Mons' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Unknown timezone/)
  assert.equal((await getAgent(agentA.id)).timezone, 'Asia/Dubai', 'unchanged')
})

test('PUT /api/agent/preferences rejects an unsupported language', async () => {
  const res = await req('PUT', '/api/agent/preferences', { language: 'klingon' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /Unsupported language/)
})

test('PUT /api/agent/preferences accepts every shipped language', async () => {
  const { LANGUAGES } = await import('../db.js')
  for (const language of LANGUAGES) {
    const res = await req('PUT', '/api/agent/preferences', { language })
    assert.equal(res.status, 200, `${language} should be accepted`)
  }
  await req('PUT', '/api/agent/preferences', { language: 'en' })
})

test('PUT /api/agent/preferences sets quiet hours as a pair', async () => {
  const body = await (await req('PUT', '/api/agent/preferences', {
    quiet_hours_start: 22,
    quiet_hours_end: 7,
  })).json()
  assert.equal(body.quiet_hours_start, 22)
  assert.equal(body.quiet_hours_end, 7, 'an overnight range is allowed')
})

test('PUT /api/agent/preferences clears quiet hours when both ends are null', async () => {
  const body = await (await req('PUT', '/api/agent/preferences', {
    quiet_hours_start: null,
    quiet_hours_end: null,
  })).json()
  assert.equal(body.quiet_hours_start, null)
  assert.equal(body.quiet_hours_end, null)
})

test('PUT /api/agent/preferences rejects a half-set quiet-hours range', async () => {
  const res = await req('PUT', '/api/agent/preferences', { quiet_hours_start: 22 })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /both a start and an end/)
})

test('PUT /api/agent/preferences merges one end against the stored value', async () => {
  await req('PUT', '/api/agent/preferences', { quiet_hours_start: 21, quiet_hours_end: 6 })
  const body = await (await req('PUT', '/api/agent/preferences', { quiet_hours_end: 8 })).json()
  assert.equal(body.quiet_hours_start, 21, 'kept')
  assert.equal(body.quiet_hours_end, 8, 'updated')
})

test('PUT /api/agent/preferences rejects hours outside 0-23', async () => {
  for (const [start, end] of [[24, 6], [-1, 6], [22, 24], [1.5, 6]]) {
    const res = await req('PUT', '/api/agent/preferences', { quiet_hours_start: start, quiet_hours_end: end })
    assert.equal(res.status, 400, `${start}-${end} should be rejected`)
    assert.match((await res.json()).error, /whole hour between 0 and 23/)
  }
})

test('PUT /api/agent/preferences rejects a zero-length quiet window', async () => {
  const res = await req('PUT', '/api/agent/preferences', { quiet_hours_start: 9, quiet_hours_end: 9 })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /same hour/)
})

test('PUT /api/agent/preferences rejects unauthenticated requests', async () => {
  const res = await req('PUT', '/api/agent/preferences', { language: 'hi' }, null)
  assert.equal(res.status, 401)
})

test('isValidTimezone matches what the preferences route accepts', () => {
  assert.equal(isValidTimezone('Asia/Kolkata'), true)
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('Mars/Olympus_Mons'), false)
  assert.equal(isValidTimezone(''), false)
})

// --- The timezone preference drives day boundaries ---

test('agentTimezone returns the agent preference', async () => {
  await updateAgentPreferences(agentA.id, { timezone: 'America/New_York' })
  assert.equal(await agentTimezone(agentA.id), 'America/New_York')
  await updateAgentPreferences(agentA.id, { timezone: 'Asia/Kolkata' })
  assert.equal(await agentTimezone(agentA.id), 'Asia/Kolkata')
})

test('agentTimezone falls back to Asia/Kolkata for an unknown agent', async () => {
  assert.equal(await agentTimezone(999999), 'Asia/Kolkata')
})

test('GET /api/stats works under a non-default agent timezone', async () => {
  await updateAgentPreferences(agentA.id, { timezone: 'Pacific/Kiritimati' })
  const res = await req('GET', '/api/stats')
  assert.equal(res.status, 200, 'the agent timezone is interpolated as a query param, not SQL')
  assert.equal(typeof (await res.json()).newToday, 'number')
  await updateAgentPreferences(agentA.id, { timezone: 'Asia/Kolkata' })
})

// --- DB layer directly ---

test('updateAgentProfileSelf is a no-op when given no fields', async () => {
  const before = await getAgent(agentA.id)
  const after = await updateAgentProfileSelf(agentA.id, {})
  assert.deepEqual(after, before)
})

test('updateAgentProfileSelf rejects an unknown agent', async () => {
  await assert.rejects(() => updateAgentProfileSelf(999999, { name: 'Ghost' }), (err) => err.code === 'NOT_FOUND')
})

test('updateAgentPreferences rejects an unknown agent', async () => {
  await assert.rejects(() => updateAgentPreferences(999999, { language: 'hi' }), (err) => err.code === 'NOT_FOUND')
})

// --- PUT /api/agent/password ---

test('PUT /api/agent/password changes the password and keeps the session alive', async () => {
  const res = await req('PUT', '/api/agent/password', {
    current_password: PASSWORD_A,
    new_password: 'brand-new-pass',
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.password_hash, undefined, 'never leaks the hash')

  // The change signed every session out, including this one — the caller is handed a
  // replacement token in the response and stays logged in only by adopting it.
  assert.equal((await req('GET', '/api/auth/me')).status, 401, 'the old token is revoked')
  assert.ok(body.token, 'a replacement token comes back')
  tokenA = body.token
  assert.equal((await req('GET', '/api/auth/me')).status, 200, 'and it works')

  const ok = await req('POST', '/api/auth/login', { phone: agentA.phone, password: 'brand-new-pass' }, null)
  assert.equal(ok.status, 200, 'new password works')

  const stale = await req('POST', '/api/auth/login', { phone: agentA.phone, password: PASSWORD_A }, null)
  assert.equal(stale.status, 401, 'old password no longer works')
  await resetPasswordA()
})

test('PUT /api/agent/password rejects a wrong current password with 403', async () => {
  const res = await req('PUT', '/api/agent/password', {
    current_password: 'not-my-password',
    new_password: 'another-good-one',
  })
  assert.equal(res.status, 403)
  assert.match((await res.json()).error, /Wrong password/)
  const still = await req('POST', '/api/auth/login', { phone: agentA.phone, password: PASSWORD_A }, null)
  assert.equal(still.status, 200, 'password unchanged')
})

test('PUT /api/agent/password rejects a missing current password with 403', async () => {
  const res = await req('PUT', '/api/agent/password', { new_password: 'another-good-one' })
  assert.equal(res.status, 403)
})

test('PUT /api/agent/password rejects a password under 6 characters', async () => {
  const res = await req('PUT', '/api/agent/password', { current_password: PASSWORD_A, new_password: 'short' })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /at least 6 characters/)
})

test('PUT /api/agent/password rejects reusing the current password', async () => {
  const res = await req('PUT', '/api/agent/password', {
    current_password: PASSWORD_A,
    new_password: PASSWORD_A,
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /different from your current password/)
})

test('PUT /api/agent/password checks the current password before validating the new one', async () => {
  // A wrong current password must not reveal whether the new one would be accepted.
  const res = await req('PUT', '/api/agent/password', { current_password: 'wrong', new_password: 'x' })
  assert.equal(res.status, 403, 'not 400')
})

test('PUT /api/agent/password rejects unauthenticated requests', async () => {
  const res = await req('PUT', '/api/agent/password', {
    current_password: PASSWORD_A,
    new_password: 'another-good-one',
  }, null)
  assert.equal(res.status, 401)
})

test('PUT /api/agent/password only ever changes the caller', async () => {
  await req('PUT', '/api/agent/password', { current_password: PASSWORD_B, new_password: 'beta-new-pass' }, tokenB)
  const betaOk = await req('POST', '/api/auth/login', { phone: agentB.phone, password: 'beta-new-pass' }, null)
  assert.equal(betaOk.status, 200)
  const alphaOk = await req('POST', '/api/auth/login', { phone: agentA.phone, password: PASSWORD_A }, null)
  assert.equal(alphaOk.status, 200, 'agent A untouched')
  await resetPasswordB()
})

test('PUT /api/agent/password stores a fresh salt, not the same hash', async () => {
  const { getAgentPasswordHash } = await import('../db.js')
  const before = await getAgentPasswordHash(agentA.id)
  await req('PUT', '/api/agent/password', { current_password: PASSWORD_A, new_password: 'rotated-pass-1' })
  const after = await getAgentPasswordHash(agentA.id)
  assert.notEqual(before, after)
  assert.ok(verifyPassword('rotated-pass-1', after))
  assert.ok(!verifyPassword(PASSWORD_A, after))
  await resetPasswordA()
})

test('PUT /api/agent/password writes an audit entry with no password material', async () => {
  await req('PUT', '/api/agent/password', { current_password: PASSWORD_A, new_password: 'audited-pass-1' })
  const entry = (await listAuditLogs(agentA.id)).find((l) => l.action === 'password_changed')
  assert.ok(entry, 'password_changed audit entry exists')
  assert.equal(entry.entity_id, agentA.id)
  assert.deepEqual(entry.details, {}, 'no password material in the audit log')
  await resetPasswordA()
})

test('changePassword rejects an unknown agent', async () => {
  await assert.rejects(
    () => changePassword(999999, { current_password: PASSWORD_A, new_password: 'whatever-1' }),
    (err) => err.code === 'BAD_PASSWORD',
  )
})
