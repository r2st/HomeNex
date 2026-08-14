// Festival greetings: the one screen that messages every contact the broker has.
//
// A greeting is a bulk send to the agent's whole book, so the expensive mistakes here
// are not rendering mistakes. They are: sending when the agent meant to schedule,
// scheduling without the date they picked, and — worst — reporting a send that never
// happened. The sheet reports back what the server actually said it did, and the tests
// below are mostly about that sentence.
//
// The screen also has three states that look alike from the outside and mean opposite
// things: still loading, loaded with nothing, and failed. The comment in the component
// is there because those were conflated once already.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, submit } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import FestiveTab from './FestiveTab.jsx'

// A date far enough out that "9 AM on the suggested date" is always still ahead of
// now, whenever the suite runs.
const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

const FESTIVALS = [
  { key: 'diwali', name: 'Diwali', emoji: '🪔', suggested_date: soon, default_message: 'Happy Diwali, {name}!' },
  { key: 'holi', name: 'Holi', emoji: '🎨', suggested_date: past, default_message: 'Happy Holi, {name}!' },
]

const SCHEDULED = [
  { id: 1, festival_key: 'diwali', status: 'scheduled', send_at: new Date(Date.now() + 86_400_000).toISOString(), sent_count: 0 },
  { id: 2, festival_key: 'holi', status: 'sent', send_at: new Date(Date.now() - 86_400_000).toISOString(), sent_count: 42 },
  { id: 3, festival_key: 'ganesh', status: 'failed', send_at: new Date(Date.now() - 172_800_000).toISOString(), sent_count: 0 },
]

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/templates/festive': { festivals: FESTIVALS, scheduled: SCHEDULED },
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return net
}

const openSheet = async (ui, name = 'Diwali') => click(ui.byText(name, { selector: 'p' }).parent)

// --- The three states of a first load ---------------------------------------

test('a failed load says what went wrong instead of showing an empty grid', async (t) => {
  setup(t, { '/api/templates/festive': { status: 500, body: { error: 'festivals unavailable' } } })
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /festivals unavailable/)
  assert.equal(ui.queryByText('Loading festivals…'), null, 'a failed load must not still read as in-flight')
})

test('a loaded screen shows every festival with its date', async (t) => {
  setup(t)
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /Diwali/)
  assert.match(ui.text(), /Holi/)
  assert.equal(ui.queryByText('Loading festivals…'), null)
})

// --- The scheduled ledger ----------------------------------------------------

test('a sent greeting reports how many it reached; a scheduled one does not pretend to', async (t) => {
  setup(t)
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /42 sent/)
  const scheduledRow = ui.text().match(/Diwali.*?scheduled/s)?.[0] || ''
  assert.doesNotMatch(scheduledRow, /0 sent/, 'a greeting that has not gone out yet must not report a count')
})

test('a schedule for a festival the catalogue no longer carries still renders', async (t) => {
  // The ledger is history: a festival can leave the catalogue while an old schedule
  // still refers to it, and that row must not disappear or crash on a missing emoji.
  setup(t)
  const ui = await render(<FestiveTab />)

  assert.match(ui.text(), /ganesh/, 'an unknown festival key falls back to the key itself')
  assert.match(ui.text(), /failed/)
})

test('only a scheduled greeting can be cancelled', async (t) => {
  setup(t)
  const ui = await render(<FestiveTab />)

  assert.equal(ui.allByRole('button', { name: 'Cancel' }).length, 1, 'a sent greeting cannot be un-sent')
})

test('cancelling deletes that schedule and reloads the ledger', async (t) => {
  const net = setup(t, { 'DELETE /api/templates/festive/1': { ok: true } })
  const ui = await render(<FestiveTab />)

  const loadsBefore = net.to('/api/templates/festive', 'GET').length
  await click(ui.byRole('button', { name: 'Cancel' }))

  assert.equal(net.to('/api/templates/festive/1', 'DELETE').length, 1)
  assert.ok(net.to('/api/templates/festive', 'GET').length > loadsBefore, 'the list must refresh so the row leaves')
})

test('a cancel the server refuses still leaves a usable screen', async (t) => {
  const net = setup(t, { 'DELETE /api/templates/festive/1': { status: 409, body: { error: 'already sent' } } })
  const ui = await render(<FestiveTab />)
  await click(ui.byRole('button', { name: 'Cancel' }))

  assert.ok(net.to('/api/templates/festive', 'GET').length >= 2, 'the reload is what shows the agent the true state')
  assert.match(ui.text(), /Diwali/)
})

test('a broker with no history sees the catalogue and no ledger', async (t) => {
  setup(t, { '/api/templates/festive': { festivals: FESTIVALS, scheduled: [] } })
  const ui = await render(<FestiveTab />)

  assert.doesNotMatch(ui.text(), /SCHEDULED & SENT/)
  assert.match(ui.text(), /Diwali/)
})

// --- The send sheet ----------------------------------------------------------

test('the sheet opens on the festival’s own default message', async (t) => {
  setup(t)
  const ui = await render(<FestiveTab />)
  await openSheet(ui)

  assert.equal(ui.byLabel(/Message/).props.value, 'Happy Diwali, {name}!')
  assert.match(ui.text(), /each client's name fills in automatically/)
})

test('scheduling is the default, prefilled with 9 AM on the festival’s date', async (t) => {
  setup(t)
  const ui = await render(<FestiveTab />)
  await openSheet(ui)

  assert.equal(ui.byLabel('Send at').props.value, `${soon}T09:00`)
  assert.match(ui.text(), /Schedule greeting/, 'the primary action defaults to scheduling, not blasting')
})

test('a festival whose date has passed opens with no prefilled time', async (t) => {
  // Prefilling a time in the past would make the form fail on submit for a reason the
  // agent cannot see, so the field is left for them to fill.
  setup(t)
  const ui = await render(<FestiveTab />)
  await openSheet(ui, 'Holi')

  assert.equal(ui.byLabel('Send at').props.value, '')
})

test('scheduling sends the festival, the message and the chosen time', async (t) => {
  const net = setup(t, { 'POST /api/templates/festive/send': { scheduled: true } })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)

  await change(ui.byLabel(/Message/), 'Shubh Deepavali, {name}!')
  await change(ui.byLabel('Send at'), `${soon}T18:30`)
  await submit(ui.byRole('button', { name: 'Schedule greeting' }).parent)

  const body = net.to('/api/templates/festive/send', 'POST')[0].body
  assert.equal(body.festival, 'diwali')
  assert.equal(body.message, 'Shubh Deepavali, {name}!')
  assert.equal(new Date(body.send_at).toISOString(), new Date(`${soon}T18:30`).toISOString())
})

test('switching to Send now drops the schedule time from the request', async (t) => {
  // send_at is what the server uses to decide between queueing and blasting. Leaving
  // the prefilled time on a "send now" request would schedule it for a month away and
  // the agent would be told it was scheduled — technically honest, entirely wrong.
  const net = setup(t, { 'POST /api/templates/festive/send': { scheduled: false, sent: 40, recipients: 42 } })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)

  await click(ui.byRole('button', { name: /Send now/ }))
  assert.equal(ui.queryByLabel('Send at'), null, 'the time field is not part of an immediate send')

  await submit(ui.byRole('button', { name: 'Send to all contacts' }).parent)
  const body = net.to('/api/templates/festive/send', 'POST')[0].body
  assert.equal(body.send_at, undefined)
})

test('the toast repeats what the server said it did, not what was asked for', async (t) => {
  setup(t, { 'POST /api/templates/festive/send': { scheduled: false, sent: 40, recipients: 42 } })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)
  await click(ui.byRole('button', { name: /Send now/ }))
  await submit(ui.byRole('button', { name: 'Send to all contacts' }).parent)

  assert.match(ui.text(), /Sent to 40 of 42 contacts/, 'two of the contacts were skipped and the agent has to be told')
})

test('a scheduled send confirms by name', async (t) => {
  setup(t, { 'POST /api/templates/festive/send': { scheduled: true } })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)
  await submit(ui.byRole('button', { name: 'Schedule greeting' }).parent)

  assert.match(ui.text(), /Diwali greeting scheduled/)
})

test('a refused send keeps the sheet open with the message intact', async (t) => {
  setup(t, {
    'POST /api/templates/festive/send': { status: 503, body: { error: 'WhatsApp is not configured' } },
  })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)
  await change(ui.byLabel(/Message/), 'Worth keeping')
  await submit(ui.byRole('button', { name: 'Schedule greeting' }).parent)

  assert.match(ui.text(), /WhatsApp is not configured/)
  assert.equal(ui.byLabel(/Message/).props.value, 'Worth keeping', 'the agent must not have to retype it')
})

test('an empty message cannot be sent to anybody', async (t) => {
  const net = setup(t)
  const ui = await render(<FestiveTab />)
  await openSheet(ui)

  // Whitespace, not emptiness: the field has a default in it, so the way an agent
  // reaches this state is by selecting the message and typing over it.
  await change(ui.byLabel(/Message/), '   ')
  const button = ui.byRole('button', { name: 'Schedule greeting' })
  assert.equal(button.props.disabled, true)

  await click(button)
  assert.equal(net.to('/api/templates/festive/send', 'POST').length, 0)
})

test('a successful send closes the sheet and reloads the ledger', async (t) => {
  const net = setup(t, { 'POST /api/templates/festive/send': { scheduled: true } })
  const ui = await render(<FestiveTab />)
  await openSheet(ui)
  const loadsBefore = net.to('/api/templates/festive', 'GET').length

  await submit(ui.byRole('button', { name: 'Schedule greeting' }).parent)

  assert.equal(ui.queryByLabel(/Message/), null, 'the sheet stayed open over the confirmation')
  assert.ok(net.to('/api/templates/festive', 'GET').length > loadsBefore)
})
