// Shared UI primitives. These are used on every screen, so a regression here is a
// regression everywhere — particularly the confirm dialog that guards deletes and
// the error boundary that stands between a render crash and a white screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { render, click, keyDown, act } from '../test/render.jsx'
import { installBrowser } from '../test/browserEnv.js'
import { InfoTip, ScoreRing, Avatar, Sheet, SlideOver, Chip, Field, Confirm, useConfirm, Skeleton, LoadingRows, ErrorBoundary, TEMP_STYLE } from './ui.jsx'

// --- InfoTip ---------------------------------------------------------------

test('the info tip stays closed until tapped', async () => {
  const ui = await render(<InfoTip text="RERA is the regulator" label="RERA" />)

  assert.doesNotMatch(ui.text(), /RERA is the regulator/)
  await click(ui.byLabel('What is RERA?'))
  assert.match(ui.text(), /RERA is the regulator/)
})

test('the info tip opens on Enter and Space for keyboard users', async () => {
  const ui = await render(<InfoTip text="Explanation" label="X" />)

  await keyDown(ui.byLabel('What is X?'), 'Enter')
  assert.match(ui.text(), /Explanation/)

  await keyDown(ui.byLabel('What is X?'), 'Enter')
  assert.doesNotMatch(ui.text(), /Explanation/)

  await keyDown(ui.byLabel('What is X?'), ' ')
  assert.match(ui.text(), /Explanation/)
})

test('other keys do not toggle the info tip', async () => {
  const ui = await render(<InfoTip text="Explanation" label="X" />)

  await keyDown(ui.byLabel('What is X?'), 'Tab')
  assert.doesNotMatch(ui.text(), /Explanation/)
})

test('the info tip does not trigger the card it is nested inside', async () => {
  let cardTaps = 0
  const ui = await render(
    <button onClick={() => cardTaps++}>
      Lead card
      <InfoTip text="Explanation" label="RERA" />
    </button>,
  )

  await click(ui.byLabel('What is RERA?'))
  assert.equal(cardTaps, 0, 'tapping the ⓘ inside a card must not open the card')
  assert.match(ui.text(), /Explanation/)
})

test('an info tip with no label still has an accessible name', async () => {
  const ui = await render(<InfoTip text="Explanation" />)

  assert.ok(ui.queryByLabel('More info'))
})

// --- ScoreRing / Avatar ----------------------------------------------------

test('the score ring shows a dash rather than 0 for an unscored lead', async () => {
  const ui = await render(<ScoreRing score={null} />)

  assert.match(ui.text(), /–/)
})

test('the score ring colours hot, warm and cold differently', async () => {
  const colourOf = (view) => view.get((f) => f.type === 'span', 'label').props.style.color

  assert.notEqual(colourOf(await render(<ScoreRing score={85} />)), colourOf(await render(<ScoreRing score={60} />)))
  assert.notEqual(colourOf(await render(<ScoreRing score={60} />)), colourOf(await render(<ScoreRing score={10} />)))
})

test('the avatar takes up to two initials, uppercased', async () => {
  assert.equal((await render(<Avatar name="priya sharma" />)).text(), 'PS')
  assert.equal((await render(<Avatar name="Amit" />)).text(), 'A')
  assert.equal((await render(<Avatar name="a b c d" />)).text(), 'AB')
})

test('the avatar falls back to a placeholder for a nameless contact', async () => {
  assert.equal((await render(<Avatar name={null} />)).text(), '?')
  assert.equal((await render(<Avatar name="" />)).text(), '?')
  assert.equal((await render(<Avatar name={undefined} />)).text(), '?')
})

test('a name that is only whitespace is as nameless as an empty one', async () => {
  // WhatsApp profile names arrive as free text; a single space used to split into
  // empty words and render a blank circle instead of the placeholder.
  assert.equal((await render(<Avatar name=" " />)).text(), '?')
  // Braces, not a JSX string: attribute literals don't process \t.
  assert.equal((await render(<Avatar name={'   \t\n '} />)).text(), '?')
})

test('the avatar ignores padding around a real name', async () => {
  assert.equal((await render(<Avatar name="  priya   sharma  " />)).text(), 'PS')
})

// --- Sheet / SlideOver -----------------------------------------------------

test('the sheet renders its title and children and closes on the backdrop', async () => {
  let closed = 0
  const ui = await render(
    <Sheet title="Add lead" onClose={() => closed++}>
      <p>body content</p>
    </Sheet>,
  )

  assert.match(ui.text(), /Add lead/)
  assert.match(ui.text(), /body content/)

  await click(ui.get((f) => typeof f.props.onClick === 'function', 'backdrop'))
  assert.equal(closed, 1)
})

test('a sheet with no title renders only its children', async () => {
  const ui = await render(
    <Sheet onClose={() => {}}>
      <p>just content</p>
    </Sheet>,
  )

  assert.equal(ui.text(), 'just content')
})

test('the slide-over closes on the backdrop', async () => {
  let closed = 0
  const ui = await render(
    <SlideOver onClose={() => closed++}>
      <p>panel</p>
    </SlideOver>,
  )

  await click(ui.get((f) => typeof f.props.onClick === 'function', 'backdrop'))
  assert.equal(closed, 1)
})

// Both overlays are dismissable only by tapping the backdrop, which no keyboard can
// reach — so the dialog role and the Escape key are the whole keyboard exit.

test('the sheet is a labelled modal dialog', async () => {
  const titled = await render(
    <Sheet title="Add lead" onClose={() => {}}>
      <p>body</p>
    </Sheet>,
  )
  const dialog = titled.byRole('dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  const labelId = dialog.props['aria-labelledby']
  assert.ok(labelId, 'a titled sheet must point at its title')
  assert.equal(titled.get((f) => f.props?.id === labelId, 'title node').props.children, 'Add lead')

  // With no title there is no node to point at, so it needs a name of its own.
  const untitled = await render(<Sheet onClose={() => {}}><p>body</p></Sheet>)
  assert.equal(untitled.byRole('dialog').props['aria-labelledby'], undefined)
  assert.equal(untitled.byRole('dialog').props['aria-label'], 'Options')
})

test('the slide-over is a modal dialog with a caller-supplied name', async () => {
  const ui = await render(<SlideOver onClose={() => {}} label="Lead details"><p>panel</p></SlideOver>)
  assert.equal(ui.byRole('dialog').props['aria-modal'], 'true')
  assert.equal(ui.byRole('dialog').props['aria-label'], 'Lead details')

  const fallback = await render(<SlideOver onClose={() => {}}><p>panel</p></SlideOver>)
  assert.equal(fallback.byRole('dialog').props['aria-label'], 'Details')
})

test('Escape closes the sheet and the slide-over', async (t) => {
  const env = installBrowser()
  t.after(() => env.restore())

  let sheetClosed = 0
  await render(<Sheet title="Add lead" onClose={() => sheetClosed++}><p>body</p></Sheet>)
  await act(() => env.press('Escape'))
  assert.equal(sheetClosed, 1)

  let overClosed = 0
  await render(<SlideOver onClose={() => overClosed++}><p>panel</p></SlideOver>)
  await act(() => env.press('Escape'))
  assert.equal(overClosed, 1)
})

test('a key that is not Escape leaves the sheet open', async (t) => {
  const env = installBrowser()
  t.after(() => env.restore())

  let closed = 0
  await render(<Sheet title="Add lead" onClose={() => closed++}><p>body</p></Sheet>)
  await act(() => env.press('Enter'))
  await act(() => env.press('a'))
  assert.equal(closed, 0)
})

test('an unmounted overlay stops listening for Escape', async (t) => {
  const env = installBrowser()
  t.after(() => env.restore())

  let closed = 0
  const ui = await render(<Sheet title="Add lead" onClose={() => closed++}><p>body</p></Sheet>)
  assert.equal(env.liveKeyListeners, 1)

  ui.unmount()
  assert.equal(env.liveKeyListeners, 0, 'the sheet left a document listener behind')
  await act(() => env.press('Escape'))
  assert.equal(closed, 0)
})

// --- Chip / Field ----------------------------------------------------------

test('the chip reflects its active state and fires onClick', async () => {
  let taps = 0
  const active = await render(<Chip active onClick={() => taps++}>Hot</Chip>)
  const inactive = await render(<Chip onClick={() => taps++}>Cold</Chip>)

  assert.match(active.byRole('button').props.className, /bg-ink/)
  assert.match(inactive.byRole('button').props.className, /bg-card/)

  await click(active.byRole('button'))
  assert.equal(taps, 1)
})

test('a selectable chip announces whether it is selected', async () => {
  // Selection is carried by background colour alone otherwise, which a screen
  // reader cannot see — the tag and channel pickers become unreadable.
  const on = await render(<Chip active onClick={() => {}}>Hot</Chip>)
  const off = await render(<Chip active={false} onClick={() => {}}>Cold</Chip>)
  assert.equal(on.byRole('button').props['aria-pressed'], true)
  assert.equal(off.byRole('button').props['aria-pressed'], false)

  // A chip used as a plain action button is not a toggle and must not claim to be.
  const plain = await render(<Chip onClick={() => {}}>Add</Chip>)
  assert.equal(plain.byRole('button').props['aria-pressed'], undefined)
})

test('a chip never submits a form it happens to sit inside', async () => {
  const ui = await render(<Chip onClick={() => {}}>Hot</Chip>)
  assert.equal(ui.byRole('button').props.type, 'button')
})

test('the field label is associated with its control', async () => {
  const ui = await render(
    <Field label="Phone number">
      <input placeholder="tel" />
    </Field>,
  )

  assert.equal(ui.byLabel('Phone number').props.placeholder, 'tel')
})

// --- Confirm / useConfirm --------------------------------------------------

test('the confirm dialog names what is being deleted and is a modal alertdialog', async () => {
  const ui = await render(<Confirm title='Delete "Baner brochure"?' message="This cannot be undone." onConfirm={() => {}} onCancel={() => {}} />)

  const dialog = ui.byRole('alertdialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.match(ui.text(), /Delete "Baner brochure"\?/)
  assert.match(ui.text(), /This cannot be undone/)

  // aria-modal alone gives the dialog no name; without these it is announced as an
  // unlabelled alert and the agent never hears which object is about to be deleted.
  const titleId = dialog.props['aria-labelledby']
  const msgId = dialog.props['aria-describedby']
  assert.ok(titleId && msgId)
  assert.match(String(ui.get((f) => f.props?.id === titleId, 'title').props.children), /Baner brochure/)
  assert.match(String(ui.get((f) => f.props?.id === msgId, 'message').props.children), /cannot be undone/)
})

test('a confirm with no message describes nothing rather than pointing at a missing node', async () => {
  const ui = await render(<Confirm title="Delete?" onConfirm={() => {}} onCancel={() => {}} />)
  assert.equal(ui.byRole('alertdialog').props['aria-describedby'], undefined)
  assert.ok(ui.byRole('alertdialog').props['aria-labelledby'])
})

test('Escape cancels the confirm dialog, but never mid-action', async (t) => {
  const env = installBrowser()
  t.after(() => env.restore())

  let cancels = 0
  await render(<Confirm title="Delete?" onConfirm={() => {}} onCancel={() => cancels++} />)
  await act(() => env.press('Escape'))
  assert.equal(cancels, 1)

  // While the delete it guards is in flight, Escape must not yank the dialog away.
  let busyCancels = 0
  await render(<Confirm title="Delete?" busy onConfirm={() => {}} onCancel={() => busyCancels++} />)
  await act(() => env.press('Escape'))
  assert.equal(busyCancels, 0)
})

test('the confirm dialog defaults to a destructive Delete action', async () => {
  const ui = await render(<Confirm title="Delete?" onConfirm={() => {}} onCancel={() => {}} />)

  assert.match(ui.byText('Delete', { exact: true }).props.className, /bg-hot/)
  assert.ok(ui.queryByText('Cancel'))
})

test('a non-destructive confirm uses the brand colour and a custom label', async () => {
  const ui = await render(<Confirm title="Send?" danger={false} confirmLabel="Send now" onConfirm={() => {}} onCancel={() => {}} />)

  assert.match(ui.byText('Send now').props.className, /bg-brand/)
})

test('a busy confirm dialog cannot be double-submitted or dismissed', async () => {
  let confirms = 0
  let cancels = 0
  const ui = await render(<Confirm title="Delete?" busy onConfirm={() => confirms++} onCancel={() => cancels++} />)

  assert.match(ui.text(), /Please wait…/)
  await click(ui.byText('Please wait…'))
  await click(ui.byText('Cancel'))
  await click(ui.get((f) => f.props.className?.includes('absolute inset-0'), 'backdrop'))

  assert.equal(confirms, 0)
  assert.equal(cancels, 0)
})

test('useConfirm defers the action until the agent confirms', async () => {
  let deleted = 0
  function Screen() {
    const confirm = useConfirm()
    return (
      <div>
        <button onClick={() => confirm({ title: 'Delete "X"?', onConfirm: () => deleted++ })}>Delete X</button>
        {confirm.dialog}
      </div>
    )
  }
  const ui = await render(<Screen />)

  assert.equal(ui.text(), 'Delete X', 'no dialog until asked for')
  await click(ui.byText('Delete X'))
  assert.match(ui.text(), /Delete "X"\?/)
  assert.equal(deleted, 0)

  await click(ui.byText('Delete', { exact: true }))
  assert.equal(deleted, 1)
  assert.doesNotMatch(ui.text(), /Delete "X"\?/, 'the dialog should close after a successful confirm')
})

test('useConfirm cancels without running the action', async () => {
  let deleted = 0
  function Screen() {
    const confirm = useConfirm()
    return (
      <div>
        <button onClick={() => confirm({ title: 'Delete?', onConfirm: () => deleted++ })}>Delete</button>
        {confirm.dialog}
      </div>
    )
  }
  const ui = await render(<Screen />)

  await click(ui.byText('Delete', { exact: true }))
  await click(ui.byText('Cancel'))

  assert.equal(deleted, 0)
  assert.doesNotMatch(ui.text(), /Delete\?/)
})

test('useConfirm keeps the dialog open when the action fails', async () => {
  function Screen() {
    const confirm = useConfirm()
    return (
      <div>
        <button onClick={() => confirm({ title: 'Delete?', onConfirm: () => Promise.reject(new Error('nope')) })}>Delete</button>
        {confirm.dialog}
      </div>
    )
  }
  const ui = await render(<Screen />)

  await click(ui.byText('Delete', { exact: true }))
  await click(ui.byText('Delete', { exact: true }))

  assert.match(ui.text(), /Delete\?/, 'a failed delete must not look like it succeeded')
  assert.doesNotMatch(ui.text(), /Please wait…/, 'the button should be usable again for a retry')
})

test('useConfirm closes cleanly when no action was attached', async () => {
  function Screen() {
    const confirm = useConfirm()
    return (
      <div>
        <button onClick={() => confirm({ title: 'Nothing to do?' })}>Open</button>
        {confirm.dialog}
      </div>
    )
  }
  const ui = await render(<Screen />)

  await click(ui.byText('Open'))
  await click(ui.byText('Delete', { exact: true }))
  assert.doesNotMatch(ui.text(), /Nothing to do\?/)
})

// --- Loading states --------------------------------------------------------

test('loading rows announce themselves to screen readers', async () => {
  const ui = await render(<LoadingRows rows={3} />)

  const container = ui.byLabel('Loading')
  assert.equal(container.props['aria-busy'], 'true')
  assert.equal(ui.all((f) => f.props.className?.includes('animate-pulse')).length, 3 * 3)
})

test('a skeleton accepts extra classes', async () => {
  const ui = await render(<Skeleton className="w-11 h-11" />)

  const bar = ui.get((f) => f.type === 'div', 'skeleton bar')
  assert.match(bar.props.className, /w-11 h-11/)
  assert.match(bar.props.className, /animate-pulse/)
})

// --- ErrorBoundary ---------------------------------------------------------

test('a render crash shows a recovery card instead of a blank screen', async (t) => {
  const env = installBrowser()
  const errors = []
  const realError = console.error
  console.error = (...args) => errors.push(args)
  t.after(() => {
    console.error = realError
    env.restore()
  })

  function Boom() {
    throw new Error('kaboom')
  }
  const ui = await render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  )

  assert.match(ui.text(), /Something went wrong/)
  assert.match(ui.text(), /Your data is safe/)
  assert.equal(errors.length, 1, 'the crash should still be logged for debugging')

  await click(ui.byText('Reload'))
  assert.equal(env.reloads, 1)
})

test('the error boundary is invisible while its children are healthy', async () => {
  const ui = await render(
    <ErrorBoundary>
      <p>all good</p>
    </ErrorBoundary>,
  )

  assert.equal(ui.text(), 'all good')
})

test('a crash after mount is caught too', async (t) => {
  const realError = console.error
  console.error = () => {}
  t.after(() => {
    console.error = realError
  })

  let explode
  function Fragile() {
    const [boom, setBoom] = useState(false)
    explode = () => setBoom(true)
    if (boom) throw new Error('late crash')
    return <p>fine for now</p>
  }
  const ui = await render(
    <ErrorBoundary>
      <Fragile />
    </ErrorBoundary>,
  )

  assert.equal(ui.text(), 'fine for now')
  await act(() => explode())
  assert.match(ui.text(), /Something went wrong/)
})

// --- Shared style tables ---------------------------------------------------

test('every lead temperature has a style, and Cold is the fallback', async () => {
  for (const temp of ['Hot', 'Warm', 'Cold']) assert.ok(TEMP_STYLE[temp], `${temp} needs a style`)
  assert.equal(TEMP_STYLE[undefined], undefined)
})
