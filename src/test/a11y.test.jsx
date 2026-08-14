// The audit helpers, audited.
//
// a11ySweep.test.jsx points these at every screen and asserts the result is empty.
// That proves the app is clean; it cannot prove the helpers would notice if it
// weren't — an audit that always returns [] passes every sweep. So this file feeds
// them the shapes they exist to catch, and the near-miss shapes they must not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from './render.jsx'
import { mouseOnlyControls, namelessControls, accessibleNameOf } from './a11y.js'

test('a role="button" span with no tabIndex is reported as mouse-only', async () => {
  // The shape the keyboard sweep exists for: it looks and clicks like a button and
  // is invisible in a screenshot, but a keyboard user cannot reach it at all.
  const ui = await render(
    <div>
      <span role="button" onClick={() => {}}>Archive</span>
    </div>,
  )
  assert.deepEqual(mouseOnlyControls(ui), ['<span> — renders "Archive"'])
})

test('a tabIndex with no key handler is still mouse-only', async () => {
  // Focusable is not operable. Tab reaches it, Enter and Space do nothing.
  const ui = await render(
    <span role="button" tabIndex={0} onClick={() => {}}>Archive</span>,
  )
  assert.equal(mouseOnlyControls(ui).length, 1)
})

test('a negative tabIndex is mouse-only even with a key handler', async () => {
  const ui = await render(
    <span role="button" tabIndex={-1} onClick={() => {}} onKeyDown={() => {}}>Archive</span>,
  )
  assert.equal(mouseOnlyControls(ui).length, 1)
})

test('the InfoTip shape — tabIndex plus a key handler — is operable', async () => {
  // A role="button" span is deliberate in this app: InfoTip nests inside card
  // buttons, where a real nested <button> would be invalid HTML. Carrying both a
  // tabIndex and a key handler is exactly what makes that legitimate, so the sweep
  // must not flag it.
  const ui = await render(
    <span role="button" tabIndex={0} onClick={() => {}} onKeyDown={() => {}}>What is this?</span>,
  )
  assert.deepEqual(mouseOnlyControls(ui), [])
})

test('real controls are operable without any handler of their own', async () => {
  const ui = await render(
    <div>
      <button onClick={() => {}}>Save</button>
      <a href="/leads">Leads</a>
      <input aria-label="Search" />
      <select aria-label="Stage"><option>New</option></select>
      <textarea aria-label="Notes" />
    </div>,
  )
  assert.deepEqual(mouseOnlyControls(ui), [])
})

test('a non-interactive element is not audited for keyboard reach', async () => {
  // Only things the agent can operate have to be operable — a <div> with an onClick
  // and no role is not a control the audit claims jurisdiction over.
  const ui = await render(<div><span>Just text</span></div>)
  assert.deepEqual(mouseOnlyControls(ui), [])
})

test('an icon-only button is reported as nameless, and aria-label fixes it', async () => {
  // The naming sweep's own regression guard: the hidden glyph must not be counted
  // as a name, which is what would let a genuinely silent button score as named.
  const bare = await render(<button><span aria-hidden="true">🗑</span></button>)
  assert.equal(namelessControls(bare).length, 1)

  const labelled = await render(
    <button aria-label="Delete group"><span aria-hidden="true">🗑</span></button>,
  )
  assert.deepEqual(namelessControls(labelled), [])
})

test('a placeholder is not a name', async () => {
  const ui = await render(<input placeholder="Search leads" />)
  assert.equal(namelessControls(ui).length, 1)
})

test('a wrapping label names its first control and only that one', async () => {
  // Country code + phone number in one label is a real shape in this app, and the
  // second box genuinely has no name — the browser stops at the first.
  const ui = await render(
    <label>
      Phone
      <input name="cc" />
      <input name="number" />
    </label>,
  )
  const [cc, number] = [...new Set(namelessControls(ui))]
  assert.equal(cc, '<input name=number>', 'the second box in the label should be the nameless one')
  assert.equal(number, undefined, 'only the second box should be reported')
})

test('accessibleNameOf follows aria-label, then labelledby, then contents, then title', async () => {
  // title is genuinely last: a browser only falls back to it when the element has
  // no contents to read, which is why the third button below is named "×" and not
  // "Retry" — and why an icon-only button cannot be rescued by a tooltip.
  const ui = await render(
    <div>
      <button aria-label="Close" title="ignored">×</button>
      <button aria-labelledby="hdr-1">×</button>
      <button title="Retry">×</button>
      <button title="Retry" />
      <button>Send message</button>
    </div>,
  )
  const [byLabel, byLabelledby, contentsBeatTitle, byTitle, byText] = ui.all((f) => f.type === 'button')
  assert.equal(accessibleNameOf(byLabel), 'Close')
  assert.equal(accessibleNameOf(byLabelledby), 'hdr-1')
  assert.equal(accessibleNameOf(contentsBeatTitle), '×')
  assert.equal(accessibleNameOf(byTitle), 'Retry')
  assert.equal(accessibleNameOf(byText), 'Send message')
})

test('a name made only of symbols does not count as a name', async () => {
  // Stricter than the platform on purpose: "check mark button" identifies nothing
  // on a list of eight follow-ups.
  const ui = await render(<div><button aria-label="✓">x</button><button aria-label="Mark done">x</button></div>)
  assert.equal(namelessControls(ui).length, 1)
})
