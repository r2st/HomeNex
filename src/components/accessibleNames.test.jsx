// Every form control an agent can reach has to say what it is.
//
// A control with no accessible name is announced by a screen reader as its bare
// role — "edit", "button" — which on a screen with four boxes in a column is the
// same as saying nothing. The gaps below were all of the same shape: the control
// was styled to look obvious (a magnifying-glass search box, a colour swatch, the
// browser's own file picker) and so nobody wrote a label for it.
//
// `byLabel` here resolves a name the way the platform does: an explicit aria-label
// first, then the text of a wrapping <label>. A control that only carries a
// placeholder does not match — which is the point, since a placeholder disappears
// the moment the agent types and is not a name browsers are required to expose.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, act } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ContactsTab from './ContactsTab.jsx'
import PropertiesTab from './PropertiesTab.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'
import AuthScreen from './AuthScreen.jsx'
import InboxTab from './InboxTab.jsx'
import LeadDetail from './LeadDetail.jsx'
import TeamScreen from './TeamScreen.jsx'

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch(routes)
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { net, env }
}

test('the contacts search box is named, not just placeheld', async (t) => {
  setup(t, { 'GET /api/contacts': [], 'GET /api/groups': [] })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)

  const search = ui.byLabel('Search contacts')
  assert.equal(search.type, 'input')
  // type=search is what tells the browser (and assistive tech) this box filters a
  // list rather than collecting a value — it also gets the native clear affordance.
  assert.equal(search.props.type, 'search')
})

test('the properties search box is named', async (t) => {
  setup(t, { 'GET /api/properties': [] })
  const ui = await render(<PropertiesTab onOpenLead={() => {}} />)

  const search = ui.byLabel('Search properties')
  assert.equal(search.props.type, 'search')
})

test('the media file picker says what it uploads', async (t) => {
  setup(t, { 'GET /api/media': [] })
  // The media library is the screen's default tab.
  const ui = await render(<SnippetsMediaScreen />)

  // A file input takes no placeholder at all, so before this it was the one control
  // on the card that announced nothing.
  const picker = ui.byLabel('Choose a file to upload')
  assert.equal(picker.props.type, 'file')
})

test('the label colour swatch is named even though it sits outside its Field', async (t) => {
  setup(t, { 'GET /api/media': [], 'GET /api/labels': [] })
  const ui = await render(<SnippetsMediaScreen />)
  await click(ui.byText('Labels', { selector: 'button' }))

  assert.equal(ui.byLabel('Label colour').props.type, 'color')
  // The name box next to it is labelled the ordinary way, via <Field> — kept in the
  // same assertion so a refactor that drops one of the two is caught.
  assert.equal(ui.byLabel('Name').type, 'input')
})

// --- The controls an agent uses all day -----------------------------------------
//
// The sweep below found the same shape everywhere: a control styled to look obvious,
// carrying a placeholder and no name. A placeholder is not a name — it vanishes the
// moment the agent types, and browsers are not required to expose it — so each of
// these announced as a bare "edit" or "combo box".

test('the phone box on the sign-in screen is named, not just the country code beside it', async (t) => {
  setup(t)
  const ui = await render(<AuthScreen onAuthed={() => {}} />)

  // Both boxes sit inside one <label>. A <label> with no `for` names its FIRST
  // labelable descendant and stops there, so the country-code box took the name and
  // the box holding the actual number got nothing.
  assert.equal(ui.byLabel('Country code').props['aria-label'], 'Country code')
  assert.equal(ui.byLabel('Phone number').props.type, 'tel')
})

const HOUR = 3600_000
const NOW = Date.parse('2026-08-10T12:00:00.000Z')
const thread = {
  id: 5,
  name: 'Priya Sharma',
  wa_id: '919876543210',
  temp: 'Hot',
  ai_enabled: 0,
  last_inbound_at: new Date(NOW - 2 * HOUR).toISOString(),
  labels: [],
  notes: [],
  messages: [{ id: 1, role: 'buyer', text: 'Still available?', created_at: new Date(NOW - HOUR).toISOString() }],
}

test('the WhatsApp composer names the buyer it is replying to', async (t) => {
  const env = installBrowser({ now: NOW })
  const net = mockFetch({
    'GET /api/leads': [thread],
    'GET /api/leads/5': thread,
    'POST /api/leads/5/read': { ok: true },
    'GET /api/leads/5/suggestions': { suggestions: [] },
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  const ui = await render(<InboxTab leadId={5} onSelectLead={() => {}} />)

  // The single most-used control in the app, and it announced nothing at all. The
  // name carries the buyer's name for the same reason the placeholder does: an agent
  // moving between threads needs to know which one they are about to send into.
  const composer = ui.byLabel('Reply to Priya Sharma on WhatsApp')
  assert.equal(composer.type, 'textarea')
})

const lead = {
  id: 5,
  agent_id: 1,
  name: 'Priya Sharma',
  wa_id: '919876543210',
  stage: 'New',
  pipeline_type: 'buy_primary',
  score: 72,
  updated_at: new Date(NOW - HOUR).toISOString(),
  messages: [],
  followups: [],
  site_visits: [],
}

const leadRoutes = {
  'GET /api/leads/5': lead,
  'GET /api/leads/5/autofill': { suggestions: [] },
  'GET /api/leads/5/briefing': { talking_points: [] },
  'GET /api/leads/5/property-matches': [],
  'GET /api/pipeline-stages': [{ id: 1, stage_name: 'New', stage_order: 1 }],
  'GET /api/properties': [{ id: 11, title: 'Prestige Lakeside 3BHK' }],
}

const leadProps = { leadId: 5, onClose: () => {}, onChanged: () => {}, onOpenConversation: () => {} }

test('the site-visit booking fields are named', async (t) => {
  setup(t, leadRoutes)
  const ui = await render(<LeadDetail {...leadProps} />)
  await click(ui.byText('+ Schedule'))

  // A bare datetime-local and a bare select, side by side, both announcing their role
  // and nothing else — indistinguishable from the follow-up form above them.
  assert.equal(ui.byLabel('Site visit date and time').props.type, 'datetime-local')
  assert.equal(ui.byLabel('Property to visit (optional)').type, 'select')
})

test('the custom follow-up fields are named', async (t) => {
  setup(t, leadRoutes)
  const ui = await render(<LeadDetail {...leadProps} />)
  await click(ui.byText('Custom'))

  assert.equal(ui.byLabel('Follow-up date and time').props.type, 'datetime-local')
  assert.equal(ui.byLabel('Follow-up note (optional)').type, 'input')
})

test('each row on the team board says WHICH lead it hands over', async (t) => {
  setup(t, {
    'GET /api/team': {
      team: { id: 1, name: 'Sharma Realty', assignment_strategy: 'manual' },
      members: [{ member_id: 1, agent_id: 1, name: 'Ravi', role: 'owner' }],
      role: 'owner',
    },
    'GET /api/team/leads': [
      { id: 7, name: 'Priya Sharma', wa_id: '919876543210', unassigned: 1, updated_at: new Date(NOW).toISOString() },
      { id: 8, name: 'Arjun Rao', wa_id: '919876543211', unassigned: 0, updated_at: new Date(NOW).toISOString() },
    ],
  })
  const ui = await render(<TeamScreen onBack={() => {}} onOpenLead={() => {}} />)
  // The shared lead board lives under the "Inbox" tab — "Board" is the response-time
  // leaderboard. Members is what the screen opens on.
  await click(ui.byText('Inbox', { selector: 'button' }))
  await act(() => {})

  // A board of rows whose every control announced "Assign to…" told the agent which
  // action they were about to take and nothing about who it would land on.
  assert.equal(ui.byLabel('Assign Priya Sharma to a teammate').type, 'select')
  assert.equal(ui.byLabel('Reassign Arjun Rao to a teammate').type, 'select')
})

test('the invite fields on the team screen are named', async (t) => {
  setup(t, {
    'GET /api/team': {
      team: { id: 1, name: 'Sharma Realty', assignment_strategy: 'manual' },
      members: [{ member_id: 1, agent_id: 1, name: 'Ravi', role: 'owner' }],
      role: 'owner',
    },
    'GET /api/team/leads': [],
  })
  const ui = await render(<TeamScreen onBack={() => {}} onOpenLead={() => {}} />)

  assert.equal(ui.byLabel("Teammate's WhatsApp number").type, 'input')
  assert.equal(ui.byLabel('Role for the new teammate').type, 'select')
})

test('the contact notes and group broadcast boxes are named', async (t) => {
  setup(t, {
    'GET /api/contacts': [{ id: 4, name: 'Priya Sharma', phone: '+919876543210', source: 'whatsapp_inbound', msg_count: 0 }],
    'GET /api/contacts/count': { total: 1 },
    'GET /api/contacts/4': { id: 4, name: 'Priya Sharma', phone: '+919876543210', notes: '', leads: [] },
    'GET /api/groups': [],
  })
  const ui = await render(<ContactsTab onOpenLead={() => {}} />)
  await click(ui.byText('Priya Sharma'))
  await click(ui.byText('Edit'))

  assert.equal(ui.byLabel('Notes about this contact').type, 'textarea')
})
