// The public /setup-guide page: the in-app WhatsApp Business onboarding guide linked
// from Settings. It has no auth and no DB, so we can test the pure page function and
// the served route directly. Locks in that every section the guide promises is present
// (prerequisites, the numbered steps, admin embedded signup, troubleshooting, Meta links).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('setupguide')

const { setupGuidePage } = await import('../setupGuide.js')
const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server
let base

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  if (server) server.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The pure page function --------------------------------------------------

test('renders a full HTML document', () => {
  const html = setupGuidePage()
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<\/html>\s*$/)
  assert.match(html, /<title>WhatsApp Business Setup Guide — HomeNex<\/title>/)
})

test('uses the HomeNex theme (dark green header, cream body)', () => {
  const html = setupGuidePage()
  assert.match(html, /--brand: #2D5016/) // dark green
  assert.match(html, /--cream: #faf7f1/) // cream body
  assert.match(html, /🏠 HomeNex/)
})

test('covers the prerequisites', () => {
  const html = setupGuidePage()
  assert.match(html, /Before you start/i)
  assert.match(html, /Business account/i)
  assert.match(html, /verif/i) // verified business
  assert.match(html, /not be active on the regular WhatsApp/i)
})

test('lists the step-by-step add-number flow', () => {
  const html = setupGuidePage()
  assert.match(html, /WhatsApp accounts/) // Settings → WhatsApp accounts
  assert.match(html, /Add phone number/)
  assert.match(html, /verification method/i)
  assert.match(html, /SMS/)
  assert.match(html, /voice call/i)
  assert.match(html, /OTP/)
  assert.match(html, /display name/i)
})

test('includes the admin Embedded Signup section', () => {
  const html = setupGuidePage()
  assert.match(html, /For admins/i)
  assert.match(html, /Embedded Signup/i)
  assert.match(html, /Business Portfolio/i)
})

test('covers the three troubleshooting cases', () => {
  const html = setupGuidePage()
  assert.match(html, /already registered on WhatsApp/i) // number in use
  assert.match(html, /Delete my account/i) // the fix for it
  assert.match(html, /never arrives/i) // OTP not received
  assert.match(html, /display name was rejected/i)
})

test('links to Meta official documentation', () => {
  const html = setupGuidePage()
  assert.match(html, /facebook\.com\/business\/help/)
  assert.match(html, /developers\.facebook\.com\/docs\/whatsapp\/embedded-signup/)
  assert.match(html, /Official documentation/i)
})

// --- The served route --------------------------------------------------------

test('GET /setup-guide returns the guide as HTML, no auth required', async () => {
  const res = await fetch(base + '/setup-guide')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/html/)
  const body = await res.text()
  assert.match(body, /Adding a Phone Number to WhatsApp Business/)
  assert.match(body, /Before you start/)
})
