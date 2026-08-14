// The unified inbox. Two things here cost real money if they're wrong: sending
// outside WhatsApp's 24-hour service window (Meta rejects it), and sending a
// template with a blank variable (a paid send that arrives broken).
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, keyDown } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import InboxTab from './InboxTab.jsx'

const HOUR = 3600_000
const NOW = Date.parse('2026-08-10T12:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

const thread = (over = {}) => ({
  id: 5,
  name: 'Priya Sharma',
  wa_id: '919876543210',
  temp: 'Hot',
  ai_enabled: 0,
  last_inbound_at: ago(2 * HOUR),
  labels: [],
  notes: [],
  messages: [
    { id: 1, role: 'buyer', text: 'Is the 3 BHK still available?', created_at: ago(2 * HOUR) },
    { id: 2, role: 'ai', text: 'Yes! Would you like to visit this weekend?', created_at: ago(HOUR) },
  ],
  ...over,
})

function setup(t, { lead = thread(), routes = {} } = {}) {
  const env = installBrowser({ now: NOW })
  const net = mockFetch({
    'GET /api/leads': [lead],
    [`GET /api/leads/${lead.id}`]: lead,
    [`POST /api/leads/${lead.id}/read`]: { ok: true },
    [`GET /api/leads/${lead.id}/suggestions`]: { suggestions: [] },
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net, lead }
}

// --- Conversation list -----------------------------------------------------

test('the list shows the reply-mode badge for each thread', async (t) => {
  setup(t, { lead: thread({ ai_enabled: 1 }) })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /🤖 Auto-reply/)
})

test('an unread thread shows its count and the last message prefix', async (t) => {
  setup(t, { lead: thread({ unread_count: 3, last_role: 'buyer', last_msg: 'Any update?' }) })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /3/)
  assert.match(ui.text(), /Any update\?/)
})

test('a thread the agent answered last is prefixed with "You:"', async (t) => {
  setup(t, { lead: thread({ last_role: 'agent', last_msg: 'Sharing the brochure' }) })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /You: Sharing the brochure/)
})

test('a thread with no messages yet shows a dash, not "undefined"', async (t) => {
  setup(t, { lead: thread({ last_msg: null, last_role: 'buyer' }) })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.doesNotMatch(ui.text(), /undefined|null/)
})

test('an empty inbox explains how conversations arrive', async (t) => {
  setup(t, { routes: { 'GET /api/leads': [] } })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /No conversations yet/)
})

test('tapping a thread reports the lead id upward', async (t) => {
  setup(t)
  const picked = []
  const ui = await render(<InboxTab leadId={null} onSelectLead={(id) => picked.push(id)} />)

  await click(ui.byText('Priya Sharma'))
  assert.deepEqual(picked, [5])
})

test('a dead server is reported on the inbox list, and announced', async (t) => {
  setup(t, { routes: { 'GET /api/leads': { status: 502, body: {} } } })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  // The banner names what actually happened — a 502 is the server answering badly,
  // not the phone being offline — and it is a live region, because it arrives on a
  // poll with nothing on screen having been touched.
  const banner = ui.byRole('alert')
  assert.match(banner.props.children, /briefly unavailable/)
})

// --- Conversation view -----------------------------------------------------

test('opening a thread renders the messages and marks it read once', async (t) => {
  const ctx = setup(t)
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Is the 3 BHK still available\?/)
  assert.match(ui.text(), /HomeNex AI/)
  assert.equal(ctx.net.to('/api/leads/5/read', 'POST').length, 1)

  ctx.env.advance(4000) // the 3s poll ticks
  assert.equal(ctx.net.to('/api/leads/5/read', 'POST').length, 1, 'read should not be re-posted on every poll')
})

test('an open service window shows the countdown and a free-text composer', async (t) => {
  setup(t, { lead: thread({ last_inbound_at: ago(2 * HOUR) }) })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Free replies · 22h 0m left/)
  assert.ok(ui.queryByPlaceholder('Reply to Priya Sharma on WhatsApp…'))
})

test('a closed window hides the composer and offers approved templates instead', async (t) => {
  setup(t, {
    lead: thread({ last_inbound_at: ago(25 * HOUR) }),
    routes: { 'GET /api/templates': [{ id: 9, name: 'Follow up', body: 'Hi {{name}}, still looking?' }] },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Free-reply time is up/)
  assert.equal(ui.queryByPlaceholder('Reply to Priya Sharma on WhatsApp…'), null)
  assert.match(ui.text(), /pick one of your approved messages/)
  assert.match(ui.text(), /Follow up/)
})

test('a lead with no inbound anchor is treated as open rather than blocked', async (t) => {
  setup(t, { lead: thread({ last_inbound_at: null }) })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.ok(ui.queryByPlaceholder('Reply to Priya Sharma on WhatsApp…'))
  assert.doesNotMatch(ui.text(), /Free-reply time is up/)
})

test('the send button stays disabled until there is something to send', async (t) => {
  setup(t)
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)
  const sendButton = () => ui.get((f) => f.type === 'button' && f.props.className?.includes('rounded-full bg-brand'), 'send button')

  assert.equal(sendButton().props.disabled, true)
  await change(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), '   ')
  assert.equal(sendButton().props.disabled, true, 'whitespace is not a message')

  await change(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'On my way')
  assert.equal(sendButton().props.disabled, false)
})

test('sending posts the trimmed text and clears the draft', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/leads/5/reply': { ok: true } } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  const box = ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…')
  await change(box, '  Visiting at 5pm  ')
  await click(ui.get((f) => f.type === 'button' && f.props.className?.includes('rounded-full bg-brand'), 'send'))

  assert.deepEqual(ctx.net.to('/api/leads/5/reply', 'POST')[0].body, { text: 'Visiting at 5pm' })
  assert.equal(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…').props.value, '')
})

test('Enter sends, Shift+Enter does not', async (t) => {
  const ctx = setup(t, { routes: { 'POST /api/leads/5/reply': { ok: true } } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await change(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Line one')
  await keyDown(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Enter', { shiftKey: true })
  assert.equal(ctx.net.to('/api/leads/5/reply').length, 0, 'Shift+Enter should insert a newline, not send')

  await keyDown(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Enter')
  assert.equal(ctx.net.to('/api/leads/5/reply').length, 1)
})

test('a failed send keeps the draft and shows why', async (t) => {
  setup(t, {
    routes: { 'POST /api/leads/5/reply': { status: 400, body: { error: 'WhatsApp token expired' } } },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await change(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Please call me')
  await keyDown(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Enter')

  assert.match(ui.text(), /WhatsApp token expired/)
  assert.equal(
    ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…').props.value,
    'Please call me',
    'a failed send must not eat the message the agent typed',
  )
})

test('the AI toggle flips who answers the thread', async (t) => {
  const ctx = setup(t, { lead: thread({ ai_enabled: 0 }), routes: { 'POST /api/leads/5/ai': { ok: true } } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('✋ You reply'))
  assert.deepEqual(ctx.net.to('/api/leads/5/ai', 'POST')[0].body, { enabled: true })
})

test('AI reply suggestions appear only while the buyer is waiting', async (t) => {
  setup(t, {
    routes: { 'GET /api/leads/5/suggestions': { suggestions: ['Yes, still available!', 'Shall I book a visit?'] } },
    lead: thread({
      messages: [{ id: 1, role: 'buyer', text: 'Still available?', created_at: ago(HOUR) }],
    }),
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Yes, still available!/)
  await click(ui.byText('Shall I book a visit?'))
  assert.equal(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…').props.value, 'Shall I book a visit?')
})

test('no suggestions are fetched when the agent sent the last message', async (t) => {
  const ctx = setup(t, {
    lead: thread({ messages: [{ id: 1, role: 'agent', text: 'Sent the brochure', created_at: ago(HOUR) }] }),
  })
  await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.equal(ctx.net.to('/api/leads/5/suggestions').length, 0)
})

test('an empty thread says so instead of rendering a blank chat', async (t) => {
  setup(t, { lead: thread({ messages: [] }) })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /No messages yet/)
})

test('a chat that cannot be loaded says so', async (t) => {
  setup(t, { routes: { 'GET /api/leads/5': { status: 404, body: {} } } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Couldn't load this chat/)
})

test('back returns to the list', async (t) => {
  setup(t)
  const picked = []
  const ui = await render(<InboxTab leadId={5} onSelectLead={(id) => picked.push(id)} />)

  await click(ui.byText('←'))
  assert.deepEqual(picked, [null])
})

// --- Template composer -----------------------------------------------------

const closedWindow = (routes) => ({
  lead: thread({ last_inbound_at: ago(30 * HOUR) }),
  routes,
})

test('a template with unfilled variables cannot be sent', async (t) => {
  const ctx = setup(
    t,
    closedWindow({
      'GET /api/templates': [{ id: 9, name: 'Site visit invite', body: 'Hi {{name}}, visit {{project}} on {{date}}?' }],
      'POST /api/leads/5/reply': { ok: true },
    }),
  )
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Site visit invite'))
  assert.match(ui.text(), /Fill in project, date to send this/)
  assert.equal(ui.byText('Send template').props.disabled, true)

  await click(ui.byText('Send template'))
  assert.equal(ctx.net.to('/api/leads/5/reply').length, 0, 'a paid template send must not go out half-filled')
})

test('filling every variable enables the send and posts the values', async (t) => {
  const ctx = setup(
    t,
    closedWindow({
      'GET /api/templates': [{ id: 9, name: 'Site visit invite', body: 'Hi {{name}}, visit {{project}} on {{date}}?' }],
      'POST /api/leads/5/reply': { ok: true },
    }),
  )
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Site visit invite'))
  await change(ui.byLabel('project'), 'Prestige Lakeside')
  await change(ui.byLabel('date'), 'Saturday 4pm')

  assert.equal(ui.byText('Send template').props.disabled, false)
  await click(ui.byText('Send template'))

  assert.deepEqual(ctx.net.to('/api/leads/5/reply', 'POST')[0].body, {
    template_id: 9,
    variables: { name: 'Priya Sharma', project: 'Prestige Lakeside', date: 'Saturday 4pm' },
  })
})

test('the lead name pre-fills the {{name}} variable', async (t) => {
  setup(
    t,
    closedWindow({ 'GET /api/templates': [{ id: 9, name: 'Nudge', body: 'Hi {{name}}, still looking?' }] }),
  )
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Nudge'))
  assert.equal(ui.byLabel('name').props.value, 'Priya Sharma')
  assert.equal(ui.byText('Send template').props.disabled, false)
})

test('a template with no variables sends straight away', async (t) => {
  const ctx = setup(
    t,
    closedWindow({
      'GET /api/templates': [{ id: 9, name: 'Thanks', body: 'Thank you for visiting our office.' }],
      'POST /api/leads/5/reply': { ok: true },
    }),
  )
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Thanks', { exact: true }))
  await click(ui.byText('Send template'))

  assert.equal(ctx.net.to('/api/leads/5/reply').length, 1)
})

test('a rejected template send surfaces the reason', async (t) => {
  setup(
    t,
    closedWindow({
      'GET /api/templates': [{ id: 9, name: 'Nudge', body: 'Hi {{name}}!' }],
      'POST /api/leads/5/reply': { status: 400, body: { error: 'Template not approved by Meta' } },
    }),
  )
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Nudge'))
  await click(ui.byText('Send template'))

  assert.match(ui.text(), /Template not approved by Meta/)
})

test('an empty template library points at where to add one', async (t) => {
  setup(t, closedWindow({ 'GET /api/templates': [] }))
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /No templates yet/)
})

test('a failed template fetch degrades to the empty state, not a crash', async (t) => {
  setup(t, closedWindow({ 'GET /api/templates': { status: 500, body: {} } }))
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.match(ui.text(), /No templates yet/)
})

test('tapping an open template again collapses it', async (t) => {
  setup(t, closedWindow({ 'GET /api/templates': [{ id: 9, name: 'Nudge', body: 'Hi {{name}}!' }] }))
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('Nudge'))
  assert.ok(ui.queryByText('Send template'))
  await click(ui.byText('Nudge'))
  assert.equal(ui.queryByText('Send template'), null)
})

// --- Sheets ----------------------------------------------------------------

test('quick replies fill the draft with the buyer name substituted', async (t) => {
  setup(t, {
    routes: { 'GET /api/quick-replies': [{ id: 1, title: 'Greeting', body: 'Hello {{name}}, how can I help?' }] },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('⚡ Quick reply'))
  await click(ui.byText('Greeting'))

  assert.equal(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…').props.value, 'Hello Priya Sharma, how can I help?')
})

test('a quick reply appends to an existing draft rather than replacing it', async (t) => {
  setup(t, { routes: { 'GET /api/quick-replies': [{ id: 1, title: 'Greeting', body: 'Shall we book a visit?' }] } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await change(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…'), 'Thanks!')
  await click(ui.byText('⚡ Quick reply'))
  await click(ui.byText('Greeting'))

  assert.equal(ui.byPlaceholder('Reply to Priya Sharma on WhatsApp…').props.value, 'Thanks! Shall we book a visit?')
})

test('an empty quick-reply library points at where to add one', async (t) => {
  setup(t, { routes: { 'GET /api/quick-replies': [] } })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('⚡ Quick reply'))
  assert.match(ui.text(), /No quick replies yet/)
})

test('media already sent to this lead is marked so it is not sent twice', async (t) => {
  setup(t, {
    lead: thread({ media_sent_ids: [11] }),
    routes: {
      'GET /api/media': [
        { id: 11, title: 'Lakeside brochure', kind: 'brochure' },
        { id: 12, title: 'Floor plan A', kind: 'floor_plan' },
      ],
    },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('📎 Media'))
  assert.match(ui.text(), /✓ sent/)
  assert.match(ui.text(), /floor plan/, 'the kind should read as words, not floor_plan')
})

test('sending media closes the sheet, and a failure reports back in the chat', async (t) => {
  const ctx = setup(t, {
    routes: {
      'GET /api/media': [{ id: 11, title: 'Lakeside brochure', kind: 'brochure' }],
      'POST /api/media/11/send': { status: 400, body: { error: 'File too large for WhatsApp' } },
    },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('📎 Media'))
  await click(ui.byText('Lakeside brochure'))

  assert.deepEqual(ctx.net.to('/api/media/11/send', 'POST')[0].body, { lead_id: 5 })
  assert.match(ui.text(), /File too large for WhatsApp/)
  assert.equal(ui.queryByText('Attach from media library'), null, 'the sheet should close so the error is visible')
})

test('internal notes are listed and added', async (t) => {
  const ctx = setup(t, {
    lead: thread({ notes: [{ id: 1, body: 'Budget confirmed at 1.2Cr', agent_name: 'Rajesh', created_at: ago(HOUR) }] }),
    routes: { 'POST /api/leads/5/notes': { ok: true } },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('📝 1'))
  assert.match(ui.text(), /Budget confirmed at 1.2Cr/)
  assert.match(ui.text(), /never sent to the client/)

  await change(ui.byPlaceholder('Add a private note…'), '  Prefers evening calls  ')
  await click(ui.byText('Add note'))

  assert.deepEqual(ctx.net.to('/api/leads/5/notes', 'POST')[0].body, { body: 'Prefers evening calls' })
})

test('a blank note cannot be added', async (t) => {
  const ctx = setup(t)
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('📝'))
  assert.equal(ui.byText('Add note').props.disabled, true)

  await change(ui.byPlaceholder('Add a private note…'), '   ')
  await click(ui.byText('Add note'))
  assert.equal(ctx.net.to('/api/leads/5/notes').length, 0)
})

test('labels can be toggled on the thread', async (t) => {
  const ctx = setup(t, {
    lead: thread({ labels: [{ id: 2, name: 'Investor', color: '#123456' }] }),
    routes: {
      'GET /api/labels': [
        { id: 2, name: 'Investor', color: '#123456' },
        { id: 3, name: 'NRI', color: '#654321' },
      ],
      'PUT /api/leads/5/labels/3': { ok: true },
      'PUT /api/leads/5/labels/2': { ok: true },
    },
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  await click(ui.byText('+ Label'))
  await click(ui.byText('NRI'))
  assert.deepEqual(ctx.net.to('/api/leads/5/labels/3', 'PUT')[0].body, { on: true })

  await click(ui.byText('✓ Investor'))
  assert.deepEqual(ctx.net.to('/api/leads/5/labels/2', 'PUT')[0].body, { on: false }, 'an active label should toggle off')
})

test('the conversation stops polling when it is closed', async (t) => {
  const ctx = setup(t)
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  assert.ok(ctx.env.liveIntervals > 0)
  ui.unmount()
  assert.equal(ctx.env.liveIntervals, 0)
})

// --- Paging -----------------------------------------------------------------
// The inbox polls every 4 seconds. Unpaged, that was the app's largest repeated
// payload; the screen now asks for a page and offers to go deeper.

test('the thread list asks for one page rather than every conversation', async (t) => {
  const ctx = setup(t)
  await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  const [call] = ctx.net.to('/api/leads', 'GET')
  assert.equal(call.query.limit, '50')
})

test('a full page offers older conversations, and asks for a bigger page', async (t) => {
  const threads = Array.from({ length: 60 }, (_, i) => thread({ id: i + 1, name: `Client ${i + 1}` }))
  const env = installBrowser({ now: NOW })
  const net = mockFetch({
    'GET /api/leads': ({ query }) => threads.slice(0, Math.min(Number(query.limit) || 100, 500)),
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /Client 1You/) // the rendered text runs together, so anchor on the next node
  assert.doesNotMatch(ui.text(), /Client 60/)

  await click(ui.byText('Load older conversations'))

  assert.equal(net.to('/api/leads', 'GET').at(-1).query.limit, '100')
  assert.match(ui.text(), /Client 60/)
  assert.doesNotMatch(ui.text(), /Load older conversations/, 'a short page means the end')
})

test('no paging control when every conversation already fits', async (t) => {
  setup(t)
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)
  assert.doesNotMatch(ui.text(), /Load older/)
})

test('the list shows skeletons while the first page is in flight, not a blank screen', async (t) => {
  const env = installBrowser({ now: NOW })
  let release = null
  const net = mockFetch({ 'GET /api/leads': () => new Promise((r) => (release = r)) })
  t.after(() => {
    net.restore()
    env.restore()
  })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.ok(ui.query((f) => f.props?.['aria-busy'] === 'true'), 'a busy placeholder is rendered')
  assert.doesNotMatch(ui.text(), /No conversations yet/, 'never claim "empty" before the answer lands')
  release?.([])
})

test('the empty state only appears once the server has actually answered', async (t) => {
  const env = installBrowser({ now: NOW })
  const net = mockFetch({ 'GET /api/leads': [] })
  t.after(() => {
    net.restore()
    env.restore()
  })
  const ui = await render(<InboxTab leadId={null} onSelectLead={() => {}} />)

  assert.match(ui.text(), /No conversations yet/)
  assert.equal(ui.query((f) => f.props?.['aria-busy'] === 'true'), null, 'skeletons are gone')
})
