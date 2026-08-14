// Numbers an agent can post, and numbers a client can filter by.
//
// Two failures live here, and they used to be answered by nothing but the column
// type. A filter that wasn't a number reached Postgres as the string 'NaN' and came
// back as a 500 the caller could not act on; a number that was real but absurd —
// minus fifty lakhs, a 5000% commission, a 1,000,000-year loan — was stored and then
// priced, matched and invoiced as if it meant something.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { boundedNumber, NUM } from '../middleware.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('numlimits')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base, token, leadId

const authed = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (
    await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Numeric Nandini', phone: '+919845000021', password: 'secret123' }),
    })
  ).json()
  token = out.token
  const quick = await (await authed('POST', '/api/leads/quick-add', { phone: '+919845000022', name: 'Buyer' })).json()
  leadId = quick.lead.id
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- The middleware's own rules --------------------------------------------

// Driven directly, like boundedText's: these are the decisions the guard makes
// before a handler sees anything, and each is a choice about what "not a number"
// means.
function run(limits, source, opts) {
  const req = opts?.from === 'query' ? { query: source } : { body: source }
  let rejected = null
  let passed = false
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      rejected = { status: this.statusCode, ...payload }
      return this
    },
  }
  boundedNumber(limits, opts)(req, res, () => {
    passed = true
  })
  return { rejected, passed }
}

test('the bounds are inclusive at both ends', () => {
  assert.equal(run({ n: { min: 0, max: 10 } }, { n: 0 }).passed, true)
  assert.equal(run({ n: { min: 0, max: 10 } }, { n: 10 }).passed, true)
  assert.equal(run({ n: { min: 0, max: 10 } }, { n: -0.0001 }).passed, false)
  assert.equal(run({ n: { min: 0, max: 10 } }, { n: 10.0001 }).passed, false)
})

test('a rejection names the field and the range, so a client can correct it', () => {
  const { rejected } = run({ price: { min: 0, max: 500 } }, { price: 900 })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.code, 'FIELD_OUT_OF_RANGE')
  assert.equal(rejected.field, 'price')
  assert.deepEqual([rejected.min, rejected.max], [0, 500])
  assert.match(rejected.error, /price must be between 0 and 500/)
})

test('only a number or a string that is entirely a number counts as one', () => {
  // Number() answers 1 for true, 0 for [] and '' and 18 for [18]. Every one of those
  // would have become a real, wrong value in a money column.
  for (const value of [true, false, [], [18], {}, 'eighteen', '18%', '1e', NaN, Infinity, -Infinity]) {
    const { passed, rejected } = run({ n: { min: 0, max: 100 } }, { n: value })
    assert.equal(passed, false, `${JSON.stringify(value)} was accepted as a number`)
    assert.equal(rejected.code, 'FIELD_NOT_A_NUMBER')
  }
  // …and the forms that genuinely are one, including what an <input> hands the client.
  for (const value of [18, 18.5, '18', ' 18 ', '1e2', '0']) {
    assert.equal(run({ n: { min: 0, max: 100 } }, { n: value }).passed, true, JSON.stringify(value))
  }
})

test('an integer bound rejects a fraction but says so differently from a range', () => {
  const { rejected } = run({ n: { min: 0, max: 100, integer: true } }, { n: 1.5 })
  assert.equal(rejected.code, 'FIELD_NOT_A_NUMBER')
  assert.match(rejected.error, /whole number/)
})

test('an absent, null or blank field is not a violation', () => {
  // '' is what a cleared filter input sends, and '  ' is what a sloppy client sends
  // for the same thing. Neither is a number the caller meant.
  for (const source of [{}, { n: null }, { n: undefined }, { n: '' }, { n: '   ' }, { other: -5 }]) {
    assert.equal(run({ n: NUM.PAISE }, source).passed, true, JSON.stringify(source))
  }
})

test('a source that is not a plain object is left to the route', () => {
  for (const source of [undefined, null, 'a string', [-5]]) {
    assert.equal(run({ n: NUM.PAISE }, source).passed, true, String(source))
  }
})

test('the query form reads req.query, not req.body', () => {
  assert.equal(run({ n: NUM.ID }, { n: 'abc' }, { from: 'query' }).passed, false)
  // A body field of the same name is not the one being guarded.
  const req = { query: {}, body: { n: 'abc' } }
  let passed = false
  boundedNumber({ n: NUM.ID }, { from: 'query' })(req, null, () => { passed = true })
  assert.equal(passed, true)
})

test('the named ranges say what kind of number they are', () => {
  // Paise are integers because the column is BIGINT, and capped at JS's safe-integer
  // limit because anything past it arrives from JSON already rounded.
  assert.equal(NUM.PAISE.max, Number.MAX_SAFE_INTEGER)
  assert.equal(NUM.PAISE.integer, true)
  assert.equal(NUM.PAISE.min, 0)
  // A floor goes below zero — B1/B2 parking — and a row id never does.
  assert.ok(NUM.FLOOR.min < 0)
  assert.equal(NUM.ID.min, 1)
  assert.deepEqual([NUM.PERCENT.min, NUM.PERCENT.max], [0, 100])
})

// --- Filters ---------------------------------------------------------------

// The bug this was written for: a price band that isn't a price used to 500. The
// count has to agree with the list, or a header could describe rows the list refused
// to fetch.
test('a non-numeric price band is a 400 on both the property list and its count', async () => {
  for (const path of ['/api/properties', '/api/properties/count']) {
    for (const qs of ['min_price=abc', 'max_price=abc', 'min_price=1e400', 'min_price=99999999999999999999999']) {
      const res = await authed('GET', `${path}?${qs}`)
      assert.equal(res.status, 400, `${path}?${qs}`)
      const body = await res.json()
      assert.match(body.field, /^(min|max)_price$/)
      assert.ok(['FIELD_NOT_A_NUMBER', 'FIELD_OUT_OF_RANGE'].includes(body.code), body.code)
    }
  }
})

test('a real price band still filters, and an empty one is not a filter at all', async () => {
  await authed('POST', '/api/properties', { title: 'Cheap 2BHK', price_paise: 5_000_000_00 })
  await authed('POST', '/api/properties', { title: 'Dear penthouse', price_paise: 9_000_000_00 })

  const band = await (await authed('GET', '/api/properties?min_price=800000000')).json()
  assert.deepEqual(band.map((p) => p.title), ['Dear penthouse'])

  // The Properties screen sends `min_price=` when the agent clears the band. That is
  // "no filter", not "a filter that failed to parse".
  const cleared = await authed('GET', '/api/properties?min_price=&max_price=')
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).length, 2)

  const counted = await (await authed('GET', '/api/properties/count?min_price=800000000')).json()
  assert.deepEqual(counted, { total: 1 })
})

test('a non-numeric lead filter is a 400 rather than a 500', async () => {
  for (const path of ['/api/followups?lead_id=abc', '/api/site-visits?lead_id=abc', '/api/commission-invoices?commission_id=abc']) {
    const res = await authed('GET', path)
    assert.equal(res.status, 400, path)
    assert.equal((await res.json()).code, 'FIELD_NOT_A_NUMBER')
  }
  // A row id is a positive int4, so zero and a fraction are out of range, not unparseable.
  const zero = await authed('GET', '/api/followups?lead_id=0')
  assert.equal(zero.status, 400)
  assert.equal((await zero.json()).code, 'FIELD_OUT_OF_RANGE')

  const real = await authed('GET', `/api/site-visits?lead_id=${leadId}`)
  assert.equal(real.status, 200)
})

// --- Posted numbers --------------------------------------------------------

test('a property cannot be listed at a negative price, size or floor', async () => {
  const cases = [
    [{ title: 'Neg price', price_paise: -5000 }, 'price_paise'],
    [{ title: 'Neg size', size_sqft: -900 }, 'size_sqft'],
    [{ title: 'Deep basement', floor: -99 }, 'floor'],
    [{ title: 'Too tall', total_floors: 5000 }, 'total_floors'],
    [{ title: 'Fractional paise', price_paise: 100.5 }, 'price_paise'],
    [{ title: 'Not a number', price_paise: 'lots' }, 'price_paise'],
  ]
  for (const [body, field] of cases) {
    const res = await authed('POST', '/api/properties', body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.equal((await res.json()).field, field)
  }
})

test('the same bounds hold on an edit, not just on the create', async () => {
  const created = await (await authed('POST', '/api/properties', { title: 'Honest 3BHK', price_paise: 12_000_000_00 })).json()
  const res = await authed('PUT', `/api/properties/${created.id}`, { price_paise: -1 })
  assert.equal(res.status, 400)

  const after = await (await authed('GET', `/api/properties/${created.id}`)).json()
  assert.equal(Number(after.price_paise), 12_000_000_00, 'the rejected edit changed nothing')
})

// A basement is a real floor, and a studio can be 249.5 sqft. The guard has to let
// the real values through or it has just moved the bug.
test('the legitimate awkward values are still accepted', async () => {
  const res = await authed('POST', '/api/properties', {
    title: 'B2 parking + studio', floor: -2, total_floors: 14, size_sqft: 249.5, price_paise: 0,
  })
  assert.equal(res.status, 200)
  const saved = await res.json()
  assert.equal(saved.floor, -2)
  assert.equal(saved.size_sqft, 249.5)
})

test('deal money is bounded, and the bound names the field that was wrong', async () => {
  const bad = await authed('POST', '/api/deals', { lead_id: leadId, deal_value_paise: -100 })
  assert.equal(bad.status, 400)
  assert.deepEqual(
    { field: (await bad.json()).field, code: 400 },
    { field: 'deal_value_paise', code: 400 },
  )

  const ok = await authed('POST', '/api/deals', { lead_id: leadId, deal_value_paise: 75_000_00_000 })
  assert.equal(ok.status, 200)
})

test('a lead budget is bounded, because the matcher compares every listing against it', async () => {
  const bad = await authed('PUT', `/api/leads/${leadId}`, { budget_min: -1 })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).field, 'budget_min')

  const ok = await authed('PUT', `/api/leads/${leadId}`, { budget_min: 50_000_00_000, budget_max: 80_000_00_000 })
  assert.equal(ok.status, 200)
  assert.equal(Number((await ok.json()).budget_min), 50_000_00_000)
})

test('a commission percentage is a percentage', async () => {
  // NUMERIC(5,2) overflowed at 5000 and answered with Postgres's own wording.
  const over = await authed('POST', '/api/commissions', { lead_id: leadId, commission_pct: 5000 })
  assert.equal(over.status, 400)
  const body = await over.json()
  assert.equal(body.field, 'commission_pct')
  assert.match(body.error, /between 0 and 100/)
  assert.doesNotMatch(body.error, /numeric field overflow/, 'the agent is told which field, not which column type')

  const ok = await authed('POST', '/api/commissions', { lead_id: leadId, commission_pct: 2.5, deal_value_paise: 90_000_00_000 })
  assert.equal(ok.status, 200)
})

// gst_rate is deliberately not bounded by this middleware — createCommissionInvoice
// owns it and answers with a more specific code. Asserted here so a later sweep that
// "completes" the guard by adding gst_rate to it fails loudly instead of quietly
// swapping the code out from under a client.
test('the invoice GST rate keeps its own, more specific rejection', async () => {
  const commission = await (await authed('GET', '/api/commissions')).json()
  const res = await authed('POST', `/api/commissions/${commission[0].id}/invoice`, { gst_rate: 900 })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'INVALID_GST_RATE')
})

test('the EMI calculator refuses a loan no bank would write', async () => {
  const absurd = await authed('POST', '/api/emi', { principal_l: 1e9, rate_pct: 1e6, years: 1e6 })
  assert.equal(absurd.status, 400)
  assert.equal((await absurd.json()).field, 'principal_l')

  for (const body of [{ principal_l: 80, rate_pct: 150 }, { principal_l: 80, years: 400 }]) {
    const res = await authed('POST', '/api/emi', body)
    assert.equal(res.status, 400, JSON.stringify(body))
  }

  // The ordinary question still answers.
  const real = await (await authed('POST', '/api/emi', { principal_l: 80, rate_pct: 8.5, years: 20 })).json()
  assert.match(real.message, /Monthly EMI/)

  // Free text is parsed rather than trusted, so it never reaches the numeric guard.
  const typed = await (await authed('POST', '/api/emi', { text: '80L at 8.5% for 20 years' })).json()
  assert.match(typed.message, /Monthly EMI/)
})

// The guard must not invent a requirement: a field nobody sent is the route's own
// business, and every one of these routes has its own answer for a missing id.
test('an absent number is left to the route that requires it', async () => {
  const res = await authed('POST', '/api/deals', {})
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /lead_id is required/)
})
