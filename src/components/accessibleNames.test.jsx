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
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ContactsTab from './ContactsTab.jsx'
import PropertiesTab from './PropertiesTab.jsx'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch(routes)
  t.after(() => {
    net.restore()
    env.restore()
  })
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
