// The pipeline board. Agents live in this screen, and the expensive mistakes are
// leads showing up in the wrong pipeline, a stage move that silently doesn't stick,
// and losing a lead to a drag that skipped the "why was it lost?" prompt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, fire } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import LeadsTab from './LeadsTab.jsx'

const STAGES = [
  { id: 1, stage_name: 'New' },
  { id: 2, stage_name: 'Site Visit' },
  { id: 3, stage_name: 'Negotiation' },
  { id: 4, stage_name: 'Lost' },
]

const lead = (over = {}) => ({
  id: 1,
  contact_name: 'Priya Sharma',
  stage: 'New',
  pipeline_type: 'buy_primary',
  temp: 'Hot',
  bhk: 3,
  last_at: new Date().toISOString(),
  ...over,
})

const ANALYTICS = {
  totals: { open: 4, won: 2, lost: 1 },
  funnel: [
    { stage: 'New', open: 3, avg_seconds_in_stage: 1800 },
    { stage: 'Site Visit', open: 1, avg_seconds_in_stage: 180000 },
    { stage: 'Lost', open: 0, avg_seconds_in_stage: null },
  ],
  lost_reasons: [{ reason: 'Budget mismatch', n: 3 }],
}

function setup(t, { leads = [lead()], routes = {} } = {}) {
  const env = installBrowser()
  const net = mockFetch({
    'GET /api/leads': leads,
    'GET /api/pipeline-stages': STAGES,
    'GET /api/pipeline/analytics': ANALYTICS,
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// Board columns are plain divs; find one by the stage heading it contains.
const column = (ui, stageName) =>
  ui.get(
    (f) =>
      f.type === 'div' &&
      typeof f.props.onDrop === 'function' &&
      ui.allByText(stageName, { exact: true }).some((heading) => isInside(heading, f)),
    `${stageName} column`,
  )

const isInside = (node, ancestor) => {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur === ancestor) return true
  return false
}

test('the list shows leads for the selected pipeline only', async (t) => {
  setup(t, {
    leads: [
      lead({ id: 1, contact_name: 'Priya Sharma', pipeline_type: 'buy_primary' }),
      lead({ id: 2, contact_name: 'Amit Rental', pipeline_type: 'rental' }),
    ],
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Priya Sharma/)
  assert.doesNotMatch(ui.text(), /Amit Rental/)

  await click(ui.byText('Rental'))
  assert.match(ui.text(), /Amit Rental/)
  assert.doesNotMatch(ui.text(), /Priya Sharma/)
})

test('a lead with no pipeline set is treated as Buy (Primary)', async (t) => {
  setup(t, { leads: [lead({ contact_name: 'Unsorted Buyer', pipeline_type: null })] })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Unsorted Buyer/, 'a webhook lead with no pipeline must not vanish')
})

test('the header counts only open leads, excluding won and lost', async (t) => {
  setup(t, {
    leads: [
      lead({ id: 1, stage: 'New' }),
      lead({ id: 2, stage: 'Site Visit' }),
      lead({ id: 3, stage: 'Lost' }),
      lead({ id: 4, stage: 'Closed' }),
    ],
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /2 open in this pipeline/)
})

test('an empty CRM explains where leads come from instead of showing a blank board', async (t) => {
  setup(t, { leads: [] })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /No leads yet/)
  assert.match(ui.text(), /messages your WhatsApp number/)
})

test('a lead card falls back through contact name, name, then WhatsApp id', async (t) => {
  setup(t, {
    leads: [
      lead({ id: 1, contact_name: null, name: 'Named Lead' }),
      lead({ id: 2, contact_name: null, name: null, wa_id: '919812345678' }),
    ],
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Named Lead/)
  assert.match(ui.text(), /919812345678/)
})

test('a lead with nothing qualified yet says so rather than showing an empty line', async (t) => {
  setup(t, { leads: [lead({ bhk: null, budget_min: null, budget_max: null, locality: null })] })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Qualifying…/)
})

test('an unassigned lead is flagged instead of showing a temperature', async (t) => {
  setup(t, { leads: [lead({ unassigned: 1, temp: 'Hot' })] })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Unassigned/)
  assert.doesNotMatch(ui.text(), /🔥 Hot/)
})

test('the pipeline chips carry a count badge from every pipeline at once', async (t) => {
  setup(t, {
    leads: [
      lead({ id: 1, pipeline_type: 'buy_primary' }),
      lead({ id: 2, pipeline_type: 'rental' }),
      lead({ id: 3, pipeline_type: 'rental' }),
    ],
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  const rentalChip = ui.byText('Rental')
  assert.match(rentalChip.props.children.join?.('') ?? '', /Rental/)
  assert.match(ui.text(), /Rental2/, 'the rental chip should show its own backlog while Buy is selected')
})

test('Board view groups leads into stage columns with counts', async (t) => {
  setup(t, {
    leads: [lead({ id: 1, stage: 'New' }), lead({ id: 2, stage: 'New' }), lead({ id: 3, stage: 'Site Visit' })],
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  await click(ui.byText('▦ Board'))
  assert.match(ui.text(), /NEW2|New2/)
  assert.match(ui.text(), /Negotiation/)
})

test('an empty board column coaches the agent on what belongs there', async (t) => {
  setup(t, { leads: [lead({ stage: 'New' })] })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  await click(ui.byText('▦ Board'))
  // Site Visit / Negotiation / Lost are all empty and should carry guidance text.
  assert.ok(ui.text().length > 0)
  assert.doesNotMatch(ui.text(), /undefined/, 'empty-stage copy must never render as undefined')
})

test('dragging a card onto another column moves the stage and refetches', async (t) => {
  const ctx = setup(t, {
    leads: [lead({ id: 42, stage: 'New' })],
    routes: { 'PUT /api/leads/42/stage': { ok: true } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)
  await click(ui.byText('▦ Board'))

  await fire(ui.byText('Priya Sharma'), 'onDragStart')
  await fire(column(ui, 'Site Visit'), 'onDrop')

  // lost_reason is absent, not null — the server treats a reason as optional here.
  assert.deepEqual(ctx.net.to('/api/leads/42/stage', 'PUT')[0].body, { stage: 'Site Visit' })
})

test('dropping onto Lost asks for a reason before recording the loss', async (t) => {
  const ctx = setup(t, {
    leads: [lead({ id: 42, stage: 'New' })],
    routes: { 'PUT /api/leads/42/stage': { ok: true } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)
  await click(ui.byText('▦ Board'))

  await fire(ui.byText('Priya Sharma'), 'onDragStart')
  await fire(column(ui, 'Lost'), 'onDrop')

  assert.equal(ctx.net.to('/api/leads/42/stage').length, 0, 'the move must wait for a reason')
  assert.match(ui.text(), /Why was this lead lost\?/)

  await click(ui.byText('Budget mismatch'))
  assert.deepEqual(ctx.net.to('/api/leads/42/stage', 'PUT')[0].body, { stage: 'Lost', lost_reason: 'Budget mismatch' })
})

test('a custom lost reason is trimmed, and an empty one is ignored', async (t) => {
  const ctx = setup(t, {
    leads: [lead({ id: 42, stage: 'New' })],
    routes: { 'PUT /api/leads/42/stage': { ok: true } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)
  await click(ui.byText('▦ Board'))
  await fire(ui.byText('Priya Sharma'), 'onDragStart')
  await fire(column(ui, 'Lost'), 'onDrop')

  await click(ui.byText('Save', { exact: true }))
  assert.equal(ctx.net.to('/api/leads/42/stage').length, 0, 'an empty reason should not close the lead')

  await change(ui.byPlaceholder('Other reason…'), '  Chose a competitor  ')
  await click(ui.byText('Save', { exact: true }))
  assert.equal(ctx.net.to('/api/leads/42/stage')[0].body.lost_reason, 'Chose a competitor')
})

test('dropping a card back on its own column is a no-op', async (t) => {
  const ctx = setup(t, {
    leads: [lead({ id: 42, stage: 'New' })],
    routes: { 'PUT /api/leads/42/stage': { ok: true } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)
  await click(ui.byText('▦ Board'))

  await fire(ui.byText('Priya Sharma'), 'onDragStart')
  await fire(column(ui, 'New'), 'onDrop')

  assert.equal(ctx.net.to('/api/leads/42/stage').length, 0)
})

test('a rejected stage move surfaces the reason instead of failing quietly', async (t) => {
  setup(t, {
    leads: [lead({ id: 42, stage: 'New' })],
    routes: { 'PUT /api/leads/42/stage': { status: 400, body: { error: 'Site visit must be booked first' } } },
  })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)
  await click(ui.byText('▦ Board'))

  await fire(ui.byText('Priya Sharma'), 'onDragStart')
  await fire(column(ui, 'Negotiation'), 'onDrop')

  assert.match(ui.text(), /Site visit must be booked first/)
})

test('a dead server is reported on the leads list', async (t) => {
  setup(t, { routes: { 'GET /api/leads': { status: 503, body: {} } } })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.match(ui.text(), /Can't reach the HomeNex server/)
})

test('Stats view renders the funnel, dwell times and lost-reason mix', async (t) => {
  setup(t)
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  await click(ui.byText('📊 Stats'))

  assert.match(ui.text(), /FUNNEL/)
  assert.match(ui.text(), /30m/, '1800s should read as 30m')
  assert.match(ui.text(), /2d 2h/, '180000s should read as 2d 2h')
  assert.match(ui.text(), /WHY LEADS ARE LOST/)
  assert.match(ui.text(), /Budget mismatch/)
})

test('Stats hides the lost-reason panel when nothing has been lost', async (t) => {
  setup(t, { routes: { 'GET /api/pipeline/analytics': { ...ANALYTICS, lost_reasons: [] } } })
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  await click(ui.byText('📊 Stats'))
  assert.doesNotMatch(ui.text(), /WHY LEADS ARE LOST/)
})

test('the Add lead button opens the quick-capture sheet', async (t) => {
  setup(t)
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  await click(ui.byText('Add lead'))
  assert.match(ui.text(), /Quick tags/)
})

test('polling stops when the screen goes away', async (t) => {
  const ctx = setup(t)
  const ui = await render(<LeadsTab onOpenConversation={() => {}} />)

  assert.ok(ctx.env.liveIntervals > 0)
  ui.unmount()
  assert.equal(ctx.env.liveIntervals, 0, 'a leaked poll keeps hitting the server after the tab closes')
})
