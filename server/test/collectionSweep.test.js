// A sweep over every authenticated LIST route — the ones with no id in the path.
//
// tenantSweep.test.js does this for routes that take a resource id, and it walks the
// real router so a new one cannot be added without being covered. The list routes had
// no such guard: six URLs were named by hand in routeGuards.test.js, out of forty that
// exist. The asymmetry is backwards. A missing `agent_id` in a `GET /api/leads/:id`
// leaks one row to someone who already guessed its id; the same omission in
// `GET /api/leads` hands over the whole table to anybody with an account.
//
// So: Alice creates one of everything, each carrying a string that appears nowhere
// else. Bob — a fully authenticated agent of the same rank, with no data of his own —
// then calls every list route the router actually has, and none of Alice's strings may
// come back. Adding a list route without a tenant check makes this file fail.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('collectionsweep')

const { app } = await import('../index.js')
const { closePool, addContact, createNotification, createCommissionInvoice } = await import('../db.js')

let server, base
const alice = {}
const bob = {}

// Strings that exist only in Alice's rows. If one appears in a response to Bob,
// something leaked whatever the status code said.
const SECRETS = [
  'Alices Secret Tower',
  'Alice Private Buyer',
  'alice-confidential-note',
  'Alice Group Alpha',
  'Alice Label Alpha',
  'Alice Template Alpha',
  'Alice Snippet Alpha',
  'Alice Media Alpha',
  'Alice Ticket Alpha',
  'Alice Festive Alpha',
  'Alice Builder',
]

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const asAlice = (m, u, b) => req(m, u, b, alice.token)
const asBob = (m, u, b) => req(m, u, b, bob.token)

async function signup(into, name, phone) {
  const out = await (await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' })).json()
  into.token = out.token
  into.agentId = out.agent.id
}

// Create one of everything, owned by Alice. Deliberately the same fixture as
// tenantSweep: the two files are the same question asked of the two halves of the API.
async function seedAlice() {
  const post = async (url, body) => {
    const res = await asAlice('POST', url, body)
    const out = await res.json().catch(() => null)
    assert.equal(res.status, 200, `seeding ${url} failed: ${JSON.stringify(out)}`)
    return out
  }

  const sim = await post('/api/simulate', { from: '919788000901', text: 'Need a 3BHK in Baner' })
  alice.leadId = sim.lead.id
  await asAlice('PUT', `/api/leads/${alice.leadId}`, { name: 'Alice Private Buyer' })

  alice.propertyId = (await post('/api/properties', {
    title: 'Alices Secret Tower', locality: 'Baner', city: 'Pune', price_paise: 9_00_00_000,
  })).id

  await post(`/api/leads/${alice.leadId}/notes`, { body: 'alice-confidential-note' })
  await post('/api/groups', { name: 'Alice Group Alpha' })
  await post('/api/labels', { name: 'Alice Label Alpha', color: '#123456' })
  await post('/api/templates', { name: 'Alice Template Alpha', body: 'Hello {{name}}', category: 'utility' })
  await post('/api/quick-replies', { title: 'Alice Snippet Alpha', body: 'On my way' })
  await post('/api/media', { title: 'Alice Media Alpha', kind: 'photo', storage: 'url', url: 'https://example.com/a.jpg' })
  await post('/api/support/tickets', { subject: 'Alice Ticket Alpha', body: 'help please' })
  await post('/api/templates/festive/send', {
    festival: 'ganesh_chaturthi',
    message: 'Alice Festive Alpha',
    send_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  })
  await post('/api/followups', { lead_id: alice.leadId, due_at: new Date(Date.now() + 86400_000).toISOString(), note: 'call back' })
  await post('/api/site-visits', { lead_id: alice.leadId, property_id: alice.propertyId, scheduled_at: new Date(Date.now() + 86400_000).toISOString() })
  const deal = await post('/api/deals', {
    lead_id: alice.leadId, property_id: alice.propertyId, deal_type: 'sale',
    builder_name: 'Alice Builder', deal_value_paise: 5_00_00_000,
  })
  const commission = await post('/api/commissions', {
    lead_id: alice.leadId, deal_id: deal.id, deal_value_paise: 5_00_00_000, commission_pct: 2,
  })

  // Rows the API has no create route for.
  await addContact(alice.agentId, '+919788000902', 'Alice Private Buyer')
  await createNotification(alice.agentId, { type: 'lead', title: 'Alice Private Buyer went quiet' })
  await createCommissionInvoice(alice.agentId, commission.id, {})
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  await signup(alice, 'Alice Owner', '+919800000811')
  await signup(bob, 'Bob Outsider', '+919800000812')
  await seedAlice()
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// Every GET route under /api with no `:param`, discovered from the router rather than
// listed here — the whole point is that nobody has to remember to update a list.
function listRoutes() {
  const found = []
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        const path = `${prefix}${layer.route.path}`
        if (layer.route.methods.get && !path.includes(':')) found.push(path)
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(
          layer.handle.stack,
          String(layer.regexp)
            .replace(/^\/\^/, '')
            .replace(/\\\/\?\(\?=\\\/\|\$\)\/i$/, '')
            .replace(/\\\//g, '/'),
        )
      }
    }
  }
  walk(app._router.stack)
  return found.filter((p) => p.startsWith('/api/')).sort()
}

// Routes that are not a tenant boundary, each for a stated reason. Anything not named
// here must isolate Alice from Bob.
const SHARED_BY_DESIGN = {
  '/api/health': 'liveness; unauthenticated on purpose',
  '/api/auth/me': 'returns the caller, so Bob getting Bob is the correct answer',
  // network_posts has no agent_id column at all: the broker network is the one thing
  // in HomeNex every agent on the platform is meant to read.
  '/api/network': 'the shared broker network, readable platform-wide by design',
  // pipeline_stages likewise has no agent_id — it is a fixed catalogue of stage names.
  '/api/pipeline-stages': 'the global stage catalogue, identical for every agent',
}
// /api/admin/* is gated on is_admin and a platform admin is meant to see every agent;
// adminPortal/adminTeam cover who may enter it, which is the boundary that exists there.
const ADMIN = /^\/api\/admin\//

test('the router walk finds the list routes, so an empty sweep cannot pass silently', () => {
  const routes = listRoutes()
  assert.ok(routes.length >= 35, `the walk found only ${routes.length} list routes — it has stopped working`)
  for (const expected of ['/api/leads', '/api/contacts', '/api/properties', '/api/team/leads']) {
    assert.ok(routes.includes(expected), `${expected} missing from the walk`)
  }
})

test('no list route hands Alice’s rows to Bob', async () => {
  const leaked = []
  const checked = []
  for (const path of listRoutes()) {
    if (SHARED_BY_DESIGN[path] || ADMIN.test(path)) continue
    checked.push(path)
    const res = await asBob('GET', path)
    // A 4xx is fine — Bob has no team, so the team routes may refuse him outright.
    // What matters is that a 200 contains nothing of Alice's.
    const body = await res.text()
    for (const secret of SECRETS) {
      if (body.includes(secret)) leaked.push(`${path} → ${res.status} leaked "${secret}"`)
    }
    assert.ok(res.status < 500, `${path} answered ${res.status}: ${body.slice(0, 200)}`)
  }
  assert.ok(checked.length >= 30, `only ${checked.length} routes were actually swept`)
  assert.deepEqual(leaked, [], `these list routes are not scoped to the caller:\n${leaked.join('\n')}`)
})

test('the same sweep, with the filters a client actually sends', async () => {
  // A route can be scoped in its bare form and unscoped once a filter is applied — the
  // WHERE is rebuilt per query, and the `$n` numbering shifts as each clause appends.
  // These are the query strings the app sends, aimed at Alice's data.
  const leaked = []
  const withQuery = [
    `/api/leads?q=Alice Private Buyer`,
    `/api/leads?limit=500&offset=0`,
    `/api/leads/count`,
    `/api/contacts?q=Alice Private Buyer`,
    `/api/contacts?limit=500`,
    `/api/contacts/count?q=Alice Private Buyer`,
    `/api/properties?q=Alices Secret Tower`,
    `/api/properties?city=Pune`,
    `/api/site-visits?lead_id=${alice.leadId}`,
    `/api/followups?lead_id=${alice.leadId}`,
    `/api/deals?lead_id=${alice.leadId}`,
    `/api/commissions?lead_id=${alice.leadId}`,
    `/api/activity?lead_id=${alice.leadId}`,
    `/api/media?kind=photo`,
    `/api/templates?category=utility`,
    `/api/notifications?unread=1`,
    `/api/pipeline/analytics?pipeline_type=buy_primary`,
    `/api/lead-sources?channel=whatsapp`,
  ]
  for (const url of withQuery) {
    const res = await asBob('GET', url)
    const body = await res.text()
    assert.ok(res.status < 500, `${url} answered ${res.status}: ${body.slice(0, 200)}`)
    for (const secret of SECRETS) {
      if (body.includes(secret)) leaked.push(`${url} → ${res.status} leaked "${secret}"`)
    }
  }
  assert.deepEqual(leaked, [], `these filtered list routes leak across the boundary:\n${leaked.join('\n')}`)
})

// A lead note is reachable only through GET /api/leads/:id/notes, so no list route
// could surface it however badly scoped they were. It stays in SECRETS — if a note
// ever does start appearing in a list, it must still be Bob-proof — but it cannot be
// required to show up in the reachability check below. tenantSweep owns that route.
const NOT_ON_ANY_LIST = ['alice-confidential-note']

test('Alice can still see her own rows — the sweep is not passing because everything is empty', async () => {
  // Without this, deleting every route's body would make the two tests above pass:
  // a sweep for strings that leak proves nothing until the strings are known to be
  // somewhere for a broken route to leak.
  const found = new Set()
  for (const path of listRoutes()) {
    if (path === '/api/health' || ADMIN.test(path)) continue
    const body = await (await asAlice('GET', path)).text()
    for (const secret of SECRETS) if (body.includes(secret)) found.add(secret)
  }
  assert.deepEqual(
    SECRETS.filter((s) => !found.has(s) && !NOT_ON_ANY_LIST.includes(s)),
    [],
    'these seeded strings appear on no list route, so the sweep never had a chance to catch them leaking',
  )
})

test('every list route rejects an anonymous, forged or garbage token', async () => {
  // The hand-written version of this named six URLs. This one asks the router.
  const wrong = []
  for (const path of listRoutes()) {
    if (path === '/api/health' || ADMIN.test(path)) continue
    for (const [label, tok] of [
      ['anonymous', null],
      ['garbage', 'garbage'],
      ['forged signature', `${bob.token?.split('.')[0]}.deadbeef`],
    ]) {
      const res = await req('GET', path, undefined, tok)
      if (res.status !== 401) wrong.push(`${path} (${label}) → ${res.status}`)
    }
  }
  assert.deepEqual(wrong, [], `these list routes answered something other than 401:\n${wrong.join('\n')}`)
})
