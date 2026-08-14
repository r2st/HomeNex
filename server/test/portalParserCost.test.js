// What a portal notification email costs to parse, when the sender is not a portal.
//
// TEXT.EMAIL_PART bounds the body at 512KB because a *benign* 1MB of HTML measured
// 41ms and half a megabyte therefore looked like ~15ms of work. That number came from
// benign input, and every regex in parsePortalEmail was quadratic on input chosen to
// make it so. At the bound the guard already permits:
//
//   `<script` repeated              53,680ms
//   `<style ` repeated              51,766ms
//   a run of local-part characters 166,013ms
//   a run of `<`                   ~124,000ms (31s measured at a quarter the size)
//
// All of it synchronous, all of it on the single event loop, on a route that needs no
// login. The ingest token is not a secret in any useful sense either — it is the local
// part of `lead-<token>@leads.homenex.in`, which is exactly the address agents publish
// on their 99acres and MagicBricks listings so the portals can mail them. One POST
// stopped the process for the better part of a minute; ingestLimiter allows 240 a
// minute.
//
// The fix is the patterns, not a smaller bound — see leadSources.js. These tests state
// both halves of that: the cost curve is flat now, and the parser still reads the same
// emails the same way.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_PHONE_NUMBER_ID
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('parsercost')

const { app } = await import('../index.js')
const { ready, closePool, query } = await import('../db.js')
const { parsePortalEmail } = await import('../leadSources.js')

await ready

let server, base, token, ingestToken

// The first call through the chain compiles ten regexes and the per-label RegExp the
// matcher builds, which on a cold process costs more than any of the parses below. A
// server that is being attacked has parsed email before, so the steady-state number is
// the one these tests are about; measuring the compile would only add noise to a
// threshold that has 25x of headroom to spend on something real.
const warm = () => parsePortalEmail({ html: '<p>Name: Warm Up</p><p>Mobile: 9876500001</p>', text: '' })

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

before(async () => {
  warm()
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  const out = await (await req('POST', '/api/auth/signup', {
    name: 'Parser Parul',
    phone: '+919877600001',
    password: 'secret123',
  }, null)).json()
  token = out.token
  ingestToken = (await query('SELECT ingest_token FROM agents WHERE id = $1', [out.agent.id])).rows[0].ingest_token
})

after(async () => {
  server?.close()
  await new Promise((r) => setTimeout(r, 150))
  await closePool()
  await dropTestDb(dbName)
})

// The bound the public route actually allows through to the parser.
const CAP = 512_000

// Every pathological body still ends in a real phone number, so a parser that bails
// early for some unrelated reason cannot pass these by doing no work at all.
const TAIL = ' Mobile: 9876500021'
const fill = (unit, tail = TAIL) => unit.repeat(Math.ceil((CAP - tail.length) / unit.length)).slice(0, CAP - tail.length) + tail

// Each of these took between 50 and 166 SECONDS before the fix. The ceiling is ~25x
// what the linear forms measure, so this fails on a regression and not on a busy
// machine — and it is still three orders of magnitude below what it is guarding.
const BUDGET_MS = 400

const costOf = (email) => {
  const started = process.hrtime.bigint()
  const parsed = parsePortalEmail(email)
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, parsed }
}

// --- The three quadratic passes ----------------------------------------------

test('a body of unterminated <script> opens is parsed in linear time', () => {
  // `<(script|style)[\s\S]*?<\/\1>` rescanned to the end of the document from every
  // one of the ~73,000 opening tags, because none of them has a closing tag to stop
  // at. 53.7 seconds.
  const { ms, parsed } = costOf({ html: fill('<script') })
  assert.ok(ms < BUDGET_MS, `512KB of unterminated <script> took ${ms.toFixed(0)}ms to parse`)
  assert.equal(parsed, null, 'everything after an unterminated <script> is inside it, phone included')
})

test('a body of unterminated <style> opens is parsed in linear time', () => {
  // Same pattern, the other alternative — and the backreference means the engine is
  // hunting `</style>` rather than `</script>`, so it needs its own case.
  const { ms, parsed } = costOf({ html: fill('<style ') })
  assert.ok(ms < BUDGET_MS, `512KB of unterminated <style> took ${ms.toFixed(0)}ms to parse`)
  assert.equal(parsed, null)
})

test('a body of unclosed < is parsed in linear time', () => {
  // `<[^>]+>` let the class run to the end of the document looking for a `>` that is
  // not there, then backtrack a character at a time — from every `<`. 31s at a
  // quarter of this size.
  const { ms, parsed } = costOf({ html: fill('<') })
  assert.ok(ms < BUDGET_MS, `512KB of unclosed < took ${ms.toFixed(0)}ms to parse`)
  assert.equal(parsed?.phone, '9876500021', 'a `<` run is not a tag, so the text after it survives')
})

test('a long run of local-part characters is scanned for an address in linear time', () => {
  // The worst of the four: `[a-z0-9._%+\-]+@` retried from every offset inside the
  // run, each attempt consuming to the end before concluding there is no `@`. 166
  // seconds — nearly three minutes of one unauthenticated POST.
  const { ms, parsed } = costOf({ text: fill('a') })
  assert.ok(ms < BUDGET_MS, `512KB of local-part characters took ${ms.toFixed(0)}ms to parse`)
  assert.equal(parsed.phone, '9876500021')
  assert.equal(parsed.email, null, 'a run with no @ in it is not an address')
})

test('a long local part terminated by @ but never completed is linear too', () => {
  // The half-way shape: the `@` the local part was hunting for exists, so the scan
  // gets past it and into the domain, which then never reaches a TLD.
  const { ms, parsed } = costOf({ text: fill('a'.repeat(70) + '@' + 'b'.repeat(70)) })
  assert.ok(ms < BUDGET_MS, `512KB of a@b with no TLD took ${ms.toFixed(0)}ms to parse`)
  assert.equal(parsed.email, null)
})

test('the cost curve is flat, not quadratic', () => {
  // The constant is a machine's business; the curve is the bug. Quadratic growth
  // shows up as 4x per doubling, which is what every one of the four used to do.
  // Anything under 2.5x here is linear enough to be safe at any bound we allow.
  const at = (n) => {
    const body = '<'.repeat(n)
    const started = process.hrtime.bigint()
    parsePortalEmail({ html: body, text: 'a'.repeat(n) })
    return Number(process.hrtime.bigint() - started) / 1e6
  }
  at(20_000) // a sample at the same shape, so the first real one isn't the slow one
  const small = at(100_000)
  const large = at(400_000)
  // Guard against a sub-millisecond denominator turning noise into a ratio.
  const ratio = large / Math.max(small, 0.5)
  assert.ok(ratio < 2.5 * 4, `4x the input cost ${ratio.toFixed(1)}x the time — the parser is backtracking again`)
})

// --- The parser still reads real portal email ---------------------------------

test('script and style blocks are still dropped, contents and all', () => {
  // The reason the pass exists: a tracking script or a stylesheet inlined by the
  // portal must not contribute text the label matcher can mistake for a lead.
  const parsed = parsePortalEmail({
    html: `<style>.x { content: "Mobile: 9999999999" }</style>
      <p>Name: Scripted Sneha</p>
      <script type="text/javascript">var phone = "Mobile: 8888888888";</script>
      <p>Mobile: 9876500022</p>`,
  })
  assert.equal(parsed.name, 'Scripted Sneha')
  assert.equal(parsed.phone, '9876500022', 'the number inside the blocks is not the lead')
})

test('a closing tag with attributes or spacing still ends the block', () => {
  const parsed = parsePortalEmail({
    html: '<script src="x.js" >ignored</script  >\n<p>Mobile: 9876500023</p>',
  })
  assert.equal(parsed.phone, '9876500023')
})

test('a tag whose attribute value holds a < ends where the < starts', () => {
  // `[^<>]` instead of `[^>]` is what makes the tag stripper linear, and it also
  // makes it agree with a browser: the second `<` opens a new tag rather than
  // living inside the first.
  const parsed = parsePortalEmail({ html: '<p title="a<b">Mobile: 9876500024</p>' })
  assert.equal(parsed.phone, '9876500024')
})

test('an address is still recovered from an ordinary body', () => {
  const parsed = parsePortalEmail({
    from: 'noreply@magicbricks.com',
    subject: 'New enquiry',
    text: 'Name: Emailed Esha\nMobile: 9876500025\nWrite back at esha.k+leads@example.co.in today',
  })
  assert.equal(parsed.portal, 'magicbricks')
  assert.equal(parsed.email, 'esha.k+leads@example.co.in')
})

test('a labelled address wins over one further down the body', () => {
  const parsed = parsePortalEmail({
    text: 'Name: Labelled Lata\nEmail: lata@example.com\nMobile: 9876500026\nSent by noreply@99acres.com',
  })
  assert.equal(parsed.email, 'lata@example.com')
})

test('an address glued to the end of a word is not half-read', () => {
  // The boundary rule that makes the scan linear also decides where a candidate may
  // begin. `contact-us:priya@example.com` starts at `priya`, because `:` cannot be
  // part of a local part — but `xxxpriya@example.com` is one unbroken run and is
  // read whole, exactly as it was before.
  assert.equal(parsePortalEmail({ text: 'Mobile: 9876500027\nreply to: priya@example.com' }).email, 'priya@example.com')
  assert.equal(parsePortalEmail({ text: 'Mobile: 9876500027\nxxxpriya@example.com' }).email, 'xxxpriya@example.com')
})

// --- Through the public route -------------------------------------------------

test('the public ingest route answers a pathological body instead of disappearing into it', async () => {
  // The end-to-end statement. This body is inside the bound, so nothing rejects it —
  // it is parsed, in full, and the route still has to answer promptly.
  const started = Date.now()
  const res = await req('POST', `/ingest/email/${ingestToken}`, {
    from: 'noreply@99acres.com',
    subject: 'New response for your property',
    html: fill('<script', ' <p>Name: Survivor Sana</p><p>Mobile: 9876500028</p>'),
    text: fill('a', ' Mobile: 9876500028'),
  })
  const ms = Date.now() - started
  assert.equal(res.status, 200)
  assert.ok(ms < 2000, `one 512KB ingest POST held the server for ${ms}ms`)

  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.lead_id != null, true)
})

test('the server is still answering other requests after that body', async () => {
  // The point of the whole exercise: /healthz is what a load balancer asks, and a
  // blocked event loop is what used to stop it answering.
  const res = await req('GET', '/healthz', undefined, null)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})
