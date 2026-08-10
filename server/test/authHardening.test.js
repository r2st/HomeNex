// Auth-surface hardening: the login enumeration oracle and the agents.email
// uniqueness gap. Both are about an attacker learning or occupying an identity
// they don't own, so the assertions are about what an outsider can observe.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('authhardening')

const { app } = await import('../index.js')
const db = await import('../db.js')
const { login, signup, hashPassword } = await import('../auth.js')

let server, base

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Median of n timings, so one scheduler hiccup can't decide the test.
async function medianMs(runs, fn) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint()
    await fn()
    samples.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  await signup({ name: 'Real Agent', phone: '+919700000001', email: 'real@homenex.test', password: 'secret123' })
})

after(async () => {
  server?.close()
  await db.closePool()
  await dropTestDb(dbName)
})

// === Login must not leak which numbers hold accounts ===

test('a wrong password and an unknown number are indistinguishable to the caller', async () => {
  const wrongPassword = await req('POST', '/api/auth/login', { phone: '+919700000001', password: 'nope' })
  const unknownNumber = await req('POST', '/api/auth/login', { phone: '+919700009999', password: 'nope' })

  assert.equal(wrongPassword.status, 401)
  assert.equal(unknownNumber.status, 401)
  assert.deepEqual(await wrongPassword.json(), await unknownNumber.json())
})

test('an unknown number costs the same work as a real one, so timing is not an oracle', async () => {
  // The whole cost of a login is scryptSync (~100ms). Before the fix a miss
  // returned without hashing at all, which showed up as a two-orders-of-magnitude
  // gap — trivially enough to enumerate every agent's WhatsApp number. The bound
  // here is deliberately loose: the point is "same ballpark", not "same clock".
  const hit = await medianMs(5, () => login({ phone: '+919700000001', password: 'wrong' }).catch(() => {}))
  const miss = await medianMs(5, () => login({ phone: '+919700009999', password: 'wrong' }).catch(() => {}))

  assert.ok(hit > 1, `a real password check should cost real time, took ${hit.toFixed(1)}ms`)
  assert.ok(
    miss > hit * 0.5,
    `an unknown account returned in ${miss.toFixed(1)}ms against ${hit.toFixed(1)}ms for a known one — that gap enumerates accounts`,
  )
})

test('the same holds for login by email', async () => {
  const known = await req('POST', '/api/auth/login', { email: 'real@homenex.test', password: 'nope' })
  const unknown = await req('POST', '/api/auth/login', { email: 'nobody@homenex.test', password: 'nope' })
  assert.equal(known.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(await known.json(), await unknown.json())
})

test('a correct password still logs in', async () => {
  const res = await req('POST', '/api/auth/login', { phone: '+919700000001', password: 'secret123' })
  assert.equal(res.status, 200)
  assert.ok((await res.json()).token)
})

// === agents.email is now unique, and the constraint is real ===

test('the partial unique index on lower(email) exists', async () => {
  const { rows } = await db.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'agents' AND indexname = 'idx_agents_email_unique'`,
  )
  assert.equal(rows.length, 1, 'migration 017 did not create the index')
  assert.match(rows[0].indexdef, /UNIQUE/)
  assert.match(rows[0].indexdef, /lower\(email\)/)
})

test('a second account cannot take an email that is already in use', async () => {
  await assert.rejects(
    () => signup({ name: 'Impostor', phone: '+919700000002', email: 'real@homenex.test', password: 'secret123' }),
    /already exists/,
  )
  const res = await req('POST', '/api/auth/signup', {
    name: 'Impostor', phone: '+919700000003', email: 'real@homenex.test', password: 'secret123',
  })
  assert.equal(res.status, 400)
})

test('a differently-cased address is the same address', async () => {
  await assert.rejects(
    () => signup({ name: 'Shouty', phone: '+919700000004', email: 'REAL@HomeNex.TEST', password: 'secret123' }),
    /already exists/,
  )
  // ...and it resolves to the one account that owns it, whatever case is typed.
  const found = await db.findAgentByEmail('REAL@HOMENEX.TEST')
  assert.equal(found.email, 'real@homenex.test')
  const res = await req('POST', '/api/auth/login', { email: 'REAL@HomeNex.TEST', password: 'secret123' })
  assert.equal(res.status, 200)
})

// The pre-checks in signup/updateAgentProfile are reads, so a concurrent writer can
// still slip past them. createAgent is what the constraint actually hits.
test('the constraint, not the pre-check, is what stops a racing signup', async () => {
  await assert.rejects(
    () => db.createAgent('Racer', '+919700000005', 'real@homenex.test', hashPassword('secret123')),
    (err) => {
      assert.equal(err.code, 'AGENT_EXISTS')
      assert.match(err.message, /email already exists/)
      return true
    },
  )
  // A racing duplicate phone is reported as a phone conflict, not an email one.
  await assert.rejects(
    () => db.createAgent('Racer', '+919700000001', 'fresh@homenex.test', hashPassword('secret123')),
    (err) => {
      assert.equal(err.code, 'AGENT_EXISTS')
      assert.match(err.message, /WhatsApp number already exists/)
      return true
    },
  )
  // Neither attempt left a half-built workspace behind.
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM agents')).rows[0].n, 1)
})

test('two genuinely concurrent signups for one email leave exactly one account', async () => {
  const attempts = await Promise.allSettled(
    [6, 7].map((n) =>
      signup({ name: `Racer${n}`, phone: `+91970000000${n}`, email: 'contested@homenex.test', password: 'secret123' }),
    ),
  )
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1, 'exactly one signup should win')
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM agents WHERE email = 'contested@homenex.test'")
  assert.equal(rows[0].n, 1)
})

test('an agent cannot edit their profile onto another agent\'s email', async () => {
  const { token } = await signup({ name: 'Mover', phone: '+919700000010', email: 'mover@homenex.test', password: 'secret123' })
  const res = await req('PUT', '/api/agent/profile', { email: 'real@homenex.test' }, token)
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /already uses this email/)

  // Case-folded, too — the clash check reads lower(email) like the index does.
  const shouty = await req('PUT', '/api/agent/profile', { email: 'REAL@homenex.test' }, token)
  assert.equal(shouty.status, 409)

  // Their own address is still settable (no self-clash).
  assert.equal((await req('PUT', '/api/agent/profile', { email: 'mover@homenex.test' }, token)).status, 200)
})

// The pre-checks in both profile editors are reads too, so the constraint has to
// catch what slips past them — and report it as a conflict, not a 500.
test('two profile saves racing onto one email leave exactly one holder', async () => {
  const a = await signup({ name: 'Race A', phone: '+919700000020', password: 'secret123' })
  const b = await signup({ name: 'Race B', phone: '+919700000021', password: 'secret123' })

  const results = await Promise.allSettled([
    db.updateAgentProfileSelf(a.agent.id, { email: 'prize@homenex.test' }),
    db.updateAgentProfileSelf(b.agent.id, { email: 'prize@homenex.test' }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  for (const r of results) {
    if (r.status === 'rejected') {
      assert.equal(r.reason.code, 'EMAIL_TAKEN')
      assert.match(r.reason.message, /already uses this email/)
    }
  }
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM agents WHERE email = 'prize@homenex.test'")
  assert.equal(rows[0].n, 1)
})

test('the admin profile editor reports a raced email as a conflict too', async () => {
  const a = await signup({ name: 'Admin Race A', phone: '+919700000022', password: 'secret123' })
  const b = await signup({ name: 'Admin Race B', phone: '+919700000023', password: 'secret123' })

  const results = await Promise.allSettled([
    db.updateAgentProfile(a.agent.id, { email: 'adminprize@homenex.test' }),
    db.updateAgentProfile(b.agent.id, { email: 'adminprize@homenex.test' }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'EMAIL_TAKEN')
})

test('a raced phone change is reported as a phone conflict, not an email one', async () => {
  const a = await signup({ name: 'Phone Race A', phone: '+919700000024', password: 'secret123' })
  const b = await signup({ name: 'Phone Race B', phone: '+919700000025', password: 'secret123' })

  const results = await Promise.allSettled([
    db.updateAgentProfile(a.agent.id, { phone: '+919700000099' }),
    db.updateAgentProfile(b.agent.id, { phone: '+919700000099' }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  for (const r of results) {
    if (r.status === 'rejected') {
      assert.equal(r.reason.code, 'PHONE_TAKEN')
      assert.match(r.reason.message, /phone number/)
    }
  }
})

test('a non-constraint database error is not disguised as a conflict', async () => {
  // The catch arms only translate 23505; anything else has to keep propagating,
  // or a real fault would be reported to the agent as "email taken".
  await assert.rejects(
    () => db.updateAgentProfile(999_999_999, { name: 'Ghost' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND')
      return true
    },
  )
})

test('clearing an email is allowed for as many agents as like — NULL never collides', async () => {
  const a = await signup({ name: 'Blank A', phone: '+919700000011', email: 'blanka@homenex.test', password: 'secret123' })
  const b = await signup({ name: 'Blank B', phone: '+919700000012', email: 'blankb@homenex.test', password: 'secret123' })
  assert.equal((await req('PUT', '/api/agent/profile', { email: '' }, a.token)).status, 200)
  assert.equal((await req('PUT', '/api/agent/profile', { email: '' }, b.token)).status, 200)
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM agents WHERE email IS NULL')
  assert.ok(rows[0].n >= 2)
})

// --- Session revocation --------------------------------------------------------

// The scenario this exists for: an agent's phone is stolen, or a token leaks. There
// is no server-side session row to delete, so before token versioning the only
// remedy was an admin deactivating the whole account. Changing the password is what
// an agent actually reaches for, and it now does the job.
test('changing the password logs out every other device, over HTTP', async () => {
  const phone = '+919733000100'
  const { token: stolen } = await signup({ name: 'Stolen Sneha', phone, password: 'secret123' })
  const { token: mine } = await login({ phone, password: 'secret123' })

  assert.equal((await req('GET', '/api/auth/me', undefined, stolen)).status, 200, 'the thief is in')

  const changed = await req(
    'PUT',
    '/api/agent/password',
    { current_password: 'secret123', new_password: 'secret456' },
    mine,
  )
  assert.equal(changed.status, 200)
  const replacement = (await changed.json()).token
  assert.ok(replacement, 'the caller is handed a replacement token')

  assert.equal((await req('GET', '/api/auth/me', undefined, stolen)).status, 401, 'the thief is out')
  assert.equal((await req('GET', '/api/auth/me', undefined, mine)).status, 401, 'so is the token that asked')
  assert.equal((await req('GET', '/api/auth/me', undefined, replacement)).status, 200, 'the replacement works')
})

// A revoked token must not be repairable by hand. The version is inside the signed
// payload, so editing it invalidates the signature rather than bumping the session.
test('a revoked token cannot be revived by editing its version', async () => {
  const phone = '+919733000101'
  const { agent, token } = await signup({ name: 'Forger Farah', phone, password: 'secret123' })
  await req('PUT', '/api/agent/password', { current_password: 'secret123', new_password: 'secret456' }, token)

  const [id, version, sig] = token.split('.')
  const current = Number((await db.getAgent(agent.id)).token_version)
  assert.equal(current, Number(version) + 1, 'the version moved on')

  for (const forged of [`${id}.${current}.${sig}`, `${id}.${version}.${sig}`, `${id}.${current}.${sig.slice(0, -1)}0`]) {
    assert.equal((await req('GET', '/api/auth/me', undefined, forged)).status, 401, forged)
  }
})

// Deactivation and password change are independent revocation paths; neither may
// resurrect a session the other closed.
test('a password change on a deactivated account does not reopen it', async () => {
  const phone = '+919733000102'
  const { agent } = await signup({ name: 'Dormant Dev', phone, password: 'secret123' })
  await db.query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [agent.id])
  const { issueToken, verifyToken } = await import('../auth.js')
  const fresh = await issueToken(agent.id)
  assert.equal(await verifyToken(fresh), null, 'a correctly signed token is still refused while deactivated')
})
