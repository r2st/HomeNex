// Locale and alert preferences.
//
// This card has no Save button — every control writes on change and the parent is
// handed the updated agent. That makes it the screen where a dropped request is
// easiest to miss: the select still shows the value the agent picked, because it is
// bound to the agent prop that never changed, so a failed save looks exactly like a
// successful one unless the error is shown. Several tests here are about that.
//
// The timezone is the setting with teeth: it decides what counts as "today" for the
// dashboard, follow-ups and site visits. An agent in Dubai left on IST is chasing
// yesterday's list.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import PreferencesCard from './PreferencesCard.jsx'

const AGENT = {
  id: 1,
  name: 'Rohit Sharma',
  language: 'en',
  timezone: 'Asia/Kolkata',
  quiet_hours_start: null,
  quiet_hours_end: null,
  notify_new_lead: 1,
  notify_followup_due: 0,
  notify_daily_digest: 0,
}

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    'PUT /api/agent/preferences': (call) => ({ ...AGENT, ...call.body }),
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const selectFor = (ui, label) => ui.byLabel(label)
const toggleFor = (ui, name) => ui.byRole('switch', { name })
const patches = (net) => net.to('/api/agent/preferences', 'PUT').map((c) => c.body)

// --- Language ---------------------------------------------------------------

test('the language dropdown opens on the agent’s stored language', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={{ ...AGENT, language: 'mr' }} onSaved={() => {}} />)

  assert.equal(selectFor(ui, 'Language').props.value, 'mr')
})

test('an agent with no language stored falls back to English rather than a blank box', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={{ id: 1 }} onSaved={() => {}} />)

  assert.equal(selectFor(ui, 'Language').props.value, 'en')
})

test('every language offered is one the server will accept', async (t) => {
  // The list is duplicated from LANGUAGES in server/db.js, and the API rejects
  // anything else — an option added on only one side is a save that always fails.
  setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  const codes = ui.all((f) => f.type === 'option').map((f) => f.props.value)
  for (const code of ['en', 'hi', 'mr', 'ta', 'te', 'kn', 'gu', 'bn', 'pa', 'ml', 'or']) {
    assert.ok(codes.includes(code), `${code} is missing from the picker`)
  }
})

test('picking a language saves it on its own, with nothing else in the patch', async (t) => {
  const { net } = setup(t)
  const saved = []
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={(a) => saved.push(a)} />)

  await change(selectFor(ui, 'Language'), 'hi')

  assert.deepEqual(patches(net), [{ language: 'hi' }])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].language, 'hi')
  assert.match(ui.text(), /Saved/)
})

// --- Timezone ---------------------------------------------------------------

test('the timezone dropdown opens on the agent’s zone and shows friendly names', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={{ ...AGENT, timezone: 'Asia/Dubai' }} onSaved={() => {}} />)

  assert.equal(selectFor(ui, 'Timezone').props.value, 'Asia/Dubai')
  assert.match(ui.text(), /Dubai \(GST\)/)
  assert.doesNotMatch(ui.text(), /Asia\/Dubai/, 'the raw IANA id leaked into the UI')
})

test('an agent with no timezone stored defaults to India', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={{ id: 1 }} onSaved={() => {}} />)

  assert.equal(selectFor(ui, 'Timezone').props.value, 'Asia/Kolkata')
})

test('an exotic stored zone is still listed, so it is not silently switched', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={{ ...AGENT, timezone: 'Africa/Nairobi' }} onSaved={() => {}} />)

  assert.equal(selectFor(ui, 'Timezone').props.value, 'Africa/Nairobi')
  assert.ok(
    ui.all((f) => f.type === 'option').some((f) => f.props.value === 'Africa/Nairobi'),
    'the stored zone was not an option, so the select showed a value it could not offer',
  )
})

test('the timezone says what it actually controls', async (t) => {
  // "Timezone" alone reads as cosmetic. It decides what counts as today.
  setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  assert.match(ui.text(), /today/i)
  assert.match(ui.text(), /follow-ups/i)
})

test('picking a timezone saves it', async (t) => {
  const { net } = setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  await change(selectFor(ui, 'Timezone'), 'Asia/Dubai')

  assert.deepEqual(patches(net), [{ timezone: 'Asia/Dubai' }])
})

// --- Quiet hours ------------------------------------------------------------

test('quiet hours are off, and the from/to pickers hidden, until switched on', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  assert.equal(toggleFor(ui, 'Quiet hours').props['aria-checked'], false)
  assert.equal(ui.queryByLabel('From'), null)
  assert.equal(ui.queryByLabel('To'), null)
})

test('switching quiet hours on sends a sensible overnight default', async (t) => {
  const { net } = setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  await click(toggleFor(ui, 'Quiet hours'))

  assert.deepEqual(patches(net), [{ quiet_hours_start: 22, quiet_hours_end: 7 }])
})

test('switching quiet hours off clears both ends, not just the start', async (t) => {
  // Leaving an end behind would be a half-configured window the server has to guess at.
  const { net } = setup(t)
  const on = { ...AGENT, quiet_hours_start: 22, quiet_hours_end: 7 }
  const ui = await render(<PreferencesCard agent={on} onSaved={() => {}} />)

  assert.equal(toggleFor(ui, 'Quiet hours').props['aria-checked'], true)
  await click(toggleFor(ui, 'Quiet hours'))

  assert.deepEqual(patches(net), [{ quiet_hours_start: null, quiet_hours_end: null }])
})

test('a quiet window starting at midnight is still "on"', async (t) => {
  // Hour 0 is falsy. A truthiness check here would show midnight-to-seven as off and
  // hide the pickers that prove otherwise.
  setup(t)
  const ui = await render(<PreferencesCard agent={{ ...AGENT, quiet_hours_start: 0, quiet_hours_end: 7 }} onSaved={() => {}} />)

  assert.equal(toggleFor(ui, 'Quiet hours').props['aria-checked'], true)
  assert.ok(ui.queryByLabel('From'), 'the pickers were hidden for a midnight start')
})

test('the from/to pickers save an hour as a number, not the string a select yields', async (t) => {
  const { net } = setup(t)
  const on = { ...AGENT, quiet_hours_start: 22, quiet_hours_end: 7 }
  const ui = await render(<PreferencesCard agent={on} onSaved={() => {}} />)

  await change(ui.byLabel('From'), '21')
  await change(ui.byLabel('To'), '6')

  assert.deepEqual(patches(net), [{ quiet_hours_start: 21 }, { quiet_hours_end: 6 }])
  for (const patch of patches(net)) {
    for (const value of Object.values(patch)) assert.equal(typeof value, 'number')
  }
})

test('the two ends cannot be set to the same hour', async (t) => {
  // A zero-length window silently disables quiet hours while still reading as on.
  setup(t)
  const on = { ...AGENT, quiet_hours_start: 22, quiet_hours_end: 7 }
  const ui = await render(<PreferencesCard agent={on} onSaved={() => {}} />)

  const disabledIn = (label) =>
    ui
      .byLabel(label)
      .children.filter((f) => f.props?.disabled)
      .map((f) => f.props.value)

  assert.deepEqual(disabledIn('From'), [7], 'From let the agent pick the To hour')
  assert.deepEqual(disabledIn('To'), [22], 'To let the agent pick the From hour')
})

// --- Alerts, which are not built yet ----------------------------------------

test('the alert toggles are labelled "coming soon" and cannot be flipped', async (t) => {
  // Shipping live-looking switches that do nothing is worse than shipping none: an
  // agent turns on "New lead arrives" and then trusts an alert that never comes.
  const { net } = setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  assert.match(ui.text(), /Coming soon/i)
  for (const name of ['New lead arrives', 'Follow-up is due', 'Daily digest']) {
    const toggle = toggleFor(ui, name)
    assert.equal(toggle.props.disabled, true, `${name} looked flippable`)
    await click(toggle)
  }
  assert.deepEqual(patches(net), [], 'a disabled alert toggle still wrote to the server')
})

test('each alert toggle reflects what is stored, so the state is not a lie either', async (t) => {
  setup(t)
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  assert.equal(toggleFor(ui, 'New lead arrives').props['aria-checked'], true)
  assert.equal(toggleFor(ui, 'Follow-up is due').props['aria-checked'], false)
  assert.equal(toggleFor(ui, 'Daily digest').props['aria-checked'], false)
})

// --- Failure ----------------------------------------------------------------

test('a dropped save is reported, not swallowed by a control that still looks right', async (t) => {
  // The select is bound to the agent prop, which a failed save never updates — so
  // without the error the screen is indistinguishable from a successful save.
  setup(t, { 'PUT /api/agent/preferences': { status: 500, body: { error: 'Something went wrong' } } })
  const saved = []
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={(a) => saved.push(a)} />)

  await change(selectFor(ui, 'Language'), 'hi')

  assert.match(ui.text(), /Something went wrong/)
  assert.doesNotMatch(ui.text(), /Saved/, 'a failed save reported success')
  assert.deepEqual(saved, [], 'the parent was told about a save that never happened')
})

test('a failed save leaves the controls usable for a retry', async (t) => {
  const { net } = setup(t, {
    'PUT /api/agent/preferences': { status: 500, body: { error: 'Something went wrong' } },
  })
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  await change(selectFor(ui, 'Language'), 'hi')
  assert.equal(selectFor(ui, 'Language').props.disabled, false, 'the card stayed stuck in its busy state')

  net.set('PUT /api/agent/preferences', (call) => ({ ...AGENT, ...call.body }))
  await change(selectFor(ui, 'Language'), 'hi')

  assert.match(ui.text(), /Saved/)
  assert.doesNotMatch(ui.text(), /Something went wrong/, 'the stale error outlived the retry')
})

test('a fresh save clears the previous error before it starts', async (t) => {
  const { net } = setup(t, {
    'PUT /api/agent/preferences': { status: 500, body: { error: 'Something went wrong' } },
  })
  const ui = await render(<PreferencesCard agent={AGENT} onSaved={() => {}} />)

  await change(selectFor(ui, 'Language'), 'hi')
  assert.match(ui.text(), /Something went wrong/)

  net.set('PUT /api/agent/preferences', (call) => ({ ...AGENT, ...call.body }))
  await change(selectFor(ui, 'Timezone'), 'Asia/Dubai')

  assert.doesNotMatch(ui.text(), /Something went wrong/)
})
