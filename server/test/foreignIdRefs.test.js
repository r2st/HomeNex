// The other place a resource id arrives: the body and the query string.
//
// `tenantSweep.test.js` enumerates every authenticated route with an `:id` in its
// PATH and proves each one is scoped. That covers the id the router hands over. It
// does not cover the ids that arrive inside the request — `{ lead_id }` on a
// follow-up, `{ contact_ids }` on a group, `{ template_id }` on a reply,
// `?commission_id=` on the invoice list — and those are the same sequential integers
// with the same consequence. `crossTenantRefs.test.js` covers two of them
// (`property_id`, `deal_id`, where a foreign row leaked joined columns back out);
// the rest have never been aimed across a tenant boundary.
//
// Two distinct failure modes, and this file separates them because they are caught
// by different code and would be fixed differently:
//
//   READ    a filter id that isn't scoped. `?lead_id=<theirs>` reaching a WHERE
//           clause that lost its `agent_id = $1` returns another agent's follow-ups
//           under my heading, with a 200 and no sign anything is wrong.
//   WRITE   a foreign id accepted into one of MY rows. The row is written with my
//           agent_id — so it looks like mine forever — while pointing at someone
//           else's buyer or contact. The group case is the worst of these: it ends
//           with a WhatsApp broadcast reaching another broker's clients from my
//           number.
//
// Bob is a fully authenticated agent of the same rank throughout, never anonymous —
// the question is not "does auth work" but "does auth scope".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('foreignids')

const { app } = await import('../index.js')
const { closePool, query, addContact } = await import('../db.js')

let server, base
const alice = {}
const bob = {}

// Strings that exist only in Alice's rows. Finding one in a response to Bob is a
// leak whatever the status code says.
const SECRETS = ['Alice Secret Buyer', 'Alice Secret Contact', 'Alice Secret Template', 'Alice Secret Tower']

const req = (token, method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

async function jreq(token, method, url, body) {
  const res = await req(token, method, url, body)
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

/** No response may carry Alice's private strings, whatever else it says. */
function assertNoLeak(out, what) {
  for (const secret of SECRETS) {
    assert.ok(!out.text.includes(secret), `${what} leaked ${JSON.stringify(secret)} — body was ${out.text.slice(0, 400)}`)
  }
}

async function signup(name, phone) {
  const out = await jreq(null, 'POST', '/api/auth/signup', { name, phone, password: 'secret123' })
  return { token: out.body.token, id: out.body.agent.id }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  Object.assign(alice, await signup('Alice Agent', '+919800000301'))
  Object.assign(bob, await signup('Bob Agent', '+919800000302'))

  // --- Alice's world.
  alice.lead = (await jreq(alice.token, 'POST', '/api/leads/quick-add', {
    name: 'Alice Secret Buyer',
    phone: '+919777700301',
  })).body
  alice.leadId = alice.lead.id ?? alice.lead.lead?.id
  alice.property = (await jreq(alice.token, 'POST', '/api/properties', {
    title: 'Alice Secret Tower',
    property_type: 'apartment',
  })).body
  alice.template = (await jreq(alice.token, 'POST', '/api/templates', {
    name: 'Alice Secret Template',
    body: 'Alice says hello',
  })).body
  alice.contact = await addContact(alice.id, '+919777700303', 'Alice Secret Contact')
  alice.followup = (await jreq(alice.token, 'POST', '/api/followups', {
    lead_id: alice.leadId,
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
    note: 'alice follow-up',
  })).body
  alice.visit = (await jreq(alice.token, 'POST', '/api/site-visits', {
    lead_id: alice.leadId,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })).body
  alice.commission = (await jreq(alice.token, 'POST', '/api/commissions', {
    lead_id: alice.leadId,
    deal_value_paise: 100_000_000,
    commission_pct: 2,
  })).body
  alice.invoice = (await jreq(alice.token, 'POST', `/api/commissions/${alice.commission.id}/invoice`, {})).body

  // --- Bob's world: one of everything, so a write that lands has somewhere to land.
  bob.lead = (await jreq(bob.token, 'POST', '/api/leads/quick-add', { name: 'Bobs Buyer', phone: '+919777700302' })).body
  bob.leadId = bob.lead.id ?? bob.lead.lead?.id
  bob.property = (await jreq(bob.token, 'POST', '/api/properties', { title: 'Bobs Block', property_type: 'apartment' })).body
  bob.media = (await jreq(bob.token, 'POST', '/api/media', {
    title: 'Bobs Brochure',
    url: 'https://example.test/b.pdf',
    kind: 'document',
  })).body
  bob.group = (await jreq(bob.token, 'POST', '/api/groups', { name: 'Bobs Group' })).body
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

test('the fixture really did give Alice rows worth stealing', async () => {
  // Everything below asserts an ABSENCE. Without this, a fixture that silently failed
  // to create Alice's data would make every test in the file pass for the wrong reason.
  assert.ok(alice.leadId, 'Alice has a lead')
  assert.ok(alice.property?.id, 'Alice has a property')
  assert.ok(alice.template?.id, 'Alice has a template')
  assert.ok(alice.contact?.id, 'Alice has a contact')
  assert.ok(alice.followup?.id, 'Alice has a follow-up')
  assert.ok(alice.visit?.id, 'Alice has a site visit')
  assert.ok(alice.invoice?.id, 'Alice has an invoice')

  // And Alice can see them herself, so the 404s Bob gets below mean "not yours"
  // rather than "not there".
  const own = await jreq(alice.token, 'GET', `/api/followups?lead_id=${alice.leadId}`)
  assert.equal(own.status, 200)
  assert.equal(own.body.length, 1)
})

// --- READ: a filter id that points across the boundary --------------------------

test('filtering follow-ups by another agent′s lead returns mine, not theirs', async () => {
  const out = await jreq(bob.token, 'GET', `/api/followups?lead_id=${alice.leadId}`)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, [], "a foreign lead filter must match none of Bob's follow-ups")
  assertNoLeak(out, 'GET /api/followups?lead_id')
})

test('filtering site visits by another agent′s lead returns nothing', async () => {
  const out = await jreq(bob.token, 'GET', `/api/site-visits?lead_id=${alice.leadId}`)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, [])
  assertNoLeak(out, 'GET /api/site-visits?lead_id')
})

test('filtering invoices by another agent′s commission returns nothing', async () => {
  const out = await jreq(bob.token, 'GET', `/api/commission-invoices?commission_id=${alice.commission.id}`)

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, [])
  assertNoLeak(out, 'GET /api/commission-invoices?commission_id')
})

// --- WRITE: a foreign id accepted into one of my own rows -----------------------

test('a follow-up cannot be hung on another agent′s lead', async () => {
  const out = await jreq(bob.token, 'POST', '/api/followups', {
    lead_id: alice.leadId,
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
    note: 'bob peeking',
  })

  assert.ok(out.status >= 400, `expected a refusal, got ${out.status}`)
  assertNoLeak(out, 'POST /api/followups')
  // And nothing was written: the row would carry Bob's agent_id while pointing at
  // Alice's buyer, so it would never look wrong on either agent's screen.
  const { rows } = await query('SELECT * FROM followups WHERE lead_id = $1 AND agent_id = $2', [alice.leadId, bob.id])
  assert.equal(rows.length, 0)
})

test('a site visit cannot be booked against another agent′s lead', async () => {
  const out = await jreq(bob.token, 'POST', '/api/site-visits', {
    lead_id: alice.leadId,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
  })

  assert.ok(out.status >= 400, `expected a refusal, got ${out.status}`)
  assertNoLeak(out, 'POST /api/site-visits')
  const { rows } = await query('SELECT * FROM site_visits WHERE lead_id = $1 AND agent_id = $2', [alice.leadId, bob.id])
  assert.equal(rows.length, 0, 'a booking here would send Alice′s buyer a WhatsApp confirmation from Bob')
})

test('a commission cannot be claimed against another agent′s lead', async () => {
  const out = await jreq(bob.token, 'POST', '/api/commissions', {
    lead_id: alice.leadId,
    deal_value_paise: 50_000_000,
    commission_pct: 2,
  })

  assert.ok(out.status >= 400, `expected a refusal, got ${out.status}`)
  assertNoLeak(out, 'POST /api/commissions')
  const { rows } = await query('SELECT * FROM commissions WHERE lead_id = $1 AND agent_id = $2', [alice.leadId, bob.id])
  assert.equal(rows.length, 0)
})

test('a deal cannot be captured against another agent′s lead', async () => {
  const out = await jreq(bob.token, 'POST', '/api/deals', { lead_id: alice.leadId, deal_type: 'sale' })

  assert.ok(out.status >= 400, `expected a refusal, got ${out.status}`)
  assertNoLeak(out, 'POST /api/deals')
  const { rows } = await query('SELECT * FROM deals WHERE lead_id = $1 AND agent_id = $2', [alice.leadId, bob.id])
  assert.equal(rows.length, 0)
})

test('a reply cannot be rendered from another agent′s template', async () => {
  // The template body is written by its owner and can hold anything — pricing, a
  // client's name. Rendering it into Bob's chat would copy it across the boundary
  // and send it to a buyer.
  const out = await jreq(bob.token, 'POST', `/api/leads/${bob.leadId}/reply`, { template_id: alice.template.id })

  assert.equal(out.status, 404)
  assertNoLeak(out, 'POST /api/leads/:id/reply')
})

test('media cannot be sent into another agent′s chat', async () => {
  const out = await jreq(bob.token, 'POST', `/api/media/${bob.media.id}/send`, { lead_id: alice.leadId })

  assert.equal(out.status, 404)
  assertNoLeak(out, 'POST /api/media/:id/send')
  const { rows } = await query('SELECT * FROM messages WHERE lead_id = $1', [alice.leadId])
  assert.equal(rows.length, 0, "nothing may be appended to Alice's transcript")
})

test('a property cannot be pushed into another agent′s chat', async () => {
  const out = await jreq(bob.token, 'POST', `/api/properties/${bob.property.id}/send-to-chat`, { lead_id: alice.leadId })

  assert.equal(out.status, 404)
  assertNoLeak(out, 'POST /api/properties/:id/send-to-chat')
  const { rows } = await query('SELECT * FROM messages WHERE lead_id = $1', [alice.leadId])
  assert.equal(rows.length, 0)
})

// --- The one that ends in a broadcast -------------------------------------------

test("another agent's contacts cannot be added to my group", async () => {
  const out = await jreq(bob.token, 'POST', `/api/groups/${bob.group.id}/members`, {
    contact_ids: [alice.contact.id],
  })

  // A 200 is fine here — the route reports how many were added, and the correct
  // answer is zero. What must not happen is the membership row.
  assert.equal(out.body.added, 0, 'no foreign contact may join the group')
  assertNoLeak(out, 'POST /api/groups/:id/members')
  const { rows } = await query(
    'SELECT * FROM contact_group_members WHERE group_id = $1 AND contact_id = $2',
    [bob.group.id, alice.contact.id],
  )
  assert.equal(rows.length, 0)
})

test("a group broadcast cannot reach another agent's contacts", async () => {
  // The consequence of the previous test, asserted end to end rather than inferred:
  // if a foreign contact ever did slip into the group, this is where it would show up
  // — a WhatsApp message to another broker's client, sent from Bob's number.
  await jreq(bob.token, 'POST', `/api/groups/${bob.group.id}/members`, { contact_ids: [alice.contact.id] })
  const members = await jreq(bob.token, 'GET', `/api/groups/${bob.group.id}/members`)

  assert.equal(members.status, 200)
  assert.deepEqual(members.body, [], 'the group is empty, so a broadcast has nobody foreign to reach')
  assertNoLeak(members, 'GET /api/groups/:id/members')
})

test('and Bob can still do all of this with his OWN ids', async () => {
  // The refusals above would also be produced by a route that rejects everything.
  // This is what says the scoping is a boundary and not a wall.
  const followup = await jreq(bob.token, 'POST', '/api/followups', {
    lead_id: bob.leadId,
    due_at: new Date(Date.now() + 86_400_000).toISOString(),
    note: 'bobs own',
  })
  assert.equal(followup.status, 200)

  const own = await jreq(bob.token, 'GET', `/api/followups?lead_id=${bob.leadId}`)
  assert.equal(own.body.length, 1)

  const bobContact = await addContact(bob.id, '+919777700304', 'Bobs Own Contact')
  const added = await jreq(bob.token, 'POST', `/api/groups/${bob.group.id}/members`, { contact_ids: [bobContact.id] })
  assert.equal(added.body.added, 1)
})
