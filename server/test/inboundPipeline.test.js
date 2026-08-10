// The inbound pipeline with BOTH integrations switched on.
//
// Every other webhook suite runs with OPENROUTER_API_KEY and WHATSAPP_ACCESS_TOKEN
// deleted, which is honest about the dev environment but leaves the branches that
// only run in production untested: the AI auto-reply, what happens when the Graph
// API refuses that reply, the extraction that follows it, click-to-WhatsApp ad
// attribution, and round-robin hand-off on a team line.
//
// Both providers are stubbed at global.fetch and are individually switchable per
// test, so a failure mode is a one-line change rather than a new harness.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.OPENROUTER_API_KEY = 'test-openrouter-key'
process.env.WHATSAPP_APP_SECRET = 'pipeline-app-secret'
process.env.WHATSAPP_VERIFY_TOKEN = 'pipeline-verify-token'
process.env.WHATSAPP_ACCESS_TOKEN = 'pipeline-access-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'pipeline-phone-id'
const dbName = await createTestDb('inboundpipeline')

const { app } = await import('../index.js')
const { closePool, query, createAgent, createTeam, updateTeam, addContact } = await import('../db.js')
const { hashPassword } = await import('../auth.js')

const APP_SECRET = 'pipeline-app-secret'
let server, base, token, agentId

// --- Provider stubs -----------------------------------------------------------

// What OpenRouter answers. `reply` serves the conversational call; `extraction`
// serves the JSON-mode call. Either may be set to the string 'fail' to make the
// provider return a hard (non-retryable) 400 instead.
let ai = { reply: 'Sure — I can send you a few options in Baner.', extraction: null }
// What the Graph API answers for a send: 'ok', 'token-expired' or 'rejected'.
let wa = 'ok'
let waSends = []
let aiCalls = []
let sendSeq = 0
const realFetch = global.fetch

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })

  global.fetch = async (url, opts) => {
    const target = String(url)
    if (target.startsWith(base)) return realFetch(url, opts)

    if (target.includes('openrouter.ai')) {
      const body = JSON.parse(opts.body)
      // JSON mode is how extractLead asks; the plain call is generateReply/suggestReplies.
      const wantsJson = Boolean(body.response_format)
      aiCalls.push({ wantsJson, model: body.model })
      const answer = wantsJson ? ai.extraction : ai.reply
      if (answer === 'fail') return jsonResponse(400, { error: { message: 'bad api key' } })
      if (answer == null) return jsonResponse(200, { choices: [{ message: { content: '' } }] })
      const content = wantsJson ? JSON.stringify(answer) : answer
      return jsonResponse(200, { choices: [{ message: { content } }] })
    }

    if (target.includes('graph.facebook.com')) {
      // markRead and other bookkeeping calls always succeed; only sends are switchable.
      const body = opts?.body ? JSON.parse(opts.body) : {}
      if (body.status === 'read') return jsonResponse(200, { success: true })
      waSends.push({ url: target, body })
      if (wa === 'token-expired') {
        return jsonResponse(400, { error: { code: 190, type: 'OAuthException', message: 'Session expired' } })
      }
      if (wa === 'rejected') {
        return jsonResponse(400, { error: { code: 131047, message: 'Re-engagement message' } })
      }
      return jsonResponse(200, { messages: [{ id: `wamid.PIPE.${++sendSeq}` }] })
    }
    throw new Error(`unexpected outbound call in test: ${target}`)
  }

  const out = await (
    await fetch(base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Pipeline Priya', phone: '+919740000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  agentId = out.agent.id
  // Own the line so inbound routes straight to this agent.
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [agentId, 'pipeline-phone-id'])
})

beforeEach(() => {
  ai = { reply: 'Sure — I can send you a few options in Baner.', extraction: null }
  wa = 'ok'
  waSends = []
  aiCalls = []
})

after(async () => {
  global.fetch = realFetch
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Harness ------------------------------------------------------------------

const req = (method, url, body, tok = token) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const json = async (...args) => (await req(...args)).json()

let msgSeq = 0
const inbound = ({ from, name, text, referral, phoneNumberId = 'pipeline-phone-id' }) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ profile: { name }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.IN.${++msgSeq}`,
                timestamp: '1',
                type: 'text',
                text: { body: text },
                ...(referral ? { referral } : {}),
              },
            ],
          },
        },
      ],
    },
  ],
})

const postWebhook = (payload) => {
  const raw = JSON.stringify(payload)
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex'),
    },
    body: raw,
  })
}

async function until(fn, what = 'condition', timeoutMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const leadByWaId = async (waId) =>
  (await query('SELECT * FROM leads WHERE wa_id = $1 ORDER BY id DESC', [waId])).rows[0] || null
const messagesFor = async (leadId) =>
  (await query('SELECT * FROM messages WHERE lead_id = $1 ORDER BY id', [leadId])).rows
// Counted across every lead for the number, not one lead id — otherwise a routing
// bug that split the sender into two leads would look like a hang, not a failure.
const buyerMessagesForWaId = async (waId) =>
  (
    await query(
      `SELECT m.* FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE l.wa_id = $1 AND m.role = 'buyer' ORDER BY m.id`,
      [waId],
    )
  ).rows
const leadsForWaId = async (waId) => (await query('SELECT * FROM leads WHERE wa_id = $1', [waId])).rows
const activityFor = async (leadId) =>
  (await query('SELECT * FROM activity WHERE lead_id = $1 ORDER BY id', [leadId])).rows
const labelsFor = async (leadId) =>
  (
    await query(
      `SELECT l.name FROM lead_labels ll JOIN labels l ON l.id = ll.label_id WHERE ll.lead_id = $1`,
      [leadId],
    )
  ).rows.map((r) => r.name)

// Waits for the AI turn to land in the transcript (the webhook acks Meta first).
const untilAiReply = (leadId) =>
  until(async () => (await messagesFor(leadId)).find((m) => m.role === 'ai'), 'the AI reply')

// The pipeline finishes in stages after the ack, so every assertion about a later
// stage has to wait for that stage — not for an earlier one that happens to be close.
const untilActivity = (leadId, re, what = String(re)) =>
  until(async () => (await activityFor(leadId)).find((a) => re.test(a.text)), what)

// --- The AI auto-reply --------------------------------------------------------

test('an inbound message gets an AI reply, sent on WhatsApp and mirrored in the thread', async () => {
  ai.reply = 'Happy to help — I have three 2 BHKs in Baner in your range.'
  await postWebhook(inbound({ from: '919740010001', name: 'Asha', text: 'Looking for a 2 BHK in Baner' }))

  const lead = await until(() => leadByWaId('919740010001'), 'the lead')
  const reply = await untilAiReply(lead.id)
  assert.equal(reply.text, 'Happy to help — I have three 2 BHKs in Baner in your range.')
  assert.ok(reply.wa_message_id, 'the reply carries the id the Graph API returned')

  assert.equal(waSends.length, 1, 'exactly one outbound send')
  assert.equal(waSends[0].body.to, '919740010001')
  assert.equal(waSends[0].body.text.body, reply.text)

  // first_response_s is what the dashboard reports as response time. It is stamped
  // just after the reply is stored, so wait for it rather than for the message.
  await until(
    async () => (await leadByWaId('919740010001')).first_response_s != null,
    'the first-response clock to stop',
  )
})

test('an EMI question is answered without an AI round-trip at all', async () => {
  await postWebhook(
    inbound({ from: '919740010002', name: 'Ravi', text: 'EMI for 50 lakh loan at 9% for 20 years?' }),
  )
  const lead = await until(() => leadByWaId('919740010002'), 'the lead')
  const reply = await untilAiReply(lead.id)
  assert.match(reply.text, /EMI/i)
  assert.ok(!aiCalls.some((c) => !c.wantsJson), 'the conversational model was never called')
})

test('when the model returns nothing, no empty message is sent or stored', async () => {
  ai.reply = null
  await postWebhook(inbound({ from: '919740010003', name: 'Quiet', text: 'hmm' }))
  const lead = await until(() => leadByWaId('919740010003'), 'the lead')
  // Give the pipeline a beat to finish; the assertion is that nothing appeared.
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!(await messagesFor(lead.id)).some((m) => m.role === 'ai'), 'no blank AI turn')
  assert.equal(waSends.length, 0, 'nothing was sent')
})

test('a failed AI provider degrades to no reply rather than an error', async () => {
  ai.reply = 'fail'
  const realError = console.error
  console.error = () => {}
  try {
    const res = await postWebhook(inbound({ from: '919740010004', name: 'Down', text: 'is it available?' }))
    assert.equal(res.status, 200, 'Meta is still acked')
    const lead = await until(() => leadByWaId('919740010004'), 'the lead')
    await new Promise((r) => setTimeout(r, 300))
    assert.ok((await messagesFor(lead.id)).some((m) => m.role === 'buyer'), 'the buyer message is still kept')
    assert.ok(!(await messagesFor(lead.id)).some((m) => m.role === 'ai'))
  } finally {
    console.error = realError
  }
})

// --- When the Graph API refuses the reply -------------------------------------

test('an expired WhatsApp token is logged against the lead by name, and the reply is still kept', async () => {
  wa = 'token-expired'
  const realError = console.error
  console.error = () => {}
  try {
    await postWebhook(inbound({ from: '919740010005', name: 'Tokentrouble Tara', text: 'still interested' }))
    const lead = await until(() => leadByWaId('919740010005'), 'the lead')
    const reply = await untilAiReply(lead.id)
    assert.equal(reply.wa_message_id, null, 'nothing was delivered, so there is no wamid')

    await untilActivity(lead.id, /token expired/i, 'the token-expiry note')
    const errors = (await activityFor(lead.id)).filter((a) => a.kind === 'error')
    assert.equal(errors.length, 1)
    assert.match(errors[0].text, /Tokentrouble Tara/, 'named so the agent knows who to chase')
  } finally {
    console.error = realError
  }
})

test('any other send failure is logged as a plain send failure', async () => {
  wa = 'rejected'
  const realError = console.error
  console.error = () => {}
  try {
    await postWebhook(inbound({ from: '919740010006', name: 'Rejected Raj', text: 'hello' }))
    const lead = await until(() => leadByWaId('919740010006'), 'the lead')
    await untilAiReply(lead.id)
    await untilActivity(lead.id, /send failed/i, 'the send-failure note')
    const errors = (await activityFor(lead.id)).filter((a) => a.kind === 'error')
    assert.equal(errors.length, 1)
    assert.ok(!/token expired/i.test(errors[0].text), 'not misreported as a credentials problem')
  } finally {
    console.error = realError
  }
})

// --- Extraction ---------------------------------------------------------------

test('an extraction that turns a lead Hot logs it and applies the Hot label', async () => {
  ai.extraction = { temp: 'Hot', score: 92, intent: 'buy', bhk: '3', preferred_localities: ['Baner'] }
  await postWebhook(inbound({ from: '919740020001', name: 'Hot Harsha', text: 'ready to book this week' }))

  const lead = await until(() => leadByWaId('919740020001'), 'the lead')
  await untilActivity(lead.id, /is now HOT \(score 92\)/, 'the Hot alert')

  const hot = (await activityFor(lead.id)).filter((a) => a.kind === 'hot')
  assert.equal(hot.length, 1)
  await until(async () => (await labelsFor(lead.id)).includes('Hot'), 'the Hot label')
})

test('a re-score on an already-known lead is logged as a re-score, not a fresh Hot alert', async () => {
  ai.extraction = { temp: 'Warm', score: 55, intent: 'buy' }
  await postWebhook(inbound({ from: '919740020002', name: 'Warm Wasim', text: 'just looking for now' }))
  const lead = await until(() => leadByWaId('919740020002'), 'the lead')
  await untilActivity(lead.id, /re-scored: 55\/100/, 'the re-score note')

  const kinds = (await activityFor(lead.id)).map((a) => a.kind)
  assert.ok(kinds.includes('ai'), 're-score is an ai activity')
  assert.ok(!kinds.includes('hot'), 'a Warm lead raises no Hot alert')
})

test('a buyer who identifies as a broker is labelled as one', async () => {
  ai.extraction = { intent: 'broker', temp: 'Cold', score: 15 }
  await postWebhook(inbound({ from: '919740020003', name: 'Broker Bala', text: 'I am a channel partner, do you co-broke?' }))
  const lead = await until(() => leadByWaId('919740020003'), 'the lead')
  await until(async () => (await labelsFor(lead.id)).includes('Broker'), 'the Broker label')
  assert.ok((await labelsFor(lead.id)).includes('Broker'))
})

// --- Click-to-WhatsApp attribution --------------------------------------------

test('a click-to-WhatsApp lead records the referral, the source event and the ad headline', async () => {
  await postWebhook(
    inbound({
      from: '919740030001',
      name: 'Ad Anaya',
      text: 'saw your ad',
      referral: {
        ctwa_clid: 'ctwa-abc-123',
        source_type: 'ad',
        source_id: 'ad-9001',
        headline: '2 BHK in Baner from ₹85L',
        source_url: 'https://fb.me/ad',
      },
    }),
  )
  const lead = await until(() => leadByWaId('919740030001'), 'the lead')
  await until(async () => (await leadByWaId('919740030001')).free_entry_at, 'the 72h free window to open')

  const ctwa = await untilActivity(lead.id, /Click-to-WhatsApp lead/, 'the ad-origin note')
  assert.match(ctwa.text, /"2 BHK in Baner from ₹85L"/, 'the headline tells the agent which ad')

  const events = (await query('SELECT * FROM lead_source_events WHERE lead_id = $1', [lead.id])).rows
  assert.equal(events.length, 1)
  assert.equal(events[0].channel, 'ctwa')
  assert.equal(events[0].external_id, 'ctwa-abc-123')
})

test('a returning click-to-WhatsApp sender re-opens the window without a second source event', async () => {
  const referral = { ctwa_clid: 'ctwa-repeat', source_type: 'ad', source_id: 'ad-9002' }
  await postWebhook(inbound({ from: '919740030002', name: 'Repeat Rhea', text: 'first touch', referral }))
  const lead = await until(() => leadByWaId('919740030002'), 'the lead')
  await until(async () => (await leadByWaId('919740030002')).free_entry_at, 'the first window')

  await postWebhook(inbound({ from: '919740030002', name: 'Repeat Rhea', text: 'second touch', referral }))
  await until(async () => (await buyerMessagesForWaId('919740030002')).length === 2, 'both messages', 15000)

  const events = (await query('SELECT * FROM lead_source_events WHERE lead_id = $1', [lead.id])).rows
  assert.equal(events.length, 1, 'the lead is attributed once, not once per message')
  const ctwaNotes = (await activityFor(lead.id)).filter((a) => /Click-to-WhatsApp lead/.test(a.text))
  assert.equal(ctwaNotes.length, 1)
})

// --- Routing ------------------------------------------------------------------

test('a known contact on a shared number routes to the agent who saved them', async () => {
  const other = await createAgent('Shared Sneha', '+919740000002', null, hashPassword('secret123'))
  await addContact(other.id, '919740040001', 'Their Client')

  // No agent owns this line, so the shared-number fallback decides.
  await postWebhook(
    inbound({ from: '919740040001', name: 'Profile Name', text: 'hi', phoneNumberId: 'unowned-line' }),
  )
  const lead = await until(() => leadByWaId('919740040001'), 'the lead')
  assert.equal(lead.agent_id, other.id, 'routed by the saved contact, not left unassigned')
  assert.equal(lead.name, 'Their Client', 'the agent’s own name for them wins over the WhatsApp profile name')
})

test('an unknown sender on a shared number lands in the unassigned pool', async () => {
  await postWebhook(
    inbound({ from: '919740040002', name: 'Stranger Sam', text: 'is this HomeNex?', phoneNumberId: 'unowned-line' }),
  )
  const lead = await until(() => leadByWaId('919740040002'), 'the lead')
  assert.equal(lead.agent_id, null, 'claimable by anyone in the workspace')
  await untilActivity(lead.id, /Unclaimed lead/, 'the unclaimed-lead note')
})

test('a round-robin team hands a new sender to the next member, then keeps them there', async () => {
  const owner = await createAgent('Team Lead Tanvi', '+919740000003', null, hashPassword('secret123'))
  const member = await createAgent('Team Member Manav', '+919740000004', null, hashPassword('secret123'))
  const team = await createTeam(owner.id, 'Rotation Realty')
  await query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [team.id, member.id, 'agent'])
  await updateTeam(team.id, { assignment_strategy: 'round_robin' })
  await query('UPDATE agents SET wa_phone_number_id = $2 WHERE id = $1', [owner.id, 'team-line'])

  await postWebhook(inbound({ from: '919740050001', name: 'Rotated Riya', text: 'hello', phoneNumberId: 'team-line' }))
  const lead = await until(() => leadByWaId('919740050001'), 'the lead')
  assert.ok([owner.id, member.id].includes(lead.agent_id), 'assigned to someone on the team')

  // A second message from the same sender must not bounce them to another member.
  await postWebhook(inbound({ from: '919740050001', name: 'Rotated Riya', text: 'still there?', phoneNumberId: 'team-line' }))
  await until(async () => (await buyerMessagesForWaId('919740050001')).length === 2, 'both messages', 15000)

  const leads = await leadsForWaId('919740050001')
  assert.equal(leads.length, 1, 'a returning sender does not become a second lead')
  assert.equal(leads[0].id, lead.id)
  assert.equal(leads[0].agent_id, lead.agent_id, 'and stays with the member who already owns them')
})

// --- Agent-facing AI surfaces -------------------------------------------------

test('reply suggestions come back for a real thread and degrade to an empty list on failure', async () => {
  await postWebhook(inbound({ from: '919740060001', name: 'Suggest Sia', text: 'what is the carpet area?' }))
  const lead = await until(() => leadByWaId('919740060001'), 'the lead')
  await untilAiReply(lead.id)

  ai.reply = '1. Sure, sharing now\n2. It is 980 sq ft\n3. Want a site visit?'
  const good = await json('GET', `/api/leads/${lead.id}/suggestions`)
  assert.ok(Array.isArray(good.suggestions))

  ai.reply = 'fail'
  const realError = console.error
  console.error = () => {}
  try {
    const degraded = await json('GET', `/api/leads/${lead.id}/suggestions`)
    assert.deepEqual(degraded.suggestions, [], 'the composer shows no chips rather than an error')
  } finally {
    console.error = realError
  }
})

test('autofill reads the stored extraction, and ?fresh=1 re-runs it', async () => {
  ai.extraction = { temp: 'Warm', score: 60, intent: 'buy', bhk: '2', timeline: '3 months' }
  await postWebhook(inbound({ from: '919740060002', name: 'Fill Farida', text: 'need a 2 BHK in 3 months' }))
  const lead = await until(() => leadByWaId('919740060002'), 'the lead')
  await until(async () => (await leadByWaId('919740060002')).ai_extracted, 'the stored extraction')

  const stored = await json('GET', `/api/leads/${lead.id}/autofill`)
  assert.ok(Array.isArray(stored.suggestions))

  ai.extraction = { temp: 'Hot', score: 90, intent: 'buy', bhk: '3' }
  const fresh = await json('GET', `/api/leads/${lead.id}/autofill?fresh=1`)
  assert.ok(
    fresh.suggestions.some((s) => s.field === 'bhk' && String(s.suggested) === '3'),
    `the re-run wins, got ${JSON.stringify(fresh.suggestions)}`,
  )

  // A failing re-run falls back to the stored extraction instead of erroring.
  ai.extraction = 'fail'
  const realError = console.error
  console.error = () => {}
  try {
    const res = await req('GET', `/api/leads/${lead.id}/autofill?fresh=1`)
    assert.equal(res.status, 200)
    assert.ok(Array.isArray((await res.json()).suggestions))
  } finally {
    console.error = realError
  }
})

test('the AI surfaces 404 on a lead that is not the caller’s', async () => {
  const stranger = await createAgent('Stranger Sunita', '+919740000005', null, hashPassword('secret123'))
  const lead = (await query('SELECT id FROM leads WHERE agent_id = $1 LIMIT 1', [stranger.id])).rows[0]
  assert.equal(lead, undefined, 'the stranger has no leads of their own')
  assert.equal((await req('GET', `/api/leads/999999/autofill`)).status, 404)
  assert.equal((await req('GET', `/api/leads/999999/suggestions`)).status, 404)
})
