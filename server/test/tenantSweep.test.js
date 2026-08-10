// A sweep over EVERY authenticated route that takes a resource id in its path.
//
// tenancy.test.js and crossTenantRefs.test.js each prove isolation for a hand-picked
// set of routes — the ones somebody thought to check. That leaves the actual risk
// unaddressed: these ids are sequential integers, there are ~50 such routes, and a
// single one written without `agent_id` in its WHERE clause is a whole-workspace
// leak. The gap is not "is this route scoped" but "which routes has nobody looked at".
//
// So this file enumerates them. Alice creates one of every resource; Bob — a fully
// authenticated agent of the same rank, not an anonymous caller — then aims each
// route at Alice's id. Every one must answer 404/403, and no response body may
// contain any of Alice's identifying strings.
//
// Adding a route with an :id and no tenant check makes this file fail. That is the
// point: the check is a list nobody has to remember to update by hand, because the
// route table below is compared against the app's real router at the end.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('tenantsweep')

const { app } = await import('../index.js')
const { closePool, addContact, createNotification, createCommissionInvoice } = await import('../db.js')

let server, base
const alice = {}
const bob = {}

// Strings that only ever appear in Alice's rows. If one of these turns up in a
// response to Bob, something leaked regardless of the status code.
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
]

const req = (method, url, body, tok) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const asAlice = (m, u, b) => req(m, u, b, alice.token)
const asBob = (m, u, b) => req(m, u, b, bob.token)
const jsonOf = async (r) => {
  try {
    return await r.json()
  } catch {
    return null
  }
}

async function signup(into, name, phone) {
  const out = await (await req('POST', '/api/auth/signup', { name, phone, password: 'secret123' })).json()
  into.token = out.token
  into.agentId = out.agent.id
}

// Create one of everything, owned by Alice.
async function seedAlice() {
  const post = async (url, body) => {
    const res = await asAlice('POST', url, body)
    const out = await jsonOf(res)
    assert.equal(res.status, 200, `seeding ${url} failed: ${JSON.stringify(out)}`)
    return out
  }

  const sim = await post('/api/simulate', { from: '919777000901', text: 'Need a 3BHK in Baner' })
  alice.leadId = sim.lead.id
  await asAlice('PUT', `/api/leads/${alice.leadId}`, { name: 'Alice Private Buyer' })

  alice.propertyId = (await post('/api/properties', {
    title: 'Alices Secret Tower', locality: 'Baner', city: 'Pune', price_paise: 9_00_00_000,
  })).id

  alice.noteId = (await post(`/api/leads/${alice.leadId}/notes`, { body: 'alice-confidential-note' })).id
  alice.groupId = (await post('/api/groups', { name: 'Alice Group Alpha' })).id
  alice.labelId = (await post('/api/labels', { name: 'Alice Label Alpha', color: '#123456' })).id
  alice.templateId = (await post('/api/templates', { name: 'Alice Template Alpha', body: 'Hello {{name}}', category: 'utility' })).id
  alice.quickReplyId = (await post('/api/quick-replies', { title: 'Alice Snippet Alpha', body: 'On my way' })).id
  alice.mediaId = (await post('/api/media', { title: 'Alice Media Alpha', kind: 'photo', storage: 'url', url: 'https://example.com/a.jpg' })).id
  alice.ticketId = (await post('/api/support/tickets', { subject: 'Alice Ticket Alpha', body: 'help please' })).id
  alice.festiveId = (await post('/api/templates/festive/send', {
    festival: 'ganesh_chaturthi',
    message: 'Alice Festive Alpha',
    send_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  })).schedule.id
  alice.followupId = (await post('/api/followups', { lead_id: alice.leadId, due_at: new Date(Date.now() + 86400_000).toISOString(), note: 'call back' })).id
  alice.visitId = (await post('/api/site-visits', { lead_id: alice.leadId, property_id: alice.propertyId, scheduled_at: new Date(Date.now() + 86400_000).toISOString() })).id
  alice.dealId = (await post('/api/deals', { lead_id: alice.leadId, property_id: alice.propertyId, deal_type: 'sale', builder_name: 'Alice Builder', deal_value_paise: 5_00_00_000 })).id
  alice.commissionId = (await post('/api/commissions', { lead_id: alice.leadId, deal_id: alice.dealId, deal_value_paise: 5_00_00_000, commission_pct: 2 })).id

  // Three rows the API has no create route for (contacts are auto-captured from
  // inbound WhatsApp, notifications are raised by the scheduler, and an invoice is
  // raised from a commission).
  alice.contactId = (await addContact(alice.agentId, '+919777000902', 'Alice Private Buyer')).id
  alice.notificationId = (await createNotification(alice.agentId, { type: 'lead', title: 'Alice Private Buyer went quiet' })).id
  alice.invoiceId = (await createCommissionInvoice(alice.agentId, alice.commissionId, {})).id
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
  await signup(alice, 'Alice Owner', '+919800000801')
  await signup(bob, 'Bob Outsider', '+919800000802')
  await seedAlice()
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// Every authenticated route that takes a resource id, with the body it needs to get
// past validation and reach the tenant check — a body that 400s on its way there
// would prove nothing about tenancy. `id` is resolved lazily because the seed runs
// in before().
//
// A fourth element overrides the accepted rejection statuses for the handful of
// routes that answer something other than 403/404.
const ROUTES = () => [
  // Leads and everything hanging off one
  ['GET', `/api/leads/${alice.leadId}`],
  ['PUT', `/api/leads/${alice.leadId}`, { name: 'hacked' }],
  ['GET', `/api/leads/${alice.leadId}/notes`],
  ['POST', `/api/leads/${alice.leadId}/notes`, { body: 'intruder note' }],
  ['DELETE', `/api/leads/${alice.leadId}/notes/${alice.noteId}`],
  ['GET', `/api/leads/${alice.leadId}/autofill`],
  ['GET', `/api/leads/${alice.leadId}/briefing`],
  ['GET', `/api/leads/${alice.leadId}/suggestions`],
  ['GET', `/api/leads/${alice.leadId}/property-matches`],
  ['POST', `/api/leads/${alice.leadId}/ai`, { enabled: false }],
  ['POST', `/api/leads/${alice.leadId}/read`, {}],
  ['POST', `/api/leads/${alice.leadId}/reply`, { text: 'intruder reply' }],
  ['POST', `/api/leads/${alice.leadId}/autofill/apply`, { accepted: { name: 'hacked' } }],
  ['PUT', `/api/leads/${alice.leadId}/stage`, { stage: 'Lost', lost_reason: 'sabotage' }],
  ['PUT', `/api/leads/${alice.leadId}/labels/${alice.labelId}`, { on: true }],
  ['POST', `/api/leads/${alice.leadId}/assign-to`, { agent_id: 0 }],

  // Properties
  ['GET', `/api/properties/${alice.propertyId}`],
  ['PUT', `/api/properties/${alice.propertyId}`, { title: 'hacked' }],
  ['DELETE', `/api/properties/${alice.propertyId}`],
  ['GET', `/api/properties/${alice.propertyId}/analytics`],
  ['GET', `/api/properties/${alice.propertyId}/syndications`],
  ['POST', `/api/properties/${alice.propertyId}/micro-page`, {}],
  ['POST', `/api/properties/${alice.propertyId}/syndicate`, { portal: 'housing' }],

  // CRM
  ['GET', `/api/contacts/${alice.contactId}`],
  ['PUT', `/api/contacts/${alice.contactId}`, { notes: 'hacked' }],
  ['DELETE', `/api/contacts/${alice.contactId}`],
  ['GET', `/api/groups/${alice.groupId}/members`],
  ['PUT', `/api/groups/${alice.groupId}`, { name: 'hacked' }],
  ['DELETE', `/api/groups/${alice.groupId}`],
  // Correctly scoped, but reports "not yours" as a 400 rather than a 404 — the
  // route can't tell a foreign group from a dynamic one, so it says both at once.
  ['POST', `/api/groups/${alice.groupId}/members`, { contact_ids: [] }, [400]],
  ['DELETE', `/api/groups/${alice.groupId}/members/${alice.contactId}`],
  ['DELETE', `/api/labels/${alice.labelId}`],

  // Pipeline work
  ['PUT', `/api/followups/${alice.followupId}`, { completed: true }],
  ['PUT', `/api/site-visits/${alice.visitId}`, { status: 'completed' }],
  ['GET', `/api/deals/${alice.dealId}`],
  ['PUT', `/api/deals/${alice.dealId}`, { notes: 'hacked' }],
  ['PUT', `/api/commissions/${alice.commissionId}`, { notes: 'hacked' }],
  ['POST', `/api/commissions/${alice.commissionId}/invoice`, {}],
  ['PUT', `/api/commission-invoices/${alice.invoiceId}`, { status: 'paid' }],

  // Content
  ['PUT', `/api/templates/${alice.templateId}`, { name: 'hacked' }],
  ['DELETE', `/api/templates/${alice.templateId}`],
  ['POST', `/api/templates/${alice.templateId}/request-review`, {}],
  ['PUT', `/api/quick-replies/${alice.quickReplyId}`, { title: 'hacked' }],
  ['DELETE', `/api/quick-replies/${alice.quickReplyId}`],
  ['DELETE', `/api/media/${alice.mediaId}`],
  ['DELETE', `/api/templates/festive/${alice.festiveId}`],

  // Support, billing, notifications
  ['GET', `/api/support/tickets/${alice.ticketId}`],
  ['POST', `/api/support/tickets/${alice.ticketId}/reply`, { body: 'intruder reply' }],
  ['GET', `/api/billing/invoices/${alice.invoiceId}`],
  ['PUT', `/api/notifications/${alice.notificationId}/read`, {}],
]

test("Bob cannot reach any of Alice's resources by id", async () => {
  const leaks = []
  for (const [method, url, body, expected = [403, 404]] of ROUTES()) {
    const res = await asBob(method, url, body)
    const text = await res.text()
    if (!expected.includes(res.status)) {
      leaks.push(`${method} ${url} -> ${res.status} (expected ${expected.join('/')}) ${text.slice(0, 140)}`)
      continue
    }
    const found = SECRETS.filter((s) => text.includes(s))
    if (found.length) leaks.push(`${method} ${url} -> ${res.status} but leaked ${found.join(', ')}`)
  }
  assert.deepEqual(leaks, [], `cross-tenant access on ${leaks.length} route(s):\n${leaks.join('\n')}`)
})

// The same route table, aimed at ids that aren't ids at all. These reach Postgres as
// `WHERE id = 'not-an-id'`, which raises 22P02 (invalid text representation) — a
// client mistake that must come back as a 4xx. A 500 here is both a lie about whose
// fault it is and a free signal to anyone probing the API for unguarded routes.
test('a non-numeric id is a client error on every id-bearing route, never a 500', async () => {
  const crashes = []
  for (const [method, url, body] of ROUTES()) {
    // Replace only the id segments — the ones the sweep filled in from Alice's rows.
    const garbled = url
      .split('/')
      .map((seg) => (/^\d+$/.test(seg) ? 'not-an-id' : seg))
      .join('/')
    const res = await asBob(method, garbled, body)
    if (res.status >= 500) crashes.push(`${method} ${garbled} -> ${res.status} ${(await res.text()).slice(0, 120)}`)
  }
  assert.deepEqual(crashes, [], `${crashes.length} route(s) crashed on a malformed id:\n${crashes.join('\n')}`)
})

// A rejected write must be a no-op, not a rejected response over a completed write.
// Checking the status alone would miss a route that mutates first and 404s after.
test("Bob's rejected writes leave Alice's rows exactly as they were", async () => {
  const lead = await jsonOf(await asAlice('GET', `/api/leads/${alice.leadId}`))
  assert.equal(lead.name, 'Alice Private Buyer', 'the lead was renamed by a rejected write')
  assert.notEqual(lead.stage, 'Lost', 'the lead was moved by a rejected stage change')

  const property = await jsonOf(await asAlice('GET', `/api/properties/${alice.propertyId}`))
  assert.equal(property.title, 'Alices Secret Tower', 'the property survived but was renamed')

  const notes = await jsonOf(await asAlice('GET', `/api/leads/${alice.leadId}/notes`))
  assert.equal(notes.length, 1, "Bob added or deleted one of Alice's notes")
  assert.equal(notes[0].body, 'alice-confidential-note')

  const contact = await jsonOf(await asAlice('GET', `/api/contacts/${alice.contactId}`))
  assert.ok(contact?.id, 'the contact was deleted by a rejected DELETE')

  const templates = await jsonOf(await asAlice('GET', '/api/templates'))
  assert.ok(templates.some((t) => t.name === 'Alice Template Alpha'), 'the template was renamed or deleted')

  const snippets = await jsonOf(await asAlice('GET', '/api/quick-replies'))
  assert.ok(snippets.some((q) => q.title === 'Alice Snippet Alpha'), 'the snippet was renamed or deleted')

  const media = await jsonOf(await asAlice('GET', '/api/media'))
  assert.ok(media.some((m) => m.title === 'Alice Media Alpha'), 'the media asset was deleted')

  const groups = await jsonOf(await asAlice('GET', '/api/groups'))
  assert.ok(groups.some((g) => g.name === 'Alice Group Alpha'), 'the group was renamed or deleted')
})

// Bob's own list endpoints must be empty of Alice's rows — the other half of
// isolation, and the half a per-id check can't see.
test("none of Alice's rows appear in Bob's list endpoints", async () => {
  const lists = [
    '/api/leads', '/api/properties', '/api/contacts', '/api/groups', '/api/labels',
    '/api/templates', '/api/quick-replies', '/api/media', '/api/followups',
    '/api/site-visits', '/api/deals', '/api/commissions', '/api/commission-invoices',
    '/api/notifications', '/api/support/tickets', '/api/activity', '/api/worklist',
  ]
  const leaks = []
  for (const url of lists) {
    const res = await asBob('GET', url)
    assert.equal(res.status, 200, `${url} -> ${res.status}`)
    const text = await res.text()
    const found = SECRETS.filter((s) => text.includes(s))
    if (found.length) leaks.push(`${url} leaked ${found.join(', ')}`)
  }
  assert.deepEqual(leaks, [], leaks.join('\n'))
})

// The list above is only as good as its coverage, so hold it against the real
// router: a new :id route that nobody adds here fails this test rather than
// quietly going unchecked.
test('every id-bearing API route in the app is covered by this sweep', () => {
  // Routes deliberately outside the sweep, each with a reason.
  const EXEMPT = new Set([
    '/api/leads/:id/assign', // claiming an UNASSIGNED lead — open to any agent by design
    '/api/media/:id/send', // scoped via lead_id in the body; covered by its own suite
    '/api/properties/:id/send-to-chat', // ditto
    '/api/groups/:id/send', // ditto
    // Keyed by portal NAME, not a row id, and upserted per agent — there is no
    // foreign row to reach, only the caller's own record for that portal.
    '/api/portal-integrations/:portal',
  ])

  const registered = []
  for (const layer of app._router.stack) {
    const path = layer.route?.path
    if (typeof path !== 'string' || !path.startsWith('/api/') || !path.includes(':')) continue
    for (const method of Object.keys(layer.route.methods)) registered.push(`${method.toUpperCase()} ${path}`)
  }
  assert.ok(registered.length > 40, `expected the router to expose many :id routes, saw ${registered.length}`)

  // Turn each swept concrete URL back into its route pattern by matching against
  // the registered paths segment by segment.
  const sweptPaths = new Set(
    ROUTES().map(([method, url]) => {
      const segs = url.split('/')
      const match = registered.find((r) => {
        const [m, p] = r.split(' ')
        const rsegs = p.split('/')
        return m === method && rsegs.length === segs.length && rsegs.every((s, i) => s.startsWith(':') || s === segs[i])
      })
      return match || `UNMATCHED ${method} ${url}`
    }),
  )

  const unmatched = [...sweptPaths].filter((s) => s.startsWith('UNMATCHED'))
  assert.deepEqual(unmatched, [], `the sweep aims at URLs the router doesn't serve:\n${unmatched.join('\n')}`)

  const missing = registered.filter((r) => !sweptPaths.has(r) && !EXEMPT.has(r.split(' ')[1]))
  assert.deepEqual(
    missing,
    [],
    `these id-bearing routes have no cross-tenant test — add them to ROUTES() or to EXEMPT with a reason:\n${missing.join('\n')}`,
  )
})
