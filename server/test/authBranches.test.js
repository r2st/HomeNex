// Branch coverage for auth.js: the rejection arms of signup/login/credential
// changes, every way a session token can fail to resolve to an agent, and the two
// sources the session secret can come from. The happy paths are already covered by
// the flow suites — this file is deliberately about everything that says "no".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.SESSION_SECRET
const dbName = await createTestDb('authbranches')

const { app } = await import('../index.js')
const { closePool, query, setMeta, getAgent } = await import('../db.js')
const {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  signup,
  login,
  changePhone,
  changePassword,
} = await import('../auth.js')

let server, base, agent

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

// Rejects with the thrown error, so a test can assert on .message and .code.
const rejects = async (fn) => {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw, but it resolved')
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  // Seed the persisted secret before anything mints a token, so getSecret() takes
  // the "already stored" arm. A cold install (no row yet) generates one instead —
  // that arm is exercised by every other suite in the run.
  await setMeta('session_secret', 'a'.repeat(64))
  ;({ agent } = await signup({ name: 'Auth Asha', phone: '+919770000001', password: 'secret123' }))
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Password hashing ---------------------------------------------------------

test('hashPassword round-trips and rejects the wrong password', () => {
  const stored = hashPassword('correct horse')
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'salt:hash hex')
  assert.equal(verifyPassword('correct horse', stored), true)
  assert.equal(verifyPassword('wrong horse', stored), false)
})

test('verifyPassword returns false rather than throwing on a malformed stored hash', () => {
  // timingSafeEqual throws when the buffers differ in length; a corrupt or
  // truncated hash column must read as "wrong password", not as a 500.
  assert.equal(verifyPassword('x', `${'0'.repeat(32)}:00ff`), false, 'too short to compare')
  assert.equal(verifyPassword('x', `${'0'.repeat(32)}:zzzz`), false, 'not hex at all')
})

// --- Token verification -------------------------------------------------------

test('verifyToken rejects every shape that is not a signed agent id', async () => {
  assert.equal(await verifyToken(null), null, 'no token')
  assert.equal(await verifyToken(''), null, 'empty token')
  assert.equal(await verifyToken('nodothere'), null, 'no signature segment')
  assert.equal(await verifyToken('.onlyasig'), null, 'no id segment')
  assert.equal(await verifyToken(`${agent.id}.`), null, 'empty signature')
  // A signature of the wrong length makes timingSafeEqual throw — still a plain null.
  assert.equal(await verifyToken(`${agent.id}.deadbeef`), null, 'short signature')
  // Right length, wrong value: the constant-time compare returns false.
  const real = await issueToken(agent.id)
  const [, sig] = real.split('.')
  const flipped = sig[0] === '0' ? `1${sig.slice(1)}` : `0${sig.slice(1)}`
  assert.equal(await verifyToken(`${agent.id}.${flipped}`), null, 'forged signature')
})

test('verifyToken rejects a correctly signed id that has no agent behind it', async () => {
  assert.equal(await verifyToken(await issueToken(987654)), null)
})

test('a deactivated agent’s existing token stops working immediately', async () => {
  const { agent: doomed, token } = await signup({
    name: 'Gone Gaurav',
    phone: '+919770000002',
    password: 'secret123',
  })
  assert.ok(await verifyToken(token), 'valid while active')
  await query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [doomed.id])
  assert.equal(await verifyToken(token), null, 'the same token is dead once deactivated')
})

test('SESSION_SECRET, when set, overrides the persisted secret', async () => {
  process.env.SESSION_SECRET = 'env-secret-wins'
  try {
    const token = await issueToken(agent.id)
    const resolved = await verifyToken(token)
    assert.equal(resolved.id, agent.id, 'a token minted under the env secret verifies under it')
  } finally {
    delete process.env.SESSION_SECRET
  }
  // And a token minted under the env secret is not accepted once it is gone.
  process.env.SESSION_SECRET = 'env-secret-wins'
  const envToken = await issueToken(agent.id)
  delete process.env.SESSION_SECRET
  assert.equal(await verifyToken(envToken), null, 'secrets are not interchangeable')
})

// --- requireAuth middleware ---------------------------------------------------

test('requireAuth answers 401 with no header, a junk header, or a dead token', async () => {
  assert.equal((await req('GET', '/api/leads')).status, 401, 'no Authorization header')
  assert.equal((await req('GET', '/api/leads', undefined, 'not-a-token')).status, 401)
  assert.equal((await req('GET', '/api/leads', undefined, `${agent.id}.deadbeef`)).status, 401)
})

test('an unexpected failure while resolving a token becomes a 500, not a hung request', async () => {
  // A correctly signed but absurd agent id overflows the integer column, so the
  // lookup rejects instead of returning a row. requireAuth forwards that to the
  // error handler rather than swallowing it.
  const token = await issueToken('99999999999999999999')
  const realError = console.error
  console.error = () => {}
  try {
    const res = await req('GET', '/api/leads', undefined, token)
    assert.equal(res.status, 500)
    assert.equal((await res.json()).code, 'INTERNAL')
  } finally {
    console.error = realError
  }
})

// --- signup validation --------------------------------------------------------

test('signup requires a name, a number and a password', async () => {
  for (const body of [
    { phone: '+919770000010', password: 'secret123' },
    { name: 'No Phone', password: 'secret123' },
    { name: 'No Password', phone: '+919770000010' },
    {},
  ]) {
    const err = await rejects(() => signup(body))
    assert.match(err.message, /required/)
  }
})

test('signup rejects a number that is too short to be a mobile', async () => {
  const err = await rejects(() => signup({ name: 'Short Suresh', phone: '+9197700', password: 'secret123' }))
  assert.match(err.message, /valid WhatsApp number/)
})

test('signup rejects a malformed email but allows no email at all', async () => {
  const err = await rejects(() =>
    signup({ name: 'Bad Email', phone: '+919770000011', password: 'secret123', email: 'not-an-email' }),
  )
  assert.match(err.message, /valid email/)

  const { agent: noEmail } = await signup({ name: 'No Email', phone: '+919770000012', password: 'secret123' })
  assert.equal(noEmail.email, null, 'an omitted email is stored as NULL, not an empty string')
})

test(`signup rejects a password under ${MIN_PASSWORD_LENGTH} characters`, async () => {
  const err = await rejects(() => signup({ name: 'Weak Wasim', phone: '+919770000013', password: 'abc' }))
  assert.match(err.message, new RegExp(`at least ${MIN_PASSWORD_LENGTH}`))
})

test('signup refuses a number or an email that is already registered', async () => {
  await signup({ name: 'First Farah', phone: '+919770000014', password: 'secret123', email: 'farah@example.com' })
  const byPhone = await rejects(() => signup({ name: 'Dup', phone: '+919770000014', password: 'secret123' }))
  assert.match(byPhone.message, /already exists/)
  const byEmail = await rejects(() =>
    signup({ name: 'Dup', phone: '+919770000015', password: 'secret123', email: 'farah@example.com' }),
  )
  assert.match(byEmail.message, /email already exists/)
})

test('the WhatsApp Business number defaults to the login number unless overridden', async () => {
  const { agent: defaulted } = await signup({ name: 'Same Number', phone: '+919770000016', password: 'secret123' })
  const a = await getAgent(defaulted.id)
  assert.equal(a.wa_phone_number, '+919770000016')

  const { agent: split } = await signup({
    name: 'Split Number',
    phone: '+919770000017',
    password: 'secret123',
    wa_phone_number: '+919770000099',
  })
  assert.equal((await getAgent(split.id)).wa_phone_number, '+919770000099')
})

// --- login --------------------------------------------------------------------

test('login works by email as well as by number', async () => {
  await signup({ name: 'Mail Meera', phone: '+919770000020', password: 'secret123', email: 'meera@example.com' })
  assert.ok((await login({ email: 'meera@example.com', password: 'secret123' })).token)
  assert.ok((await login({ phone: '+919770000020', password: 'secret123' })).token)
})

test('login gives the same answer for an unknown account and a wrong password', async () => {
  const unknown = await rejects(() => login({ phone: '+919779999999', password: 'secret123' }))
  const wrong = await rejects(() => login({ phone: '+919770000020', password: 'nope-nope' }))
  const noEmail = await rejects(() => login({ password: 'secret123' }))
  assert.equal(unknown.message, wrong.message, 'no account enumeration')
  assert.equal(noEmail.message, wrong.message)
})

test('login on a deactivated account reports it only after the password checks out', async () => {
  const { agent: susp } = await signup({ name: 'Susp Sunil', phone: '+919770000021', password: 'secret123' })
  await query('UPDATE agents SET is_active = 0, deactivated_at = now() WHERE id = $1', [susp.id])

  // Wrong password on a deactivated account is indistinguishable from any other
  // wrong password — the deactivation is not a discovery oracle.
  const wrong = await rejects(() => login({ phone: '+919770000021', password: 'not-it' }))
  assert.equal(wrong.code, undefined)
  assert.match(wrong.message, /Wrong WhatsApp number or password/)

  const right = await rejects(() => login({ phone: '+919770000021', password: 'secret123' }))
  assert.equal(right.code, 'DEACTIVATED')
})

// --- changePhone / changePassword ---------------------------------------------

test('changePhone needs the current password and a real agent', async () => {
  const { agent: mover } = await signup({ name: 'Move Mohan', phone: '+919770000030', password: 'secret123' })

  const noArgs = await rejects(() => changePhone(mover.id))
  assert.equal(noArgs.code, 'BAD_PASSWORD', 'omitting the body is a wrong password, not a crash')
  const wrong = await rejects(() => changePhone(mover.id, { phone: '+919770000031', password: 'nope' }))
  assert.equal(wrong.code, 'BAD_PASSWORD')
  const ghost = await rejects(() => changePhone(987654, { phone: '+919770000031', password: 'secret123' }))
  assert.equal(ghost.code, 'BAD_PASSWORD', 'an agent with no stored hash cannot pass the check')

  const moved = await changePhone(mover.id, { phone: '+919770000031', password: 'secret123' })
  assert.equal(moved.phone, '+919770000031')
})

test('changePassword rejects a wrong current, a weak new, and a reused password', async () => {
  const { agent: rot } = await signup({ name: 'Rotate Rita', phone: '+919770000040', password: 'secret123' })

  assert.equal((await rejects(() => changePassword(rot.id))).code, 'BAD_PASSWORD', 'no body at all')
  assert.equal(
    (await rejects(() => changePassword(rot.id, { current_password: 'nope', new_password: 'secret456' }))).code,
    'BAD_PASSWORD',
  )
  assert.equal(
    (await rejects(() => changePassword(987654, { current_password: 'secret123', new_password: 'secret456' }))).code,
    'BAD_PASSWORD',
    'no stored hash',
  )
  assert.equal(
    (await rejects(() => changePassword(rot.id, { current_password: 'secret123', new_password: 'abc' }))).code,
    'WEAK_PASSWORD',
  )
  assert.equal(
    (await rejects(() => changePassword(rot.id, { current_password: 'secret123' }))).code,
    'WEAK_PASSWORD',
    'a missing new password is weak, not a crash',
  )
  assert.equal(
    (await rejects(() => changePassword(rot.id, { current_password: 'secret123', new_password: 'secret123' }))).code,
    'SAME_PASSWORD',
  )

  await changePassword(rot.id, { current_password: 'secret123', new_password: 'secret456' })
  assert.ok((await login({ phone: '+919770000040', password: 'secret456' })).token, 'the new password works')
})

test('a session survives its own password change', async () => {
  const { agent: keep, token } = await signup({ name: 'Keep Kavya', phone: '+919770000050', password: 'secret123' })
  await changePassword(keep.id, { current_password: 'secret123', new_password: 'secret456' })
  // The token is an HMAC of the agent id with no server-side session, so it stays
  // valid — the agent is not logged out of the device they just used.
  assert.equal((await verifyToken(token)).id, keep.id)
})
