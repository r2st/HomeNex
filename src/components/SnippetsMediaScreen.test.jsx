// The Snippets & Media screen — four managers behind four chips, and until now the
// only file of its size with no test of its own. What coverage it had came from
// MoreTab opening it, which renders the media tab and stops there: the other three
// managers, every create, every delete and the whole of useList's failure arm had
// never run.
//
// The claim each manager makes is the same one: what an agent types is what gets
// sent, a delete asks first, and a list that could not load says so instead of
// reading as empty. That last one is the reason useList exists (see its comment) and
// it is the one a screen like this gets wrong quietly — a Templates tab that renders
// "No templates yet." after a 500 sends an agent back to Meta review for messages
// they already have approved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click, change, fire } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import SnippetsMediaScreen from './SnippetsMediaScreen.jsx'

const asset = (over = {}) => ({ id: 1, title: 'Green Acres brochure', kind: 'brochure', sent_count: 3, ...over })
const template = (over = {}) => ({
  id: 1, name: 'Weekly follow-up', category: 'utility', body: 'Hi {{name}}, any thoughts?',
  is_system: false, is_locked: false, meta_status: 'pending', rera_auto_append: false, ...over,
})
const reply = (over = {}) => ({ id: 1, title: 'Ask budget', body: 'What budget are you working with?', is_system: false, ...over })
const label = (over = {}) => ({ id: 1, name: 'NRI buyer', color: '#64748b', is_system: false, ...over })

// Every manager loads its own list, so a test that only cares about one of them still
// has to answer for the rest — an unmocked route is a 404, which is a load error, and
// a load error is exactly what half these tests are asserting the absence of.
const BASE = {
  'GET /api/media': [],
  'GET /api/templates': [],
  'GET /api/quick-replies': [],
  'GET /api/labels': [],
}

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({ ...BASE, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// The screen opens on Media; the other three are one chip away.
const openTab = (ui, name) => click(ui.byRole('button', { name }))

// --- The chips ---------------------------------------------------------------

test('each chip swaps in its own manager, and only that one', async (t) => {
  setup(t)
  const ui = await render(<SnippetsMediaScreen />)

  assert.match(ui.text(), /Add to library/, 'the screen opens on the media library')
  assert.doesNotMatch(ui.text(), /New template/)

  await openTab(ui, 'Templates')
  assert.match(ui.text(), /New template/)
  assert.match(ui.text(), /Approved messages for buyers who haven't replied in 24 hours/)
  assert.doesNotMatch(ui.text(), /Add to library/, 'the media manager went away with its tab')

  await openTab(ui, 'Quick replies')
  assert.match(ui.text(), /New quick reply/)
  assert.match(ui.text(), /Shortcuts you drop into a live chat/)
  assert.doesNotMatch(ui.text(), /New template/)

  await openTab(ui, 'Labels')
  assert.match(ui.text(), /New label/)
  assert.match(ui.text(), /six lifecycle labels are applied automatically/)
  assert.doesNotMatch(ui.text(), /New quick reply/)
})

// --- useList's failure arm ---------------------------------------------------

test('a list that could not load says so instead of reading as empty', async (t) => {
  // The whole point of useList. Each of these four routes fails, and each manager has
  // an empty-state sentence one render away from being shown in its place.
  const failures = [
    ['Media library', { 'GET /api/media': { status: 500, body: { error: 'Media is down' } } }, /Nothing in the library yet/, 'Media is down'],
    ['Templates', { 'GET /api/templates': { status: 500, body: { error: 'Templates are down' } } }, /No templates yet/, 'Templates are down'],
    ['Quick replies', { 'GET /api/quick-replies': { status: 500, body: { error: 'Replies are down' } } }, /No quick replies yet/, 'Replies are down'],
    ['Labels', { 'GET /api/labels': { status: 500, body: { error: 'Labels are down' } } }, /No labels yet/, 'Labels are down'],
  ]
  for (const [tab, routes, emptyState, message] of failures) {
    const env = installBrowser()
    const net = mockFetch({ ...BASE, ...routes })
    const ui = await render(<SnippetsMediaScreen />)
    if (tab !== 'Media library') await openTab(ui, tab)

    assert.match(ui.text(), new RegExp(message), `${tab} must surface the failure it got`)
    assert.doesNotMatch(ui.text(), emptyState, `${tab} told the agent their list is empty when it simply could not load it`)
    net.restore()
    env.restore()
  }
})

// --- Media library -----------------------------------------------------------

// A file input has no `value` to change; the component reads e.target.files[0].
const chooseFile = (ui, file) =>
  fire(ui.byLabel('Choose a file to upload to the library'), 'onChange', { target: { files: [file] } })

// FileReader is a browser API the shim has no need for anywhere else, so it is
// installed per-test by the two tests that upload.
function installFileReader(t, { fail = false } = {}) {
  const saved = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file.name}`
      queueMicrotask(() => (fail ? this.onerror(new Error('unreadable')) : this.onload()))
    }
  }
  t.after(() => {
    if (saved === undefined) delete globalThis.FileReader
    else globalThis.FileReader = saved
  })
}

test('an upload sends the chosen kind, the typed title and the read bytes', async (t) => {
  installFileReader(t)
  const { net } = setup(t, { 'POST /api/media': { id: 9 } })
  const ui = await render(<SnippetsMediaScreen />)

  await click(ui.byRole('button', { name: /floor plan/ }))
  await change(ui.byLabel('Title'), 'Tower B floor plan')
  await chooseFile(ui, { name: 'towerB.pdf', type: 'application/pdf' })

  const [sent] = net.to('/api/media', 'POST')
  assert.deepEqual(sent.body, {
    title: 'Tower B floor plan',
    kind: 'floor_plan',
    data_base64: 'data:application/pdf;base64,towerB.pdf',
    filename: 'towerB.pdf',
    mime: 'application/pdf',
  })
  assert.equal(net.to('/api/media', 'GET').length, 2, 'the library reloads so the new file appears')
  assert.equal(ui.byLabel('Title').props.value, '', 'the title box is cleared for the next upload')
})

test('an untitled upload is filed under its filename rather than blank', async (t) => {
  installFileReader(t)
  const { net } = setup(t, { 'POST /api/media': { id: 9 } })
  const ui = await render(<SnippetsMediaScreen />)

  await chooseFile(ui, { name: 'sitemap.png', type: 'image/png' })

  assert.equal(net.to('/api/media', 'POST')[0].body.title, 'sitemap.png')
})

test('choosing nothing does not post an empty file', async (t) => {
  const { net } = setup(t)
  const ui = await render(<SnippetsMediaScreen />)

  await fire(ui.byLabel('Choose a file to upload to the library'), 'onChange', { target: { files: [] } })

  assert.equal(net.to('/api/media', 'POST').length, 0)
})

test('a rejected upload leaves the reason on screen', async (t) => {
  installFileReader(t)
  setup(t, { 'POST /api/media': { status: 413, body: { error: 'That file is larger than 25MB' } } })
  const ui = await render(<SnippetsMediaScreen />)

  await chooseFile(ui, { name: 'huge.mp4', type: 'video/mp4' })

  assert.match(ui.text(), /That file is larger than 25MB/)
  assert.doesNotMatch(ui.text(), /Uploading…/, 'the busy state clears even when the upload failed')
})

test('a file the browser cannot read is reported, not swallowed', async (t) => {
  installFileReader(t, { fail: true })
  const { net } = setup(t)
  const ui = await render(<SnippetsMediaScreen />)

  await chooseFile(ui, { name: 'locked.pdf', type: 'application/pdf' })

  assert.equal(net.to('/api/media', 'POST').length, 0, 'nothing was uploaded')
  assert.match(ui.text(), /unreadable/)
})

test('a library file lists how many contacts it reached, in the singular when it is one', async (t) => {
  setup(t, { 'GET /api/media': [asset(), asset({ id: 2, title: 'Site photo', kind: 'photo', sent_count: 1 })] })
  const ui = await render(<SnippetsMediaScreen />)

  assert.match(ui.text(), /brochure · sent to 3 contacts/)
  assert.equal(ui.byText(/sent to 1 contact/).children.map((c) => c.text).join(''), 'photo · sent to 1 contact',
    'one contact is a contact, not "1 contacts"')
})

test('deleting a library file asks first, and names the file it is about to remove', async (t) => {
  const { net } = setup(t, { 'GET /api/media': [asset()], 'DELETE /api/media/1': { ok: true } })
  const ui = await render(<SnippetsMediaScreen />)

  await click(ui.byRole('button', { name: 'delete' }))
  assert.match(ui.text(), /Delete "Green Acres brochure"\?/)
  assert.equal(net.to('/api/media/1', 'DELETE').length, 0, 'nothing is deleted until the agent says so')

  await click(ui.byRole('button', { name: 'Cancel' }))
  assert.equal(net.to('/api/media/1', 'DELETE').length, 0, 'and cancelling means cancelled')

  await click(ui.byRole('button', { name: 'delete' }))
  await click(ui.byRole('button', { name: /^Delete$/ }))
  assert.equal(net.to('/api/media/1', 'DELETE').length, 1)
  assert.equal(net.to('/api/media', 'GET').length, 2, 'the library reloads after the delete')
})

// --- Templates ---------------------------------------------------------------

test('a template is created with the category chip that is lit, not the default', async (t) => {
  const { net } = setup(t, { 'POST /api/templates': { id: 5 } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  await change(ui.byLabel('Name'), '  Diwali offer  ')
  await change(ui.byLabel('Body'), 'Wishing you a bright Diwali!')
  await click(ui.byRole('button', { name: 'Promotion' }))
  await click(ui.byRole('button', { name: 'Add template' }))

  assert.deepEqual(net.to('/api/templates', 'POST')[0].body, {
    name: 'Diwali offer',
    category: 'marketing',
    body: 'Wishing you a bright Diwali!',
    rera_auto_append: false,
  })
})

test('the RERA opt-in appears only for a promotion, because only a promotion needs it', async (t) => {
  const { net } = setup(t, { 'POST /api/templates': { id: 5 } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.equal(ui.queryByText(/Auto-append my RERA number/), null, 'a reminder is not an advertisement')

  await click(ui.byRole('button', { name: 'Promotion' }))
  const optIn = ui.byLabel('Auto-append my RERA number')
  await fire(optIn, 'onChange', { target: { checked: true } })

  await change(ui.byLabel('Name'), 'New listing')
  await change(ui.byLabel('Body'), '3 BHK in Wakad')
  await click(ui.byRole('button', { name: 'Add template' }))

  assert.equal(net.to('/api/templates', 'POST')[0].body.rera_auto_append, true)
})

test('a variable chip appends its token rather than replacing what is typed', async (t) => {
  setup(t)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  await click(ui.byRole('button', { name: 'Name' }))
  assert.equal(ui.byLabel('Body').props.value, '{{name}}', 'the first chip starts the body')

  await click(ui.byRole('button', { name: 'Visit time' }))
  assert.equal(ui.byLabel('Body').props.value, '{{name}} {{visit_time}}', 'the second is appended, space-separated')
})

test('Add template stays disabled until both halves are filled in', async (t) => {
  setup(t)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')
  const button = () => ui.byRole('button', { name: 'Add template' })

  assert.equal(button().props.disabled, true)
  await change(ui.byLabel('Name'), 'Half done')
  assert.equal(button().props.disabled, true, 'a name with no body is not a template')
  await change(ui.byLabel('Body'), '   ')
  assert.equal(button().props.disabled, true, 'and whitespace is not a body')
  await change(ui.byLabel('Body'), 'Real body')
  assert.equal(button().props.disabled, false)
})

test('a refused template creation is reported next to the form', async (t) => {
  setup(t, { 'POST /api/templates': { status: 400, body: { error: 'A template with that name already exists' } } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  await change(ui.byLabel('Name'), 'Weekly follow-up')
  await change(ui.byLabel('Body'), 'Hi again')
  await click(ui.byRole('button', { name: 'Add template' }))

  assert.match(ui.text(), /A template with that name already exists/)
})

test('a locked or system template offers no delete, and an editable one does', async (t) => {
  setup(t, {
    'GET /api/templates': [
      template({ id: 1, name: 'Mine', category: 'service' }),
      template({ id: 2, name: 'Approved one', meta_status: 'approved' }),
      template({ id: 3, name: 'From the pack', is_system: true, category: 'marketing', rera_auto_append: true }),
    ],
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.equal(ui.allByText('delete', { selector: 'button' }).length, 2,
    'only the pack template is undeletable; an approved one can still be removed locally')
  assert.match(ui.text(), /🔒/, 'the approved template is marked locked')
  assert.match(ui.text(), /pack/)
  assert.match(ui.text(), /\+ RERA auto-appended/)
  // The three category labels the agent actually reads.
  assert.match(ui.text(), /Reply/)
  assert.match(ui.text(), /Reminder/)
  assert.match(ui.text(), /Promotion/)
})

test('an unrecognised category is printed as it came, not blanked', async (t) => {
  setup(t, { 'GET /api/templates': [template({ category: 'authentication' })] })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  assert.match(ui.text(), /authentication/)
})

test('a template delete that is refused closes the dialog and says why on the form', async (t) => {
  // The two managers answer a refused delete differently, and both are deliberate.
  // TemplatesManager catches inside onConfirm, so useConfirm sees a success: the
  // dialog closes and the reason is left on the form, where the create button's
  // errors also appear. MediaManager lets it throw — see the next test.
  const { net } = setup(t, {
    'GET /api/templates': [template()],
    'DELETE /api/templates/1': { status: 409, body: { error: 'That template is in use by a scheduled send' } },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  await click(ui.byRole('button', { name: 'delete' }))
  assert.match(ui.text(), /Delete template "Weekly follow-up"\?/)

  await click(ui.byRole('button', { name: /^Delete$/ }))
  assert.equal(net.to('/api/templates/1', 'DELETE').length, 1)
  assert.equal(ui.queryByRole('alertdialog'), null)
  assert.match(ui.text(), /That template is in use by a scheduled send/,
    'the template is still listed, so the agent has to be told why it did not go')
  assert.match(ui.text(), /Weekly follow-up/)
})

test('a media delete that is refused leaves the dialog up rather than looking done', async (t) => {
  // The other half of that pair: nothing catches here, so useConfirm's own failure
  // arm runs — the dialog stays open and stops saying "Please wait…", which is the
  // only signal an agent gets that the file is still there.
  const { net } = setup(t, {
    'GET /api/media': [asset()],
    'DELETE /api/media/1': { status: 500, body: { error: 'storage unavailable' } },
  })
  const ui = await render(<SnippetsMediaScreen />)

  await click(ui.byRole('button', { name: 'delete' }))
  await click(ui.byRole('button', { name: /^Delete$/ }))

  assert.equal(net.to('/api/media/1', 'DELETE').length, 1)
  assert.ok(ui.queryByRole('alertdialog'), 'the dialog is still up')
  assert.doesNotMatch(ui.text(), /Please wait…/, 'and it is asking again, not stuck mid-delete')
  assert.equal(net.to('/api/media', 'GET').length, 1, 'the library was not reloaded — nothing changed')
})

test('a template delete that works closes the dialog and reloads the list', async (t) => {
  let templates = [template()]
  const { net } = setup(t, {
    'GET /api/templates': () => templates,
    'DELETE /api/templates/1': () => {
      templates = []
      return { ok: true }
    },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Templates')

  await click(ui.byRole('button', { name: 'delete' }))
  await click(ui.byRole('button', { name: /^Delete$/ }))

  assert.equal(net.to('/api/templates', 'GET').length, 2)
  assert.equal(ui.queryByRole('alertdialog'), null)
  assert.match(ui.text(), /No templates yet/, 'the list reloaded and is genuinely empty now')
})

// --- Quick replies -----------------------------------------------------------

test('a quick reply is created from the trimmed title and the body, then cleared', async (t) => {
  const { net } = setup(t, { 'POST /api/quick-replies': { id: 4 } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Quick replies')

  await change(ui.byLabel('Shortcut / title'), '  Ask budget  ')
  await change(ui.byLabel('Body'), 'What budget are you working with?')
  await click(ui.byRole('button', { name: 'Add quick reply' }))

  assert.deepEqual(net.to('/api/quick-replies', 'POST')[0].body, {
    title: 'Ask budget',
    body: 'What budget are you working with?',
  })
  assert.equal(ui.byLabel('Shortcut / title').props.value, '')
  assert.equal(ui.byLabel('Body').props.value, '')
  assert.equal(net.to('/api/quick-replies', 'GET').length, 2)
})

test('a quick reply body takes the variable chips too', async (t) => {
  setup(t)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Quick replies')

  await change(ui.byLabel('Body'), 'Hi')
  await click(ui.byRole('button', { name: 'Property' }))

  assert.equal(ui.byLabel('Body').props.value, 'Hi {{property}}')
})

test('a default quick reply is marked as one, and deleting reloads the list', async (t) => {
  const { net } = setup(t, {
    'GET /api/quick-replies': [reply(), reply({ id: 2, title: 'Share brochure', is_system: true })],
    'DELETE /api/quick-replies/1': { ok: true },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Quick replies')

  assert.match(ui.text(), /default/)
  await click(ui.allByText('delete', { selector: 'button' })[0])

  assert.equal(net.to('/api/quick-replies/1', 'DELETE').length, 1)
  assert.equal(net.to('/api/quick-replies', 'GET').length, 2)
})

// --- Labels ------------------------------------------------------------------

test('a label is created with the colour the swatch is set to', async (t) => {
  const { net } = setup(t, { 'POST /api/labels': { id: 7 } })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  await change(ui.byLabel('Name'), '  NRI buyer  ')
  await change(ui.byLabel('Label colour'), '#ff0055')
  await click(ui.byRole('button', { name: 'Add label' }))

  assert.deepEqual(net.to('/api/labels', 'POST')[0].body, { name: 'NRI buyer', color: '#ff0055' })
  assert.equal(ui.byLabel('Name').props.value, '')
})

test('Add label needs a name, and a blank one is not a name', async (t) => {
  setup(t)
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  assert.equal(ui.byRole('button', { name: 'Add label' }).props.disabled, true)
  await change(ui.byLabel('Name'), '   ')
  assert.equal(ui.byRole('button', { name: 'Add label' }).props.disabled, true)
  await change(ui.byLabel('Name'), 'Investor')
  assert.equal(ui.byRole('button', { name: 'Add label' }).props.disabled, false)
})

test('the six lifecycle labels carry no remove button; an agent-made one does', async (t) => {
  const { net } = setup(t, {
    'GET /api/labels': [label(), label({ id: 2, name: 'Hot', color: '#ef4444', is_system: true })],
    'DELETE /api/labels/1': { ok: true },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  const removes = ui.allByText('✕', { selector: 'button' })
  assert.equal(removes.length, 1, 'only the agent-made label can be removed')

  await click(removes[0])
  assert.equal(net.to('/api/labels/1', 'DELETE').length, 1)
  assert.equal(net.to('/api/labels', 'GET').length, 2)
})

test('a label delete that fails still refreshes the list rather than leaving a ghost row', async (t) => {
  // deleteLabel swallows its error on purpose — a label that is already gone, or one
  // the server refused, must not leave the screen showing a row that is not there.
  // The reload is what settles it either way.
  const { net } = setup(t, {
    'GET /api/labels': [label()],
    'DELETE /api/labels/1': { status: 500, body: { error: 'nope' } },
  })
  const ui = await render(<SnippetsMediaScreen />)
  await openTab(ui, 'Labels')

  await click(ui.byText('✕', { selector: 'button' }))

  assert.equal(net.to('/api/labels', 'GET').length, 2, 'the list was re-read despite the failure')
  assert.doesNotMatch(ui.text(), /nope/, 'and the agent is not shown a raw server error for a label')
})
