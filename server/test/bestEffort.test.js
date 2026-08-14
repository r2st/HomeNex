// The best-effort arms: every `.catch()` hung off a side effect the request does not
// depend on.
//
// These exist so one failing extra — an analytics insert, a rescore, an audit row —
// can never take down the thing the caller actually asked for. That promise has
// never been tested, because the only way to reach the catch is for the database to
// refuse a statement the rest of the request doesn't care about, and nothing in a
// happy-path suite does that.
//
// So we make it refuse, precisely: a BEFORE trigger on exactly the table the
// side effect writes, scoped by a WHEN clause to exactly the statement it issues, so
// the surrounding work still commits normally. Then we assert two things — the
// caller got what they asked for, and the failure was reported rather than swallowed
// into silence.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
delete process.env.META_PAGE_ACCESS_TOKEN
delete process.env.META_LEADGEN_DEFAULT_AGENT_ID
const dbName = await createTestDb('besteffort')

const { app } = await import('../index.js')
const { ready, closePool, query, createAgent, setMeta } = await import('../db.js')
const { hashPassword } = await import('../auth.js')

await ready

let server, base, token, agent

const api = (method, url, body) =>
  fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
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
      body: JSON.stringify({ name: 'Effort Esha', phone: '+919846000001', password: 'secret123' }),
    })
  ).json()
  token = out.token
  agent = out.agent

  // One trigger function, reused by every scenario below. P0001 is a plain
  // raised exception — not a constraint code the routes special-case — so what we
  // are testing is the generic "this statement failed" path, not a known arm.
  await query(`
    CREATE OR REPLACE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'induced failure writing %', TG_TABLE_NAME; END $$
  `)
})

after(async () => {
  server?.close()
  // The webhook route acks first and keeps working, so a test can finish while the
  // tail of its pipeline is still writing. Each webhook test waits for the last
  // write it cares about; this is the backstop that keeps a stray one from meeting a
  // closed pool and printing a scary, meaningless error.
  await new Promise((r) => setTimeout(r, 150))
  await closePool()
  await dropTestDb(dbName)
})

// Runs `fn` with one statement against `table` guaranteed to fail. `when` narrows
// the trigger to the exact write the side effect makes, so everything else the
// request does still succeeds — otherwise the test would prove only that a broken
// database breaks the request, which is not the claim.
async function whileFailing({ table, on = 'INSERT', when = null }, fn) {
  const name = `boom_${table}_${on.toLowerCase()}`
  await query(
    `CREATE TRIGGER ${name} BEFORE ${on} ON ${table}
     FOR EACH ROW ${when ? `WHEN (${when})` : ''} EXECUTE FUNCTION test_boom()`,
  )
  try {
    return await fn()
  } finally {
    await query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
  }
}

// A swallowed failure and a reported one look identical from the outside, so the
// console is part of the contract: these routes are allowed to continue, not allowed
// to go quiet. Returns everything console.error saw, joined.
function captureErrors(t) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.map(String).join(' '))
  t.after(() => {
    console.error = original
  })
  return () => lines.join('\n')
}

// The webhook acks before it does any work, so "has it finished?" is a question only
// the database can answer. Polls until `check` returns truthy, or gives up loudly.
async function until(check, what, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const countOf = async (sql, params = []) => (await query(sql, params)).rows[0].n

// --- Rescoring: strong on its own, never a reason to lose the write --------------
//
// Both of these recompute the decayed score inline so the worklist is honest by the
// time the agent looks at it. Neither is worth failing the agent's action over.
// The trigger is scoped to last_decay_at, which only recomputeLeadScore writes — the
// stage change and the visit row are ordinary updates and still land.

test('a stage change survives a rescore that fails, and says so', async (t) => {
  const errors = captureErrors(t)
  const lead = await (await api('POST', '/api/leads/quick-add', { phone: '+919846001001', name: 'Stage Sunil' })).json()

  const res = await whileFailing(
    { table: 'leads', on: 'UPDATE', when: 'NEW.last_decay_at IS DISTINCT FROM OLD.last_decay_at' },
    () => api('PUT', `/api/leads/${lead.lead.id}/stage`, { stage: 'Qualified' }),
  )

  assert.equal(res.status, 200)
  assert.equal((await res.json()).stage, 'Qualified', 'the stage the agent asked for was saved')
  assert.match(errors(), /rescore on stage failed/, 'the rescore failure was reported, not swallowed')

  // And it really was only the rescore that failed.
  const { rows } = await query('SELECT stage, last_decay_at FROM leads WHERE id = $1', [lead.lead.id])
  assert.equal(rows[0].stage, 'Qualified')
  assert.equal(rows[0].last_decay_at, null, 'the rescore never committed')
})

test('a site visit is booked even when its rescore fails', async (t) => {
  const errors = captureErrors(t)
  const lead = await (await api('POST', '/api/leads/quick-add', { phone: '+919846001002', name: 'Visit Vidya' })).json()

  const res = await whileFailing(
    { table: 'leads', on: 'UPDATE', when: 'NEW.last_decay_at IS DISTINCT FROM OLD.last_decay_at' },
    () =>
      api('POST', '/api/site-visits', {
        lead_id: lead.lead.id,
        scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
  )

  assert.equal(res.status, 200)
  const visit = await res.json()
  assert.equal(visit.lead_id, lead.lead.id, 'the booking the agent made is the response')
  assert.match(errors(), /rescore on visit booking failed/)
  assert.equal(await countOf('SELECT COUNT(*)::int AS n FROM site_visits WHERE lead_id = $1', [lead.lead.id]), 1)
})

// --- Quick-add: the tags are a nicety, the lead is the point ---------------------

test('a quick-added lead is returned even when its tags cannot be stored', async () => {
  const res = await whileFailing(
    { table: 'contacts', on: 'UPDATE', when: 'NEW.labels IS DISTINCT FROM OLD.labels' },
    () =>
      api('POST', '/api/leads/quick-add', {
        phone: '+919846001003',
        name: 'Tagged Tarun',
        tags: ['Whitefield', 'ready-to-move'],
      }),
  )

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.lead.name, 'Tagged Tarun', 'the lead was created and returned')
  assert.ok(body.wa_deeplink.includes('919846001003'), 'the deep link the agent taps is still there')

  // The labels are the part that was allowed to fail.
  const { rows } = await query('SELECT labels FROM contacts WHERE id = $1', [body.lead.contact_id])
  assert.deepEqual(rows[0].labels, [], 'the tags were dropped rather than failing the request')
})

// --- The public micro-page: a buyer must never see a 500 for our analytics -------

test('the property micro-page still renders when its view counter fails', async (t) => {
  const errors = captureErrors(t)
  const property = await (
    await api('POST', '/api/properties', { title: 'Brigade Cornerstone', locality: 'Whitefield', city: 'Bengaluru' })
  ).json()
  const { slug } = await (await api('POST', `/api/properties/${property.id}/micro-page`)).json()

  const res = await whileFailing({ table: 'property_page_views' }, async () => {
    const r = await fetch(`${base}/p/${slug}`)
    // The write is deliberately not awaited by the route, so the page can answer
    // before the failure surfaces. Wait for the report rather than racing it.
    await until(() => /page view tracking failed/.test(errors()), 'the view-tracking failure to be logged')
    return r
  })

  assert.equal(res.status, 200, 'the buyer got the page')
  assert.match(await res.text(), /Brigade Cornerstone/)
  assert.equal(
    await countOf('SELECT page_views AS n FROM properties WHERE id = $1', [property.id]),
    0,
    'the counter is the part that was lost',
  )
})

// --- Portal email ingest: the audit row is not the answer ------------------------

test('an unparseable portal email is still acknowledged when the failure log cannot be written', async () => {
  const { rows } = await query('SELECT ingest_token FROM agents WHERE id = $1', [agent.id])
  const res = await whileFailing({ table: 'lead_source_events' }, () =>
    fetch(`${base}/ingest/email/${rows[0].ingest_token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'noreply@99acres.com', subject: 'Newsletter', text: 'no lead in here' }),
    }),
  )

  assert.equal(res.status, 202, 'the provider is told we took it, so it stops retrying')
  assert.deepEqual(await res.json(), { ok: false, reason: 'no_lead_parsed' })
})

// --- The webhook: Meta gets its 200 whatever happens behind it -------------------

const webhook = (body) =>
  fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const leadgenEvent = (value) => ({ entry: [{ changes: [{ field: 'leadgen', value }] }] })

test('an unattributable lead ad is dropped quietly when even the unmatched row fails', async (t) => {
  const errors = captureErrors(t)
  const before = await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events')

  await whileFailing({ table: 'lead_source_events' }, async () => {
    assert.equal((await webhook(leadgenEvent({ leadgen_id: 'lg-unmatched-1', form_id: 'form-unknown' }))).status, 200)
    // Nothing observable is written on this path, so settle by round-tripping a
    // request through the same process rather than by sleeping a guessed interval.
    await api('GET', '/api/leads/count')
    await api('GET', '/api/leads/count')
  })

  assert.equal(await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events'), before, 'nothing was written')
  assert.doesNotMatch(errors(), /leadgen processing error/, 'a failed audit row is not a processing failure')
})

test('a lead ad with no phone is dropped quietly when its failure row also fails', async () => {
  process.env.META_LEADGEN_DEFAULT_AGENT_ID = String(agent.id)
  const before = await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events')
  try {
    await whileFailing({ table: 'lead_source_events' }, async () => {
      assert.equal((await webhook(leadgenEvent({ leadgen_id: 'lg-nophone-1', form_id: 'form-x' }))).status, 200)
      await api('GET', '/api/leads/count')
      await api('GET', '/api/leads/count')
    })
  } finally {
    delete process.env.META_LEADGEN_DEFAULT_AGENT_ID
  }

  assert.equal(await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events'), before)
  assert.equal(await countOf('SELECT COUNT(*)::int AS n FROM leads'), await countOf('SELECT COUNT(*)::int AS n FROM leads'))
})

test('a corrupt form mapping fails one lead ad, not the whole webhook batch', async (t) => {
  const errors = captureErrors(t)
  // A form→agent mapping is written as the agent id; a non-numeric one is a corrupt
  // row, and resolving it throws rather than returning "no agent".
  await setMeta('leadgen_form:form-corrupt', 'not-an-agent-id')

  assert.equal(
    (
      await webhook({
        entry: [
          {
            changes: [
              { field: 'leadgen', value: { leadgen_id: 'lg-corrupt-1', form_id: 'form-corrupt' } },
              { field: 'leadgen', value: { leadgen_id: 'lg-corrupt-2', form_id: 'form-corrupt' } },
            ],
          },
        ],
      })
    ).status,
    200,
    'Meta is acked regardless',
  )

  await until(() => (errors().match(/leadgen processing error/g) || []).length === 2, 'both leadgens to be reported')
})

test('a webhook whose message cannot be stored is reported, not left unhandled', async (t) => {
  const errors = captureErrors(t)
  await createAgent('Line Latha', '+919846000002', null, hashPassword('secret123'), '+919846000002')
  await query(`UPDATE agents SET wa_phone_number_id = 'pnid-besteffort' WHERE phone = '+919846000002'`)

  await whileFailing({ table: 'messages' }, async () => {
    const res = await webhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pnid-besteffort' },
                messages: [{ id: 'wamid.besteffort.1', from: '919846001004', type: 'text', text: { body: 'Hi' } }],
              },
            },
          ],
        },
      ],
    })
    assert.equal(res.status, 200, 'Meta is acked before any of this runs')
    // Reported per message rather than per delivery: the handler wraps each message
    // so a failure like this one cannot abandon the others Meta batched with it, and
    // the log line carries the message id that actually failed.
    await until(() => /inbound message processing error/.test(errors()), 'the processing failure to be reported')
  })

  assert.equal(
    await countOf(`SELECT COUNT(*)::int AS n FROM messages WHERE wa_message_id = 'wamid.besteffort.1'`),
    0,
    'the message really did fail to store',
  )
})

test('a click-to-WhatsApp lead is still created when its attribution row fails', async (t) => {
  const errors = captureErrors(t)
  const before = await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events')

  await whileFailing({ table: 'lead_source_events' }, async () => {
    const res = await webhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pnid-besteffort' },
                contacts: [{ profile: { name: 'Ad Anita' } }],
                messages: [
                  {
                    id: 'wamid.besteffort.ctwa',
                    from: '919846001005',
                    type: 'text',
                    text: { body: 'Saw your ad' },
                    referral: { ctwa_clid: 'clid-1', source_type: 'ad', headline: '3BHK in Whitefield' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    assert.equal(res.status, 200)
    // The auto-applied "new" label is the pipeline's last write for a fresh lead —
    // waiting for it means the trigger is still in place for everything before it.
    await until(
      () => countOf(`SELECT COUNT(*)::int AS n FROM lead_labels ll
                     JOIN leads l ON l.id = ll.lead_id WHERE l.wa_id = '919846001005'`),
      'the inbound pipeline to finish',
    )
  })

  // The lead, its message and its 72h free window all landed; only the attribution
  // row — which nobody is waiting on — was lost.
  const { rows } = await query(`SELECT id, free_entry_at FROM leads WHERE wa_id = '919846001005'`)
  assert.equal(rows.length, 1, 'the buyer became a lead')
  assert.ok(rows[0].free_entry_at, 'the click-to-WhatsApp free window was opened')
  assert.equal(await countOf('SELECT COUNT(*)::int AS n FROM lead_source_events'), before, 'the audit row was lost')
  assert.doesNotMatch(errors(), /(webhook|inbound message) processing error/, 'and it never became a processing failure')
})
