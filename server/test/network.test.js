// The broker network feed: GET /api/network, which is the only read in HomeNex that
// crosses tenants on purpose — every agent sees every posted listing, but the matches
// are computed against their own buyers alone.
//
// POST /api/network is covered by tenancy.test.js. What was never exercised is the
// read side: listNetworkPosts, and computeMatches — the locality/config/budget scorer
// whose 70-point threshold decides what an agent is shown.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('network')

const { app } = await import('../index.js')
const { closePool, query, upsertLead, addNetworkPost } = await import('../db.js')

let server, base
let alice, bob

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = (r) => r.json()
const signup = async (name, phone) =>
  json(await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' }))

// A qualified buyer: computeMatches only looks at leads with a locality that aren't Cold.
const buyer = async (agentId, waId, name, { locality, config, min, max, temp = 'Hot' }) => {
  const lead = await upsertLead(agentId, waId, name)
  await query(
    `UPDATE leads SET locality = $2, config = $3, budget_min_l = $4, budget_max_l = $5, temp = $6 WHERE id = $1`,
    [lead.id, locality, config, min, max, temp],
  )
  return lead
}

const feed = async (tok) => json(await req('GET', '/api/network', undefined, tok))
const pctFor = (matches, leadName, broker) =>
  matches.find((m) => m.lead.name === leadName && m.inventory.broker === broker)?.matchPct ?? null

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  alice = await signup('Alice Broker', '+919820000101')
  bob = await signup('Bob Broker', '+919820000202')

  await buyer(alice.agent.id, '919821000001', 'Powai Priya', {
    locality: 'Powai', config: '3BHK', min: 100, max: 150,
  })
  // Same profile but Cold, and one with no locality at all — both are skipped.
  await buyer(alice.agent.id, '919821000002', 'Cold Chetan', {
    locality: 'Powai', config: '3BHK', min: 100, max: 150, temp: 'Cold',
  })
  await buyer(alice.agent.id, '919821000003', 'Nomad Nita', {
    locality: null, config: '3BHK', min: 100, max: 150,
  })
  // A buyer whose budget is still unknown — the budget leg can't score for them.
  await buyer(alice.agent.id, '919821000004', 'Baner Bhavna', {
    locality: 'Baner', config: '2BHK', min: null, max: null,
  })

  // Inventory, scored against Priya as locality 45 + config 30 + budget 25.
  await addNetworkPost({ type: 'INVENTORY', broker: 'Perfect Pankaj', text: 'ready 3BHK',
    locality: 'Powai West', config: '3 BHK', budget_min_l: 110, budget_max_l: 140 }) // 100
  await addNetworkPost({ type: 'INVENTORY', broker: 'Borderline Bala', text: 'compact flat',
    locality: 'Powai', config: '2BHK', budget_min_l: 110, budget_max_l: 140 }) // 70 — exactly the cutoff
  await addNetworkPost({ type: 'INVENTORY', broker: 'Faraway Farid', text: 'same config, wrong side of town',
    locality: 'Andheri', config: '3BHK', budget_min_l: 110, budget_max_l: 140 }) // 55
  await addNetworkPost({ type: 'INVENTORY', broker: 'Vague Vikram', text: 'call for details',
    locality: 'Powai', config: null, budget_min_l: null, budget_max_l: null }) // 45
  await addNetworkPost({ type: 'INVENTORY', broker: 'Baner Builder', text: '2BHK in Baner',
    locality: 'Baner', config: '2BHK', budget_min_l: 50, budget_max_l: 80 }) // 75 for Bhavna
  // A requirement, not inventory — it must never be matched against.
  await addNetworkPost({ type: 'REQUIREMENT', broker: 'Wanted Wasim', text: 'looking for 3BHK Powai',
    locality: 'Powai', config: '3BHK', budget_min_l: 110, budget_max_l: 140 })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('the feed lists every posted ad, newest first', async () => {
  const { posts } = await feed(alice.token)
  assert.equal(posts.length, 6)
  assert.equal(posts[0].broker, 'Wanted Wasim', 'newest post leads the feed')
  assert.deepEqual(
    [...posts].map((p) => p.id).sort((a, b) => b - a),
    posts.map((p) => p.id),
    'strictly descending by id',
  )
})

test('a listing only surfaces once it clears 70 points, and the cutoff itself counts', async () => {
  const { matches } = await feed(alice.token)
  assert.equal(pctFor(matches, 'Powai Priya', 'Perfect Pankaj'), 100, 'locality + config + budget')
  assert.equal(pctFor(matches, 'Powai Priya', 'Borderline Bala'), 70, 'locality + budget is exactly enough')
  assert.equal(pctFor(matches, 'Powai Priya', 'Faraway Farid'), null, 'config + budget alone is 55 — not shown')
  assert.equal(pctFor(matches, 'Powai Priya', 'Vague Vikram'), null, 'locality alone is 45 — not shown')
})

test('locality matches either way round, and config ignores spacing', async () => {
  const { matches } = await feed(alice.token)
  // "Powai West" contains the lead's "Powai"; "3 BHK" and "3BHK" are the same config.
  const best = matches.find((m) => m.inventory.broker === 'Perfect Pankaj')
  assert.equal(best.lead.name, 'Powai Priya')
  assert.equal(best.inventory.locality, 'Powai West')
  assert.equal(best.inventory.config, '3 BHK')
})

test('a buyer with no budget yet can still match on locality and config', async () => {
  const { matches } = await feed(alice.token)
  assert.equal(pctFor(matches, 'Baner Bhavna', 'Baner Builder'), 75, 'the budget leg simply scores nothing')
})

test('cold buyers, locality-less buyers and requirement posts are left out', async () => {
  const { matches } = await feed(alice.token)
  assert.equal(matches.filter((m) => m.lead.name === 'Cold Chetan').length, 0)
  assert.equal(matches.filter((m) => m.lead.name === 'Nomad Nita').length, 0)
  assert.equal(matches.filter((m) => m.inventory.broker === 'Wanted Wasim').length, 0)
})

test('matches come back strongest first', async () => {
  const { matches } = await feed(alice.token)
  assert.deepEqual(matches.map((m) => m.matchPct), [100, 75, 70])
})

test('the board is shared but the matches are not', async () => {
  const { posts, matches } = await feed(bob.token)
  assert.equal(posts.length, 6, 'Bob sees every agent’s listings')
  assert.deepEqual(matches, [], 'but he has no buyers, so nothing is matched to him')
})

test('the feed requires a logged-in agent', async () => {
  assert.equal((await req('GET', '/api/network')).status, 401)
})

// --- The scorer now runs in SQL -------------------------------------------
//
// computeMatches used to pull every INVENTORY row into Node and score the cross
// product in JavaScript. That is the one unbounded read left over a table nobody's
// agent_id scopes, so it moved into a single statement. These are the places where
// SQL and JavaScript disagree by default, and where the rewrite therefore had to say
// what it meant rather than inherit it.

test('an empty-string locality or config scores nothing, the way JS truthiness did', async () => {
  // '' is NOT NULL, so a SQL rewrite that guarded with IS NOT NULL would happily
  // match every buyer against a listing whose locality was left blank — and
  // position('powai' in '') is 0 but position('' in 'powai') is 1, so the reverse
  // leg would have scored 45 for nothing at all.
  const blank = await signup('Blank Broker', '+919820000303')
  await buyer(blank.agent.id, '919821000101', 'Blank Bindu', {
    locality: 'Powai', config: '3BHK', min: 100, max: 150,
  })
  await addNetworkPost({ type: 'INVENTORY', broker: 'Empty Locality Eshan', text: 'no area given',
    locality: '', config: '3BHK', budget_min_l: 110, budget_max_l: 140 })

  const { matches } = await feed(blank.token)
  assert.equal(pctFor(matches, 'Blank Bindu', 'Empty Locality Eshan'), null, 'a blank locality scored the 45')
})

test('a buyer with a blank locality is skipped, not matched against everything', async () => {
  const blank = await signup('Blank Two', '+919820000304')
  await buyer(blank.agent.id, '919821000102', 'Blankest Bharat', {
    locality: '', config: '3BHK', min: 100, max: 150,
  })
  await addNetworkPost({ type: 'INVENTORY', broker: 'Somewhere Sameer', text: 'a flat',
    locality: 'Powai', config: '3BHK', budget_min_l: 110, budget_max_l: 140 })

  const { matches } = await feed(blank.token)
  assert.deepEqual(matches, [], 'a buyer with no area was matched anyway')
})

test('a buyer whose temperature was never set is left out, as before', async () => {
  // The original lead query said `temp != 'Cold'`, and SQL drops a NULL there. That
  // is load-bearing: it is why an unscored lead does not appear on the board.
  const unscored = await signup('Unscored Broker', '+919820000305')
  const lead = await buyer(unscored.agent.id, '919821000103', 'Unscored Uma', {
    locality: 'Powai', config: '3BHK', min: 100, max: 150,
  })
  await query('UPDATE leads SET temp = NULL WHERE id = $1', [lead.id])
  await addNetworkPost({ type: 'INVENTORY', broker: 'Powai Prakash', text: 'ready 3BHK',
    locality: 'Powai', config: '3BHK', budget_min_l: 110, budget_max_l: 140 })

  const { matches } = await feed(unscored.token)
  assert.deepEqual(matches, [], 'a lead with no temperature reached the board')
})

test('one buyer matching several listings is returned once per listing, hydrated fully', async () => {
  // The pairs come back as ids and the two sides are fetched by id, so a lead that
  // matches six listings is read once — but each pair must still carry the whole row.
  const many = await signup('Many Broker', '+919820000306')
  await buyer(many.agent.id, '919821000104', 'Popular Pooja', {
    locality: 'Kothrud', config: '2BHK', min: 60, max: 90,
  })
  for (const broker of ['Kothrud One', 'Kothrud Two', 'Kothrud Three']) {
    await addNetworkPost({ type: 'INVENTORY', broker, text: '2BHK', locality: 'Kothrud',
      config: '2BHK', budget_min_l: 70, budget_max_l: 85 })
  }

  const { matches } = await feed(many.token)
  assert.equal(matches.length, 3)
  for (const m of matches) {
    assert.equal(m.matchPct, 100)
    assert.equal(m.lead.name, 'Popular Pooja')
    assert.equal(m.lead.wa_id, '919821000104', 'the lead row came back partial')
    assert.ok(m.inventory.text, 'the listing row came back partial')
    assert.match(m.inventory.broker, /^Kothrud/)
  }
})

test('two matches on the same score keep a stable order between requests', async () => {
  // The JS sort left ties in whatever order two unordered SELECTs happened to
  // produce. Paging or diffing a feed that reshuffles itself is not possible.
  const stable = await signup('Stable Broker', '+919820000307')
  await buyer(stable.agent.id, '919821000105', 'Tied Tanvi', {
    locality: 'Wakad', config: '2BHK', min: 60, max: 90,
  })
  for (const broker of ['Tie A', 'Tie B', 'Tie C']) {
    await addNetworkPost({ type: 'INVENTORY', broker, text: '2BHK', locality: 'Wakad',
      config: '2BHK', budget_min_l: 70, budget_max_l: 85 })
  }

  const first = (await feed(stable.token)).matches.map((m) => m.inventory.broker)
  const second = (await feed(stable.token)).matches.map((m) => m.inventory.broker)
  assert.deepEqual(first, second, 'the same feed came back in a different order')
  assert.deepEqual(first, ['Tie A', 'Tie B', 'Tie C'], 'ties should fall back to insertion order')
})

test('a board with no inventory at all is an empty list, not an error', async () => {
  const empty = await signup('Empty Broker', '+919820000308')
  const { matches } = await feed(empty.token)
  assert.deepEqual(matches, [])
})
