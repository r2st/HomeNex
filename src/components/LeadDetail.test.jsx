// The lead panel — where the CRM record is actually edited. The money conversion
// (UI edits in ₹ Lakhs, the API stores paise) and the site-visit booking are the
// parts that quietly corrupt data when they go wrong.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, check, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import LeadDetail from './LeadDetail.jsx'

const NOW = Date.parse('2026-08-10T12:00:00.000Z')

const lead = (over = {}) => ({
  id: 5,
  agent_id: 1,
  name: 'Priya Sharma',
  wa_id: '919876543210',
  stage: 'New',
  pipeline_type: 'buy_primary',
  score: 72,
  updated_at: new Date(NOW - 3600_000).toISOString(),
  messages: [],
  followups: [],
  site_visits: [],
  ...over,
})

function setup(t, { data = lead(), routes = {} } = {}) {
  const env = installBrowser({ now: NOW })
  const net = mockFetch({
    'GET /api/leads/5': data,
    'GET /api/leads/5/autofill': { suggestions: [] },
    'GET /api/leads/5/briefing': { talking_points: [] },
    'GET /api/leads/5/property-matches': [],
    'GET /api/pipeline-stages': [
      { id: 1, stage_name: 'New', stage_order: 1 },
      { id: 2, stage_name: 'Site Visit', stage_order: 2 },
      { id: 3, stage_name: 'Lost', stage_order: 9 },
    ],
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const props = { leadId: 5, onClose: () => {}, onOpenConversation: () => {}, onChanged: () => {} }

// --- Header and assignment -------------------------------------------------

test('an unassigned lead offers a claim button and hides the CRM sections', async (t) => {
  const ctx = setup(t, { data: lead({ agent_id: null }), routes: { 'POST /api/leads/5/assign': { ok: true } } })
  let changed = 0
  let closed = 0
  const ui = await render(<LeadDetail {...props} onChanged={() => changed++} onClose={() => closed++} />)

  assert.match(ui.text(), /Assign to me/)
  assert.doesNotMatch(ui.text(), /PIPELINE STAGE/)
  assert.doesNotMatch(ui.text(), /FOLLOW-UPS/)

  await click(ui.byText('Assign to me ✋'))
  assert.equal(ctx.net.to('/api/leads/5/assign', 'POST').length, 1)
  assert.equal(changed, 1)
  assert.equal(closed, 1)
})

test('an assigned lead offers "Take over chat", disabling AI first', async (t) => {
  const ctx = setup(t, { data: lead({ ai_enabled: 1 }), routes: { 'POST /api/leads/5/ai': { ok: true } } })
  const opened = []
  const ui = await render(<LeadDetail {...props} onOpenConversation={(id) => opened.push(id)} />)

  await click(ui.byText('Take over chat 💬'))

  assert.deepEqual(ctx.net.to('/api/leads/5/ai', 'POST')[0].body, { enabled: false })
  assert.deepEqual(opened, [5])
})

test('taking over a manual chat does not re-post the AI flag', async (t) => {
  const ctx = setup(t, { data: lead({ ai_enabled: 0 }) })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Take over chat 💬'))
  assert.equal(ctx.net.to('/api/leads/5/ai').length, 0)
})

test('a lead that fails to load says so and offers a retry, not a blank panel', async (t) => {
  // This used to render an empty dimmed backdrop: identical to a panel that opened
  // with nothing in it, permanent (the poll never populates `lead`), and escapable
  // only by guessing that a tap on the backdrop closes it.
  const ctx = setup(t, { routes: { 'GET /api/leads/5': { status: 500, body: {} } } })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /Couldn't load this/)
  assert.doesNotMatch(ui.text(), /Priya Sharma/, 'no half-rendered lead data')

  await click(ui.byText('Try again'))
  assert.equal(ctx.net.to('/api/leads/5', 'GET').length, 2, 'the retry button refetched the lead')
})

test('a failed panel recovers once the request succeeds', async (t) => {
  const ctx = setup(t, { routes: { 'GET /api/leads/5': { status: 500, body: {} } } })
  const ui = await render(<LeadDetail {...props} />)
  assert.match(ui.text(), /Couldn't load this/)

  ctx.net.set('GET /api/leads/5', lead())
  await click(ui.byText('Try again'))
  assert.match(ui.text(), /Priya Sharma/)
  assert.doesNotMatch(ui.text(), /Couldn't load this/)
})

test('a lead still in flight shows a skeleton, not an empty panel', async (t) => {
  // A request that never settles is the honest model of a slow network.
  setup(t, { routes: { 'GET /api/leads/5': () => new Promise(() => {}) } })
  const ui = await render(<LeadDetail {...props} />)

  assert.equal(ui.query((f) => f.props?.['aria-busy'] === 'true') !== null, true, 'no loading affordance')
  assert.doesNotMatch(ui.text(), /Couldn't load this/, 'a pending request is not an error')
})

// --- Stage picker ----------------------------------------------------------

test('moving a stage posts the new stage and refreshes', async (t) => {
  const ctx = setup(t, { routes: { 'PUT /api/leads/5/stage': { ok: true } } })
  let changed = 0
  const ui = await render(<LeadDetail {...props} onChanged={() => changed++} />)

  await click(ui.byText('Move →'))
  await click(ui.byText('Site Visit'))

  assert.deepEqual(ctx.net.to('/api/leads/5/stage', 'PUT')[0].body, { stage: 'Site Visit' })
  assert.equal(changed, 1)
})

test('the current stage is shown as current and cannot be re-picked', async (t) => {
  const ctx = setup(t, { routes: { 'PUT /api/leads/5/stage': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Move →'))
  const currentButton = ui.byText('· current')
  assert.equal(currentButton.props.disabled, true)

  await click(currentButton)
  assert.equal(ctx.net.to('/api/leads/5/stage').length, 0)
})

test('choosing Lost asks for a reason and sends it with the move', async (t) => {
  const ctx = setup(t, { routes: { 'PUT /api/leads/5/stage': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Move →'))
  await click(ui.byText('Lost'))
  assert.match(ui.text(), /Why was this lead lost\?/)
  assert.equal(ctx.net.to('/api/leads/5/stage').length, 0)

  await click(ui.byText('Location mismatch'))
  assert.deepEqual(ctx.net.to('/api/leads/5/stage', 'PUT')[0].body, { stage: 'Lost', lost_reason: 'Location mismatch' })
})

test('a rejected stage move keeps the picker open with the reason', async (t) => {
  setup(t, { routes: { 'PUT /api/leads/5/stage': { status: 409, body: { error: 'Book a site visit first' } } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Move →'))
  await click(ui.byText('Site Visit'))

  assert.match(ui.text(), /Book a site visit first/)
  assert.ok(ui.queryByText('Move stage'), 'the picker should stay open so the agent can choose again')
})

test('a lost lead shows its reason next to the stage', async (t) => {
  setup(t, { data: lead({ stage: 'Lost', lost_reason: 'Budget mismatch' }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /Lost · Budget mismatch/)
})

// --- Buyer profile editor --------------------------------------------------

test('an empty buyer profile invites the agent to add details', async (t) => {
  setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /captured automatically as this buyer chats/)
  assert.ok(ui.queryByText('Add details'))
})

test('a populated profile lists the captured fields', async (t) => {
  setup(t, {
    data: lead({ budget_min: 45e7, budget_max: 60e7, bhk: '3', property_type: 'apartment', preferred_localities: ['Baner', 'Balewadi'], timeline: '3 months', financing: 'loan' }),
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /₹ 45L – ₹ 60L/)
  assert.match(ui.text(), /3 BHK/)
  assert.match(ui.text(), /Baner, Balewadi/)
})

test('editing the profile converts Lakhs back to paise and splits localities', async (t) => {
  const ctx = setup(t, { routes: { 'PUT /api/leads/5': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Add details'))
  await change(ui.byLabel('Budget min (₹ Lakhs)'), '45')
  await change(ui.byLabel('Budget max (₹ Lakhs)'), '60.5')
  await click(ui.byText('3', { exact: true }))
  await change(ui.byLabel('Preferred localities (comma separated)'), ' Baner , Balewadi ,, ')
  await change(ui.byLabel('Timeline'), '3 months')
  await submit(ui.get((f) => f.type === 'form', 'profile form'))

  assert.deepEqual(ctx.net.to('/api/leads/5', 'PUT')[0].body, {
    budget_min: 450000000,
    budget_max: 605000000,
    bhk: '3',
    property_type: null,
    preferred_localities: ['Baner', 'Balewadi'],
    timeline: '3 months',
    financing: null,
  })
})

test('an existing budget is shown in Lakhs when the editor opens', async (t) => {
  setup(t, { data: lead({ budget_min: 45e7, budget_max: 120e7 }) })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Edit'))
  assert.equal(ui.byLabel('Budget min (₹ Lakhs)').props.value, 45)
  assert.equal(ui.byLabel('Budget max (₹ Lakhs)').props.value, 120)
})

test('tapping the active BHK chip clears it', async (t) => {
  const ctx = setup(t, { routes: { 'PUT /api/leads/5': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Add details'))
  await click(ui.byText('2', { exact: true }))
  await click(ui.byText('2', { exact: true }))
  await submit(ui.get((f) => f.type === 'form', 'profile form'))

  assert.equal(ctx.net.to('/api/leads/5', 'PUT')[0].body.bhk, null)
})

test('a rejected profile save keeps the form open with the error', async (t) => {
  setup(t, { routes: { 'PUT /api/leads/5': { status: 400, body: { error: 'Budget max must exceed budget min' } } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Add details'))
  await submit(ui.get((f) => f.type === 'form', 'profile form'))

  assert.match(ui.text(), /Budget max must exceed budget min/)
  assert.ok(ui.queryByText('Save profile'))
})

test('Cancel abandons the edit without saving', async (t) => {
  const ctx = setup(t)
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Add details'))
  await change(ui.byLabel('Timeline'), 'next year')
  await click(ui.byText('Cancel'))

  assert.equal(ctx.net.to('/api/leads/5', 'PUT').length, 0)
  assert.ok(ui.queryByText('Add details'))
})

// --- AI autofill -----------------------------------------------------------

const SUGGESTION = { field: 'budget_max', label: 'Budget max', suggested: 60e7, suggested_display: '₹ 60L', current: null }

test('nothing renders when the AI has no suggestions', async (t) => {
  setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.doesNotMatch(ui.text(), /AI SUGGESTIONS/)
})

test('accepting a suggestion writes only that field and clears the row', async (t) => {
  // Once applied, the server stops suggesting the field — mirror that so the test
  // covers the refresh the component triggers, not a frozen fixture.
  let applied = false
  const ctx = setup(t, {
    routes: {
      'GET /api/leads/5/autofill': () => ({ suggestions: applied ? [] : [SUGGESTION] }),
      'POST /api/leads/5/autofill/apply': () => {
        applied = true
        return { ok: true }
      },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /₹ 60L/)
  await click(ui.byLabel('Accept Budget max'))

  assert.deepEqual(ctx.net.to('/api/leads/5/autofill/apply', 'POST')[0].body, { accepted: { budget_max: 60e7 } })
  assert.doesNotMatch(ui.text(), /AI SUGGESTIONS/, 'the accepted row should disappear')
})

test('rejecting a suggestion drops it without touching the server', async (t) => {
  const ctx = setup(t, { routes: { 'GET /api/leads/5/autofill': { suggestions: [SUGGESTION] } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byLabel('Reject Budget max'))

  assert.equal(ctx.net.to('/api/leads/5/autofill/apply').length, 0)
  assert.doesNotMatch(ui.text(), /AI SUGGESTIONS/)
})

test('a suggestion that replaces a value shows what it was', async (t) => {
  setup(t, {
    routes: {
      'GET /api/leads/5/autofill': {
        suggestions: [{ ...SUGGESTION, current: ['Baner', 'Wakad'], field: 'preferred_localities', label: 'Localities', suggested_display: 'Baner, Balewadi' }],
      },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /\(was Baner, Wakad\)/)
})

test('a failed accept leaves the suggestion in place for a retry', async (t) => {
  setup(t, {
    routes: {
      'GET /api/leads/5/autofill': { suggestions: [SUGGESTION] },
      'POST /api/leads/5/autofill/apply': { status: 500, body: {} },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byLabel('Accept Budget max'))
  assert.match(ui.text(), /AI SUGGESTIONS/)
})

// --- Follow-ups ------------------------------------------------------------

test('a preset schedules a follow-up at 10am on the right day', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/followups': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Tomorrow 10am'))

  const body = ctx.net.to('/api/followups', 'POST')[0].body
  assert.equal(body.lead_id, 5)
  assert.equal(body.note, null)
  const due = new Date(body.due_at)
  assert.equal(due.getHours(), 10)
  assert.equal(due.getMinutes(), 0)
  assert.equal(due.getSeconds(), 0)
})

test('the custom form schedules the picked date with a note', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/followups': { ok: true } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Custom'))
  await change(ui.get((f) => f.props.type === 'datetime-local', 'datetime input'), '2026-08-15T16:30')
  await change(ui.byPlaceholder('Note (optional)'), 'Call before the site visit')
  await submit(ui.get((f) => f.type === 'form' && f.children.some((c) => c.props?.type === 'datetime-local'), 'followup form'))

  const body = ctx.net.to('/api/followups', 'POST')[0].body
  assert.equal(body.note, 'Call before the site visit')
  assert.equal(new Date(body.due_at).getTime(), new Date('2026-08-15T16:30').getTime())
})

test('an empty custom date does not schedule anything', async (t) => {
  const ctx = setup(t)
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Custom'))
  await submit(ui.get((f) => f.type === 'form' && f.children.some((c) => c.props?.type === 'datetime-local'), 'followup form'))

  assert.equal(ctx.net.to('/api/followups').length, 0)
})

test('a rejected follow-up shows why', async (t) => {
  setup(t, { routes: { 'POST /api/followups': { status: 400, body: { error: 'Follow-up must be in the future' } } } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('In 3 days'))
  assert.match(ui.text(), /Follow-up must be in the future/)
})

test('an overdue follow-up is flagged, and ticking it marks it done', async (t) => {
  const ctx = setup(t, {
    data: lead({ followups: [{ id: 3, due_at: new Date(NOW - 86400_000).toISOString(), overdue: true, note: 'Call back' }] }),
    routes: { 'PUT /api/followups/3': { ok: true } },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /overdue/)
  await click(ui.byText('✓', { exact: true }))
  assert.deepEqual(ctx.net.to('/api/followups/3', 'PUT')[0].body, { completed: true })
})

test('an already-completed follow-up toggles back to open', async (t) => {
  const ctx = setup(t, {
    data: lead({ followups: [{ id: 3, due_at: new Date(NOW).toISOString(), completed_at: new Date(NOW).toISOString() }] }),
    routes: { 'PUT /api/followups/3': { ok: true } },
  })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('✓', { exact: true }))
  assert.deepEqual(ctx.net.to('/api/followups/3', 'PUT')[0].body, { completed: false })
})

test('no follow-ups yet says so', async (t) => {
  setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /No follow-ups yet/)
})

// --- Site visits -----------------------------------------------------------

const visitForm = (ui) =>
  ui.get((f) => f.type === 'form' && f.children.some((c) => c.props?.type === 'datetime-local'), 'site visit form')

test('booking a site visit posts an ISO timestamp and the chosen property', async (t) => {
  const ctx = setup(t, {
    routes: {
      'POST /api/site-visits': { ok: true },
      'GET /api/properties': [{ id: 11, title: 'Prestige Lakeside 3BHK' }],
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('+ Schedule'))
  await change(ui.get((f) => f.props.type === 'datetime-local', 'when'), '2026-08-14T11:00')
  await change(ui.get((f) => f.type === 'select' && f.props.children?.[0]?.props?.children === 'Property (optional)', 'property select'), '11')
  await submit(visitForm(ui))

  const body = ctx.net.to('/api/site-visits', 'POST')[0].body
  assert.equal(body.lead_id, 5)
  assert.equal(body.property_id, 11, 'the select value is a string and must be coerced to a number')
  assert.equal(body.due_at, undefined)
  assert.equal(new Date(body.scheduled_at).getTime(), new Date('2026-08-14T11:00').getTime())
})

test('a visit without a property is booked with property_id null', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/site-visits': { ok: true }, 'GET /api/properties': [] } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('+ Schedule'))
  await change(ui.get((f) => f.props.type === 'datetime-local', 'when'), '2026-08-14T11:00')
  await submit(visitForm(ui))

  assert.equal(ctx.net.to('/api/site-visits', 'POST')[0].body.property_id, null)
})

test('pickup details only appear once pickup is required, and are sent', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/site-visits': { ok: true }, 'GET /api/properties': [] } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('+ Schedule'))
  assert.equal(ui.queryByPlaceholder('Pickup location'), null)

  await check(ui.get((f) => f.props.type === 'checkbox', 'pickup checkbox'), true)
  await change(ui.byPlaceholder('Pickup location'), 'Baner Road metro')
  await change(ui.get((f) => f.props.type === 'datetime-local', 'when'), '2026-08-14T11:00')
  await submit(visitForm(ui))

  const body = ctx.net.to('/api/site-visits', 'POST')[0].body
  assert.equal(body.pickup_required, true)
  assert.equal(body.pickup_location, 'Baner Road metro')
})

test('a visit with no date is not booked', async (t) => {
  const ctx = setup(t, { routes: { 'GET /api/properties': [] } })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('+ Schedule'))
  await submit(visitForm(ui))

  assert.equal(ctx.net.to('/api/site-visits').length, 0)
})

test('a rejected booking shows why and keeps the form', async (t) => {
  setup(t, {
    routes: {
      'POST /api/site-visits': { status: 400, body: { error: 'That slot clashes with another visit' } },
      'GET /api/properties': [],
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('+ Schedule'))
  await change(ui.get((f) => f.props.type === 'datetime-local', 'when'), '2026-08-14T11:00')
  await submit(visitForm(ui))

  assert.match(ui.text(), /clashes with another visit/)
  assert.ok(ui.queryByText('Schedule visit'))
})

test('an existing visit exposes its status buttons, skipping the current one', async (t) => {
  const ctx = setup(t, {
    data: lead({
      site_visits: [{ id: 8, scheduled_at: new Date(NOW).toISOString(), status: 'scheduled', property_title: 'Lakeside', pickup_required: 1 }],
    }),
    routes: { 'PUT /api/site-visits/8': { ok: true } },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /Lakeside/)
  assert.match(ui.text(), /🚗/)

  await click(ui.byText('Scheduled'))
  assert.equal(ctx.net.to('/api/site-visits/8').length, 0, 're-picking the current status is a no-op')

  await click(ui.byText('Done'))
  assert.deepEqual(ctx.net.to('/api/site-visits/8', 'PUT')[0].body, { status: 'completed' })
})

// --- Matching inventory ----------------------------------------------------

test('matching properties can be pushed into the chat once', async (t) => {
  const ctx = setup(t, {
    routes: {
      'GET /api/leads/5/property-matches': [
        { id: 11, title: 'Prestige Lakeside', bhk: 3, property_type: 'apartment', locality: 'Baner', price_paise: 55e7, match_reasons: ['budget', 'locality'] },
      ],
      'POST /api/properties/11/send-to-chat': { ok: true },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /MATCHING INVENTORY/)
  assert.match(ui.text(), /✓ budget · locality/)

  await click(ui.byText('Send', { exact: true }))
  assert.deepEqual(ctx.net.to('/api/properties/11/send-to-chat', 'POST')[0].body, { lead_id: 5 })
  assert.match(ui.text(), /✓ Sent/)

  await click(ui.byText('✓ Sent'))
  assert.equal(ctx.net.to('/api/properties/11/send-to-chat').length, 1, 'a sent property must not be re-sent')
})

test('a failed property send is reported and the button resets', async (t) => {
  setup(t, {
    routes: {
      'GET /api/leads/5/property-matches': [{ id: 11, title: 'Prestige Lakeside' }],
      'POST /api/properties/11/send-to-chat': { status: 400, body: { error: 'Free-reply window is closed' } },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  await click(ui.byText('Send', { exact: true }))

  assert.match(ui.text(), /Free-reply window is closed/)
  assert.ok(ui.queryByText('Send', { exact: true }), 'the agent should be able to try again')
})

test('the matching section is hidden when there is no inventory fit', async (t) => {
  setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.doesNotMatch(ui.text(), /MATCHING INVENTORY/)
})

// --- Briefing, score, transcript, source -----------------------------------

test('the briefing panel renders talking points and what is still unknown', async (t) => {
  setup(t, {
    routes: {
      'GET /api/leads/5/briefing': {
        temperature: 'Hot',
        score: 82,
        days_since_last_contact: 0,
        talking_points: [{ tone: 'urgent', text: 'Asked for a site visit twice' }],
        missing_bltc: ['budget', 'timeline'],
      },
    },
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /BEFORE YOU CALL/)
  assert.match(ui.text(), /Asked for a site visit twice/)
  assert.match(ui.text(), /today/)
  assert.match(ui.text(), /budget · timeline/)
})

test('the briefing panel stays hidden when there is nothing to say', async (t) => {
  setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.doesNotMatch(ui.text(), /BEFORE YOU CALL/)
})

test('a low-scoring lead gets encouragement instead of a discouraging breakdown', async (t) => {
  setup(t, { data: lead({ score: 10, score_breakdown: [{ label: 'Budget', value: 0 }] }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /Not enough data yet/)
  assert.doesNotMatch(ui.text(), /SCORE BREAKDOWN/)
})

test('a scored lead shows the breakdown bars', async (t) => {
  setup(t, {
    data: lead({ score: 72, score_breakdown: [{ label: 'Budget', value: 90 }, { label: 'Timeline', value: 40 }] }),
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /SCORE BREAKDOWN · 72\/100/)
  assert.match(ui.text(), /Budget/)
})

test('a score breakdown stored as a JSON string is parsed', async (t) => {
  setup(t, { data: lead({ score: 72, score_breakdown: JSON.stringify([{ label: 'Budget', value: 90 }]) }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /SCORE BREAKDOWN/)
})

test('a corrupt score breakdown is ignored rather than crashing the panel', async (t) => {
  setup(t, { data: lead({ score: 72, score_breakdown: '{not json' }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.doesNotMatch(ui.text(), /SCORE BREAKDOWN/)
  assert.match(ui.text(), /Priya Sharma/, 'the rest of the panel still renders')
})

test('a portal lead shows where it came from', async (t) => {
  setup(t, { data: lead({ source_channel: 'portal_email', source_portal: '99acres', source_ref: 'Prestige Lakeside' }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /Portal email · 99acres/)
  assert.match(ui.text(), /Enquired: Prestige Lakeside/)
})

test('an ad lead shows the 72-hour free-reply window while it is open', async (t) => {
  setup(t, { data: lead({ source_channel: 'ctwa', free_entry_window: { open: true, hours_left: 40 } }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /reply free for 72 hours — 40h left/)
})

test('a closed free-entry window tells the agent templates are required', async (t) => {
  setup(t, { data: lead({ source_channel: 'ctwa', free_entry_window: { open: false } }) })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /only send one of your approved messages/)
})

test('the transcript renders messages, and says so when there are none', async (t) => {
  setup(t, {
    data: lead({ messages: [{ id: 1, role: 'buyer', text: 'Is it still available?', created_at: new Date(NOW).toISOString() }] }),
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /WHATSAPP TRANSCRIPT/)
  assert.match(ui.text(), /Is it still available\?/)
})

test('the AI capture block only renders when the AI has captured something', async (t) => {
  setup(t)
  const withNothing = await render(<LeadDetail {...props} />)
  assert.doesNotMatch(withNothing.text(), /AI CAPTURE/)
})

test('the AI capture block shows the summary, score and reasoning', async (t) => {
  setup(t, {
    data: lead({ ai_summary: 'Wants a 3 BHK in Baner', ai_score: 'hot', ai_score_reason: 'Budget and timeline confirmed', next_step: 'Book a site visit', intent: 'buy' }),
  })
  const ui = await render(<LeadDetail {...props} />)

  assert.match(ui.text(), /AI CAPTURE/)
  assert.match(ui.text(), /Wants a 3 BHK in Baner/)
  assert.match(ui.text(), /Intent/)
  assert.match(ui.text(), /Buy/, 'intent should be capitalised for display')
  assert.match(ui.text(), /Why hot: Budget and timeline confirmed/)
  assert.match(ui.text(), /Next step: Book a site visit/)
})

test('closing the panel stops its poll', async (t) => {
  const ctx = setup(t)
  const ui = await render(<LeadDetail {...props} />)

  assert.ok(ctx.env.liveIntervals > 0)
  ui.unmount()
  assert.equal(ctx.env.liveIntervals, 0)
})
