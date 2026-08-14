// End-to-end journeys for the five things an agency actually runs on.
//
// flowsE2E.test.js already follows the inbound journey — a buyer messages the
// business number and becomes a lead an agent can work. This file follows the other
// five, and for the same reason: the value is in the SEAMS. A route can pass its own
// unit test and still fail to stamp the thing the next screen reads, and it is that
// gap an agent experiences as "I booked the visit but it isn't on my day".
//
//   1. Client onboarding   — walk-in → lead + contact + worklist
//   2. Property listing    — inventory → micro-page → matched → sent to a buyer
//   3. Booking management  — book → reschedule → complete, and the day-view each time
//   4. WhatsApp broadcast  — group → members → blast, and who was skipped
//   5. Team management     — invite → accept → round-robin → remove
//
// Outbound Graph API calls are stubbed at global.fetch so sends are observable
// without touching Meta; requests to the local test server pass straight through.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb, pinVisitToToday } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
process.env.WHATSAPP_APP_SECRET = 'flows-app-secret'
process.env.WHATSAPP_VERIFY_TOKEN = 'flows-verify-token'
process.env.WHATSAPP_ACCESS_TOKEN = 'flows-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'flows-phone-id'
const dbName = await createTestDb('criticalflows')

const { app } = await import('../index.js')
const { closePool, query } = await import('../db.js')

let server
let base
let token
let agentId

let waSends = []
let sendSeq = 0
const realFetch = global.fetch

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const json = async (...args) => (await req(...args)).json()

// The webhook acks Meta immediately and finishes the pipeline afterwards, so
// nothing downstream is readable synchronously.
async function until(fn, what = 'condition', timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Sign an extra agent up and return a caller bound to their token. */
async function signup(name, phone) {
  const me = await json('POST', '/api/auth/signup', { name, phone, password: 'secret123' }, null)
  return {
    id: me.agent.id,
    token: me.token,
    phone,
    req: (method, url, body) => req(method, url, body, me.token),
    json: (method, url, body) => json(method, url, body, me.token),
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.includes('graph.facebook.com')) {
      let body = null
      try {
        body = JSON.parse(opts?.body ?? '{}')
      } catch {
        body = null
      }
      waSends.push({ url: target, body })
      sendSeq++
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ messages: [{ id: `wamid.flows.${sendSeq}` }] }),
      }
    }
    return realFetch(url, opts)
  }

  const me = await json('POST', '/api/auth/signup', {
    name: 'Anjali Desai',
    phone: '+919700000001',
    password: 'secret123',
  }, null)
  token = me.token
  agentId = me.agent.id
  await query('UPDATE agents SET wa_phone_number_id = $2, wa_phone_number = $3 WHERE id = $1', [
    agentId,
    'flows-phone-id',
    '+919700000001',
  ])
})

beforeEach(() => {
  waSends = []
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// === Flow 1: client onboarding ==============================================
//
// The walk-in. Someone stands in the office, the agent has about ten seconds, and
// what they type has to end up in every screen they will look at later — otherwise
// the lead exists only in the form that created it.

test('FLOW a walk-in becomes a lead, a contact, and a job on the worklist', async () => {
  const out = await json('POST', '/api/leads/quick-add', {
    phone: '+919611200001',
    name: 'Kunal Mehta',
    channel: 'walk_in',
    tags: ['3bhk', 'baner', 'ready-to-move'],
  })
  assert.ok(out.lead?.id, 'quick-add returned no lead')
  const leadId = out.lead.id

  // The deep link is the whole point of the form: the agent taps it to open the
  // thread on their phone. A lead with no way to reach it is a note, not a lead.
  assert.match(out.wa_deeplink || '', /wa\.me\/919611200001/)

  // 1. It is a lead the inbox can see.
  const list = await json('GET', '/api/leads')
  assert.ok(list.some((l) => l.id === leadId), 'the walk-in never reached GET /api/leads')

  // 2. The source is recorded as a walk-in, not left to look like an inbound chat.
  const detail = await json('GET', `/api/leads/${leadId}`)
  assert.equal(detail.source, 'walk_in')

  // 3. A CRM contact was captured for the number, with the tags typed on the form.
  const contact = await until(
    async () => (await json('GET', '/api/contacts')).find((c) => c.phone?.includes('9611200001')),
    'the walk-in to be captured as a contact',
  )
  assert.equal(contact.name, 'Kunal Mehta')
  assert.deepEqual((contact.labels || []).sort(), ['3bhk', 'baner', 'ready-to-move'])

  // 4. And it is on the worklist — the screen that decides what the agent does next.
  //    A walk-in nobody has messaged yet is exactly the case the worklist exists for.
  const worklist = await json('GET', '/api/worklist')
  assert.ok(
    worklist.items.some((i) => i.lead_id === leadId),
    'a brand-new walk-in was not queued as work',
  )
})

test('FLOW onboarding the same walk-in twice does not create a second lead', async () => {
  // Agents re-add people. Two rows for one buyer means two threads, two owners and
  // a duplicate follow-up, and the number is the identity that has to catch it.
  const first = await json('POST', '/api/leads/quick-add', { phone: '+919611200002', name: 'Sneha Rao' })
  const second = await json('POST', '/api/leads/quick-add', { phone: '+919611200002', name: 'Sneha Rao' })

  assert.equal(second.lead.id, first.lead.id, 'the same buyer was onboarded as two leads')

  const rows = await query('SELECT id FROM leads WHERE agent_id = $1 AND wa_id = $2', [agentId, '919611200002'])
  assert.equal(rows.rows.length, 1)
})

test('FLOW a walk-in with an unusable number is refused before a lead exists', async () => {
  const res = await req('POST', '/api/leads/quick-add', { phone: 'not-a-number', name: 'Typo' })
  assert.equal(res.status, 400)

  const list = await json('GET', '/api/leads')
  assert.equal(list.some((l) => l.name === 'Typo'), false, 'a lead was created from a rejected number')
})

// === Flow 2: property listing ===============================================
//
// Inventory only earns its keep when it reaches a buyer. This follows one listing
// from the form to a buyer's phone: created, published, matched, sent.

test('FLOW a listing is created, published as a micro-page, and served publicly', async () => {
  const property = await json('POST', '/api/properties', {
    title: 'Godrej Riverside 3BHK',
    property_type: 'apartment',
    bhk: 3,
    size_sqft: 1450,
    price_paise: 9500000000, // ₹95L
    locality: 'Baner',
    city: 'Pune',
    status: 'available',
    rera_project_number: 'P52100012345',
  })
  assert.ok(property.id)

  const page = await json('POST', `/api/properties/${property.id}/micro-page`, {})
  assert.ok(page.slug, 'publishing returned no slug')

  // The public page takes no auth — it is pasted into broker groups — so it must
  // render for a caller with no token at all.
  const res = await fetch(`${base}/p/${page.slug}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/html/)

  const html = await res.text()
  assert.match(html, /Godrej Riverside 3BHK/)
  assert.match(html, /Baner/)
  assert.match(html, /95/, 'the price never reached the page')
  assert.match(html, /P52100012345/, 'the RERA number is a legal requirement on a listing')

  // A view from a stranger is the engagement signal the agent is shown later.
  await until(
    async () => (await json('GET', `/api/properties/${property.id}/analytics`)).total > 0,
    'the public view to be counted',
  )
})

test('FLOW a listing is matched to a buyer and sent into their chat', async () => {
  const lead = (await json('POST', '/api/leads/quick-add', {
    phone: '+919611200003',
    name: 'Ravi Kulkarni',
  })).lead

  // Give the buyer a brief the matcher can work with.
  await json('PUT', `/api/leads/${lead.id}`, {
    budget_min_paise: 8000000000,
    budget_max_paise: 11000000000,
    bhk: '3',
    locality: 'Baner',
  })

  const property = await json('POST', '/api/properties', {
    title: 'Kumar Prospera 3BHK',
    property_type: 'apartment',
    bhk: 3,
    price_paise: 9000000000,
    locality: 'Baner',
    city: 'Pune',
    status: 'available',
  })

  const matches = await json('GET', `/api/leads/${lead.id}/property-matches`)
  const match = matches.find((m) => m.id === property.id)
  assert.ok(match, 'a listing inside the buyer’s budget and area was not offered as a match')
  // The agent has to be able to defend the suggestion to the buyer, so the match
  // carries its reasons rather than just a score.
  assert.ok(match.match_reasons?.length, 'the match came with nothing to say for itself')

  const sent = await json('POST', `/api/properties/${property.id}/send-to-chat`, { lead_id: lead.id })
  assert.equal(sent.ok, true)

  // 1. It actually went to Meta, addressed to this buyer.
  assert.equal(waSends.length, 1, 'send-to-chat did not reach the Graph API exactly once')
  assert.equal(waSends[0].body?.to, '919611200003')
  assert.match(waSends[0].body?.text?.body || '', /Kumar Prospera 3BHK/)

  // 2. The buyer gets a tracked link, which is what turns a share into a signal.
  assert.match(waSends[0].body?.text?.body || '', new RegExp(`/p/[a-z0-9-]+\\?l=${lead.id}`))

  // 3. And it is in the thread the agent reads, not only in Meta's logs.
  const thread = await json('GET', `/api/leads/${lead.id}`)
  assert.ok(
    thread.messages.some((m) => m.role === 'agent' && /Kumar Prospera/.test(m.text)),
    'the sent listing never appeared in the conversation',
  )
})

test('FLOW a listing cannot be sent into a chat that is not the agent’s', async () => {
  // send-to-chat takes a lead_id from the body, which is the shape that quietly
  // crosses tenants if only the property is checked.
  const other = await signup('Outsider Agent', '+919700000009')
  const theirLead = (await other.json('POST', '/api/leads/quick-add', { phone: '+919611200004', name: 'Not Yours' })).lead

  const mine = await json('POST', '/api/properties', { title: 'My Listing', city: 'Pune' })

  const res = await req('POST', `/api/properties/${mine.id}/send-to-chat`, { lead_id: theirLead.id })
  assert.equal(res.status, 404)
  assert.equal(waSends.length, 0, 'a message went out to another workspace’s buyer')
})

// === Flow 3: booking management =============================================
//
// A site visit is the appointment the whole pipeline is aiming at. flowsE2E covers
// the booking itself reaching the day view; this follows what happens afterwards,
// because a visit is rescheduled or cancelled more often than it is booked.

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString()
const HOUR = 3600_000

test('FLOW a site visit is booked, rescheduled and completed, and the list keeps up each time', async () => {
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611200005', name: 'Meera Joshi' })).lead
  const property = await json('POST', '/api/properties', { title: 'Lakeside Villa', city: 'Pune' })

  const visit = await json('POST', '/api/site-visits', {
    lead_id: lead.id,
    property_id: property.id,
    scheduled_at: iso(24 * HOUR),
    pickup_required: true,
    pickup_location: 'Baner Road junction',
  })
  assert.ok(visit.id)
  assert.equal(visit.status, 'scheduled')

  // Booked → on the list, with the pickup the agent has to plan a car around.
  const booked = await json('GET', `/api/site-visits?lead_id=${lead.id}`)
  assert.equal(booked.length, 1)
  assert.equal(booked[0].pickup_required, true)

  // Rescheduled → the list shows the NEW time, not both and not the old one.
  const newTime = iso(48 * HOUR)
  await json('PUT', `/api/site-visits/${visit.id}`, { scheduled_at: newTime })
  const after = await json('GET', `/api/site-visits?lead_id=${lead.id}`)
  assert.equal(after.length, 1, 'rescheduling created a second visit instead of moving one')
  assert.equal(new Date(after[0].scheduled_at).toISOString(), newTime)

  // Completed → it carries the outcome, which is what the follow-up is written from.
  const done = await json('PUT', `/api/site-visits/${visit.id}`, {
    status: 'completed',
    outcome_notes: 'Liked the layout, wants to see the top floor unit',
  })
  assert.equal(done.status, 'completed')
  assert.match(done.outcome_notes, /top floor/)

  // The visit was moved to tomorrow, so today's list should no longer carry it —
  // this pins the date filter, not the status one.
  const dashboard = await json('GET', '/api/dashboard')
  assert.equal(
    (dashboard.siteVisitsToday || []).some((v) => v.id === visit.id),
    false,
    'a visit rescheduled to another day was still on today',
  )
})

test('FLOW a visit the buyer does not turn up to keeps the lead and stays on the day', async () => {
  const lead = (await json('POST', '/api/leads/quick-add', { phone: '+919611200006', name: 'Arjun Pillai' })).lead
  const visit = await json('POST', '/api/site-visits', { lead_id: lead.id, scheduled_at: iso(2 * HOUR) })
  // The day-view assertion below is about the date filter, so the visit has to be on
  // the agent's today — which iso(2 * HOUR) is not, late enough in their evening.
  await pinVisitToToday(query, visit.id, agentId)

  // 'no_show' rather than 'cancelled': the schema's statuses are scheduled /
  // confirmed / completed / no_show / rescheduled, and there is deliberately no
  // cancelled state — a called-off visit is recorded as rescheduled or left to
  // pass as a no-show. Worth knowing, because "cancelled" is the word an agent
  // would reach for, and the API answers a check-constraint violation to it.
  const missed = await json('PUT', `/api/site-visits/${visit.id}`, { status: 'no_show' })
  assert.equal(missed.status, 'no_show')

  // A missed visit must not lose the buyer — they are still a lead, and losing them
  // here is how a pipeline quietly empties.
  const stillThere = await json('GET', `/api/leads/${lead.id}`)
  assert.equal(stillThere.id, lead.id)

  // The day view is a DAY, not a to-do list: listSiteVisits({ today }) filters by
  // date and not by status, and the dashboard widget renders each row's status
  // label. So the visit stays visible, marked no-show — which is what an agent
  // checking "what was I doing at 4pm" wants to see.
  const dashboard = await json('GET', '/api/dashboard')
  const shown = (dashboard.siteVisitsToday || []).find((v) => v.id === visit.id)
  assert.ok(shown, 'the missed visit vanished from the day with no trace it had been booked')
  assert.equal(shown.status, 'no_show', 'it is on the day but not marked as missed')
})

test('FLOW a visit cannot be booked against another workspace’s lead', async () => {
  const other = await signup('Booking Outsider', '+919700000010')
  const theirLead = (await other.json('POST', '/api/leads/quick-add', { phone: '+919611200007', name: 'Theirs' })).lead

  const res = await req('POST', '/api/site-visits', { lead_id: theirLead.id, scheduled_at: iso(HOUR) })
  assert.ok(res.status === 404 || res.status === 403, `expected a refusal, got ${res.status}`)
})

// === Flow 4: WhatsApp broadcast =============================================
//
// The blast an agent sends when a new project launches. It is the one action that
// reaches everyone at once, so both halves matter: that it goes out, and that the
// agent is told who it did not reach.

test('FLOW a group is built and a broadcast reaches every member once', async () => {
  const buyers = []
  for (const [name, phone] of [['Blast One', '+919611300001'], ['Blast Two', '+919611300002'], ['Blast Three', '+919611300003']]) {
    const out = await json('POST', '/api/leads/quick-add', { phone, name })
    buyers.push(out.lead)
  }
  const contacts = await json('GET', '/api/contacts')
  const memberIds = buyers.map((b) => contacts.find((c) => c.phone?.includes(b.wa_id.slice(2)))?.id).filter(Boolean)
  assert.equal(memberIds.length, 3, 'the buyers were not all captured as contacts')

  const group = await json('POST', '/api/groups', { name: 'Baner 3BHK interest', kind: 'static' })
  const { added } = await json('POST', `/api/groups/${group.id}/members`, { contact_ids: memberIds })
  assert.equal(added, 3, 'the group did not take all three contacts')

  const members = await json('GET', `/api/groups/${group.id}/members`)
  assert.equal(members.length, 3)

  waSends = []
  const result = await json('POST', `/api/groups/${group.id}/send`, {
    message: 'New launch in Baner — 3BHK from ₹92L. Reply INTERESTED for the brochure.',
  })

  assert.equal(result.sent, 3, `the blast reached ${result.sent} of 3`)
  assert.equal(waSends.length, 3, 'the Graph API saw a different number of sends than the API reported')

  // Everyone, exactly once — a duplicate on a marketing blast is how a number gets
  // reported, and Meta counts reports against the whole business account.
  const recipients = waSends.map((s) => s.body?.to).sort()
  assert.deepEqual(recipients, ['919611300001', '919611300002', '919611300003'])

  // The blast is on the record, because "did that go out?" is asked afterwards.
  const activity = await json('GET', '/api/activity')
  assert.ok(
    activity.some((a) => /Group blast to 3\/3/.test(a.text || '')),
    'a broadcast to three people left no trace in the activity feed',
  )
})

test('FLOW an empty broadcast is refused before anyone is messaged', async () => {
  const group = await json('POST', '/api/groups', { name: 'Empty message test', kind: 'static' })
  waSends = []

  const res = await req('POST', `/api/groups/${group.id}/send`, { message: '   ' })
  assert.equal(res.status, 400)
  assert.equal(waSends.length, 0)
})

test('FLOW broadcasting to a group that is not the agent’s is a 404, not a send', async () => {
  const other = await signup('Group Outsider', '+919700000011')
  const theirGroup = await other.json('POST', '/api/groups', { name: 'Their list', kind: 'static' })

  waSends = []
  const res = await req('POST', `/api/groups/${theirGroup.id}/send`, { message: 'Hello' })
  assert.equal(res.status, 404)
  assert.equal(waSends.length, 0, 'a blast went out over another workspace’s contact list')
})

// === Flow 5: team management ================================================
//
// One WhatsApp number, several agents. The flow that matters is a teammate joining
// and starting to receive work — an invite that is accepted but never wired into
// assignment is the failure that looks like everything worked.

test('FLOW an owner invites a teammate, who accepts and appears on the roster', async () => {
  const owner = await signup('Team Owner', '+919700000021')
  const member = await signup('Team Member', '+919700000022')

  const team = await owner.json('POST', '/api/team', { name: 'Desai Realty' })
  assert.ok(team.id || team.team?.id)

  const invite = await owner.json('POST', '/api/team/invites', { phone: '+919700000022', role: 'agent' })
  assert.ok(invite.id, 'no invite was created')

  // The invitee sees it on their own screen, which is the only place they can act.
  const incoming = await member.json('GET', '/api/team/invites/incoming')
  assert.ok(incoming.some((i) => i.id === invite.id), 'the invite never reached the person invited')

  await member.json('POST', `/api/team/invites/${invite.id}/accept`, {})

  const roster = await owner.json('GET', '/api/team/members')
  const joined = roster.find((m) => m.agent_id === member.id)
  assert.ok(joined, 'an accepted invite did not put the teammate on the roster')
  assert.equal(joined.role, 'agent')

  // And the new member's own view agrees they are in a team — the two screens read
  // different queries and only one of them used to be checked.
  const theirView = await member.json('GET', '/api/team')
  assert.equal(theirView.team?.name, 'Desai Realty')
  assert.equal(theirView.role, 'agent')
})

/** Owner + two agents in a team, with the given assignment strategy. */
async function teamOf(prefix, phones, strategy) {
  const owner = await signup(`${prefix} Owner`, phones[0])
  const members = []
  await owner.json('POST', '/api/team', { name: `${prefix} Realty` })
  for (const phone of phones.slice(1)) {
    const m = await signup(`${prefix} Member ${phone.slice(-2)}`, phone)
    const invite = await owner.json('POST', '/api/team/invites', { phone, role: 'agent' })
    await m.json('POST', `/api/team/invites/${invite.id}/accept`, {})
    members.push(m)
  }
  if (strategy) await owner.json('PUT', '/api/team', { assignment_strategy: strategy })
  return { owner, members }
}

// This is the bug this file was written to find, so it gets its own test rather
// than living as a precondition of the round-robin one below.
//
// Only the inbound WhatsApp path stamped a new lead with its owner's team. Every
// lead that does NOT arrive as a WhatsApp message — walk-ins, phone quick-adds,
// portal notification emails, Meta Lead Ads, direct portal pulls — goes through
// leadSources.ingestLead, which never did. For an agency working 99acres and
// MagicBricks that is most of the pipeline, and it was invisible to the manager
// who is supposed to be distributing it.
test('FLOW a walk-in taken by a team member reaches the team’s shared inbox', async () => {
  const { owner } = await teamOf('Shared', ['+919700000061', '+919700000062'])

  const lead = (await owner.json('POST', '/api/leads/quick-add', {
    phone: '+919611450001',
    name: 'Shared Inbox Buyer',
  })).lead

  const teamLeads = await owner.json('GET', '/api/team/leads')
  assert.ok(
    teamLeads.some((l) => l.id === lead.id),
    'a walk-in never reached the shared inbox — only WhatsApp leads were being tagged with the team',
  )
})

test('FLOW round-robin hands new leads out across the team instead of piling them on the owner', async () => {
  const { owner } = await teamOf('RR', ['+919700000031', '+919700000032', '+919700000033'], 'round_robin')

  // Four leads through the manager's auto-assign, which is the path the pool uses.
  // Auto-assign resolves the lead through its team_id, so this only reaches the
  // strategy at all once a walk-in is tagged with its team.
  const owners = []
  for (let i = 0; i < 4; i++) {
    const lead = (await owner.json('POST', '/api/leads/quick-add', {
      phone: `+9196114000${10 + i}`,
      name: `RR Buyer ${i}`,
    })).lead
    const res = await owner.req('POST', `/api/team/leads/${lead.id}/auto-assign`, {})
    const body = await res.json() // read once: a Response body cannot be consumed twice
    assert.equal(res.status, 200, `auto-assign refused lead ${i}: ${JSON.stringify(body)}`)
    owners.push(body.agent_id)
  }

  // The point of round-robin: more than one person ends up with work. A strategy
  // that "succeeds" while giving every lead to the same agent is the bug.
  const distinct = new Set(owners.filter(Boolean))
  assert.ok(distinct.size > 1, `round-robin gave all four leads to ${distinct.size} agent(s)`)
})

test('FLOW removing a member takes away their team view but not their leads', async () => {
  const owner = await signup('Remove Owner', '+919700000041')
  const member = await signup('Remove Member', '+919700000042')

  await owner.json('POST', '/api/team', { name: 'Exit Realty' })
  const invite = await owner.json('POST', '/api/team/invites', { phone: member.phone, role: 'agent' })
  await member.json('POST', `/api/team/invites/${invite.id}/accept`, {})

  const lead = (await member.json('POST', '/api/leads/quick-add', { phone: '+919611500001', name: 'Kept Buyer' })).lead

  await owner.req('DELETE', `/api/team/members/${member.id}`)

  const roster = await owner.json('GET', '/api/team/members')
  assert.equal(roster.some((m) => m.agent_id === member.id), false, 'the removed member is still on the roster')

  // They become a solo agent again — losing the team must not lose the pipeline
  // they built, which is both the product promise and the thing a bad DELETE eats.
  const theirs = await member.json('GET', `/api/leads/${lead.id}`)
  assert.equal(theirs.id, lead.id, 'a removed member lost the leads they owned')

  const theirTeam = await member.json('GET', '/api/team')
  assert.ok(!theirTeam.team, 'a removed member still sees the team')
})

test('FLOW a teammate cannot invite anyone — that is a manager’s job', async () => {
  const owner = await signup('Perm Owner', '+919700000051')
  const member = await signup('Perm Member', '+919700000052')

  await owner.json('POST', '/api/team', { name: 'Permission Realty' })
  const invite = await owner.json('POST', '/api/team/invites', { phone: member.phone, role: 'agent' })
  await member.json('POST', `/api/team/invites/${invite.id}/accept`, {})

  const res = await member.req('POST', '/api/team/invites', { phone: '+919700000053', role: 'manager' })
  assert.equal(res.status, 403, 'a plain agent could add people to the team')
})
