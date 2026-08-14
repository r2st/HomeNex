// EMI calculator: parsing, the reducing-balance formula, the API endpoint, and
// the in-chat auto-reply (which must work with AI completely disabled).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import {
  detectEmiQuery,
  parseAmountLakhs,
  parseEmiQuery,
  calculateEmi,
  formatEmiMessage,
  emiReplyFor,
} from '../emi.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('emi')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server
let base
let token

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await req('POST', '/api/auth/signup', { name: 'EMI Agent', phone: '+919800000031', password: 'secret123' })
  ).json()
  token = out.token
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('detectEmiQuery spots EMI and loan-installment questions', () => {
  assert.equal(detectEmiQuery('what is the EMI for 80L?'), true)
  assert.equal(detectEmiQuery('emi kitna hoga 50 lakh pe'), true)
  assert.equal(detectEmiQuery('loan monthly payment for 60L'), true)
  assert.equal(detectEmiQuery('I want a 2BHK in Wakad'), false)
  assert.equal(detectEmiQuery('can I get a loan'), false) // loan alone isn't an EMI ask
})

test('parseAmountLakhs handles Indian amount formats', () => {
  assert.equal(parseAmountLakhs('80L'), 80)
  assert.equal(parseAmountLakhs('80 lakhs'), 80)
  assert.equal(parseAmountLakhs('1.2 cr'), 120)
  assert.equal(parseAmountLakhs('1.2 crore budget'), 120)
  assert.equal(parseAmountLakhs('₹8000000'), 80)
  assert.equal(parseAmountLakhs('80,00,000'), 80)
  assert.equal(parseAmountLakhs('no amount here'), null)
})

test('parseEmiQuery extracts principal, rate and tenure with defaults', () => {
  const full = parseEmiQuery('EMI for 80L at 8.5% for 20 years')
  assert.equal(full.principalLakhs, 80)
  assert.equal(full.ratePct, 8.5)
  assert.equal(full.years, 20)
  assert.equal(full.assumedRate, false)
  assert.equal(full.assumedTenure, false)

  const partial = parseEmiQuery('emi for 50 lakh')
  assert.equal(partial.principalLakhs, 50)
  assert.equal(partial.ratePct, 8.5) // default
  assert.equal(partial.years, 20) // default
  assert.equal(partial.assumedRate, true)
  assert.equal(partial.assumedTenure, true)

  const hinglish = parseEmiQuery('1 cr ka emi 15 saal at 9')
  assert.equal(hinglish.principalLakhs, 100)
  assert.equal(hinglish.ratePct, 9)
  assert.equal(hinglish.years, 15)

  assert.equal(parseEmiQuery('emi please'), null) // no amount
})

test('calculateEmi matches the standard reducing-balance formula', () => {
  // ₹80L @ 8.5% for 20 years → EMI ≈ ₹69,426 (standard bank calculator figure)
  const r = calculateEmi({ principalPaise: 80 * 1e7, ratePct: 8.5, years: 20 })
  assert.equal(r.months, 240)
  const emiRupees = Math.round(r.emi_paise / 100)
  assert.ok(Math.abs(emiRupees - 69426) <= 1, `expected ~69426, got ${emiRupees}`)
  assert.equal(r.total_payment_paise, r.emi_paise * 240)
  assert.equal(r.total_interest_paise, r.total_payment_paise - 80 * 1e7)

  // Zero interest edge case: plain division.
  const z = calculateEmi({ principalPaise: 12 * 1e7, ratePct: 0, years: 1 })
  assert.equal(z.emi_paise, 1e7)

  assert.equal(calculateEmi({ principalPaise: 0, ratePct: 8.5, years: 20 }), null)
})

test('formatEmiMessage produces a WhatsApp-ready breakdown', () => {
  const msg = formatEmiMessage(parseEmiQuery('80L at 8.5% for 20 years'))
  assert.match(msg, /EMI Calculation/)
  assert.match(msg, /₹80 L/)
  assert.match(msg, /8\.5% p\.a\./)
  assert.match(msg, /20 years \(240 months\)/)
  assert.match(msg, /Monthly EMI: \*₹69,42[56]\*/)
  assert.match(msg, /Total interest/)
  assert.match(msg, /Total payment/)

  const assumed = formatEmiMessage(parseEmiQuery('emi for 50L'))
  assert.match(assumed, /Assumed 8\.5% p\.a\. and 20 years/)
})

test('a figure under a lakh is written in rupees, not as "₹0 L"', () => {
  // The big-number formatter has three arms — Cr, L, and plain rupees — and only the
  // first two are reached by a normal home loan. Total interest on a small, short
  // one lands in the third, and rounding it to lakhs would print "₹0 L" for ₹4,386:
  // the one number in the message an agent would forward to a buyer verbatim.
  const msg = formatEmiMessage(parseEmiQuery('emi for 1L at 8% for 1 year'))
  assert.match(msg, /Total interest: ₹4,386\b/)
  assert.doesNotMatch(msg, /interest: ₹0/)
  // The loan amount itself is exactly at the lakh boundary and still reads as lakhs.
  assert.match(msg, /Loan amount: ₹1 L/)
})

test('a crore-scale loan is written in Cr, not as a nine-digit rupee figure', () => {
  // The other end of the same formatter. ₹2.5 Cr is how the amount is said out loud;
  // "₹2,50,00,000" is not something a buyer reads back off a WhatsApp message.
  const msg = formatEmiMessage(parseEmiQuery('emi for 2.5 crore at 9% for 20 years'))
  assert.match(msg, /Loan amount: ₹2\.5 Cr/)
  // The monthly EMI is deliberately NOT abbreviated — it is the number that has to be
  // exact, so it stays in full rupees however large the loan is.
  assert.match(msg, /Monthly EMI: \*₹2,2\d,\d{3}\*/)
})

test('emiReplyFor only answers EMI questions with a parseable amount', () => {
  assert.match(emiReplyFor('what will be the emi for 80L at 8.5% for 20 years'), /Monthly EMI/)
  assert.equal(emiReplyFor('2bhk chahiye wakad me'), null)
  assert.equal(emiReplyFor('emi kya hoga?'), null) // EMI-shaped but no amount
})

test('POST /api/emi calculates from free text and from structured inputs', async () => {
  const fromText = await (await req('POST', '/api/emi', { text: 'EMI for 80L at 8.5% for 20 years' })).json()
  assert.equal(fromText.principalLakhs, 80)
  assert.match(fromText.message, /Monthly EMI/)

  const structured = await (await req('POST', '/api/emi', { principal_l: 100, rate_pct: 9, years: 15 })).json()
  assert.equal(structured.ratePct, 9)
  assert.match(structured.message, /15 years \(180 months\)/)

  assert.equal((await req('POST', '/api/emi', { text: 'hello' })).status, 400)
  assert.equal((await req('POST', '/api/emi', {})).status, 400)
})

test('inbound EMI question gets an instant calculated reply — no AI needed', async () => {
  const res = await req('POST', '/api/simulate', {
    from: '919777700031',
    name: 'EMI Eshan',
    text: 'Sir emi kitna hoga 80L at 8.5% for 20 years?',
  })
  assert.equal(res.status, 200)
  const { reply } = await res.json()
  assert.ok(reply, 'expected an auto-reply despite AI being unconfigured')
  assert.match(reply, /Monthly EMI: \*₹69,42[56]\*/)
})
