// The public auth pair — POST /api/auth/signup and /api/auth/login — and the email
// check they share with the profile routes.
//
// Two defects met on this path. The email pattern was /^\S+@\S+\.\S+$/, which
// backtracks catastrophically because `\S` matches the `@` and the `.` it is supposed
// to be separated by; and signup, being public, ran it on a string bounded only by
// express.json()'s 25MB. One unauthenticated POST could therefore hold the event loop
// for as long as the caller chose the input length. Neither half is enough on its own:
// the pattern is also reached from updateAgentProfileSelf, which deliberately wears no
// boundedText, and a bounded field handed to a quadratic matcher is still quadratic.
//
// So both are asserted here — the matcher is linear, and the routes are bounded.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { TEXT } from '../middleware.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('authinputbounds')

const { app } = await import('../index.js')
const { closePool, isValidEmail } = await import('../db.js')

let server, base

const post = (url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The matcher's verdicts ---------------------------------------------------------

test('isValidEmail still answers exactly as the app has always answered', () => {
  // The addresses the suite and the product already depend on being accepted...
  for (const ok of ['beta@homenex.in', 'a@b.co.in', 'x.y+tag@sub.domain.example', "o'brien@mail.co"]) {
    assert.equal(isValidEmail(ok), true, `${ok} must still be accepted`)
  }
  // ...and the ones already refused, including every case the existing route tests pin.
  for (const bad of ['not-an-email', 'a@b', 'a b@c.in', '', '@', 'a@', '@b.in', 'a@.in']) {
    assert.equal(isValidEmail(bad), false, `${bad} must still be refused`)
  }
})

test('the two corners it is now stricter about were only ever accepted by accident', () => {
  // `\S` matched the delimiters, so the old pattern let a second `@` and a trailing dot
  // through. Neither is a deliverable address, and neither is what the check is for.
  assert.equal(isValidEmail('a@b@c.d'), false, 'two @ is not an address')
  assert.equal(isValidEmail('a@b.c.'), false, 'a trailing dot is not a TLD')
})

// --- The matcher's cost -------------------------------------------------------------

test('a pathological address is refused in linear time, not quadratic', () => {
  // A run of `@`s is the shape that has no early exit: it cannot match, so the old
  // pattern had to try every split before saying so. It cost 18ms at 5k characters,
  // 253ms at 20k and 1.6s at 50k — the curve, not the constant, is the bug.
  //
  // 200k characters is where the old pattern needed roughly half a minute. The bound
  // below is ~50x what the linear form actually takes, so this fails on a regression
  // and not on a slow machine.
  const pathological = '@'.repeat(200_000)
  const started = process.hrtime.bigint()
  assert.equal(isValidEmail(pathological), false)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(ms < 500, `refusing 200k @-characters took ${ms.toFixed(0)}ms — the matcher is backtracking again`)
})

// --- The routes ---------------------------------------------------------------------

test('signup answers a pathological email instead of disappearing into it', async () => {
  // The end-to-end statement of the same claim, through the real public route: the
  // body is refused for its length, before anything gets to measure its shape.
  const started = process.hrtime.bigint()
  const res = await post('/api/auth/signup', {
    name: 'Probe Priya',
    phone: '+919770000900',
    password: 'secret123',
    email: '@'.repeat(200_000),
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const body = await res.json()

  assert.equal(res.status, 400)
  assert.equal(body.code, 'FIELD_TOO_LONG')
  assert.equal(body.field, 'email')
  assert.ok(ms < 1000, `the public signup route took ${ms.toFixed(0)}ms to refuse one body`)
})

test('every field on both auth routes is bounded', async () => {
  // A limit table is easy to write and easy to forget to wire up, and a forgotten one
  // fails open. Same sweep as textLimits.test.js, over the two routes that had none.
  const unguarded = []
  for (const url of ['/api/auth/signup', '/api/auth/login']) {
    for (const [field, max] of Object.entries({
      name: TEXT.LINE, phone: TEXT.LINE, email: TEXT.LINE,
      password: TEXT.PASSWORD, wa_phone_number: TEXT.LINE,
    })) {
      const res = await post(url, { [field]: 'x'.repeat(max + 1) })
      const body = await res.json().catch(() => ({}))
      if (res.status !== 400 || body.code !== 'FIELD_TOO_LONG' || body.field !== field) {
        unguarded.push(`POST ${url} [${field}] -> ${res.status} ${body.code || '?'}`)
      }
    }
  }
  assert.deepEqual(unguarded, [], 'auth fields that accepted one character over their limit')
})

test('a password at exactly the limit still logs in', async () => {
  // The bound has to be off-by-none in the direction that matters most: it is the one
  // guard in this file whose false positive is a locked-out agent rather than a slow
  // request. 1024 characters is far past anything a password manager emits, and an
  // account created with one has to keep working.
  const password = 'p'.repeat(TEXT.PASSWORD)
  const signup = await post('/api/auth/signup', {
    name: 'Long Lata', phone: '+919770000901', password,
  })
  assert.equal(signup.status, 200, 'a 1024-character password is accepted at signup')

  const login = await post('/api/auth/login', { phone: '+919770000901', password })
  assert.equal(login.status, 200, 'and the same password logs the agent back in')
  assert.ok((await login.json()).token, 'with a usable token')
})
