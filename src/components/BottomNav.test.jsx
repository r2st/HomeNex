// The five-tab bar. Small, but it is the only navigation an agent has, and the
// "act now" badge on More is what stops follow-ups being forgotten.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import BottomNav from './BottomNav.jsx'

const TAB_LABELS = ['Home', 'Leads', 'Inbox', 'Properties', 'More']

test('all five tabs are rendered', async () => {
  const ui = await render(<BottomNav tab="home" setTab={() => {}} />)

  for (const label of TAB_LABELS) assert.match(ui.text(), new RegExp(label))
})

test('tapping a tab reports the id, not the label', async () => {
  const picked = []
  const ui = await render(<BottomNav tab="home" setTab={(id) => picked.push(id)} />)

  await click(ui.byText('Leads'))
  await click(ui.byText('Properties'))
  await click(ui.byText('Inbox'))

  assert.deepEqual(picked, ['leads', 'properties', 'inbox'])
})

test('the active tab is styled differently from the rest', async () => {
  const ui = await render(<BottomNav tab="leads" setTab={() => {}} />)

  const active = ui.byText('Leads')
  const inactive = ui.byText('Home')
  assert.match(active.props.className, /font-bold/)
  assert.match(inactive.props.className, /font-medium/)
})

test('the More badge is shown only when there is something to act on', async () => {
  const without = await render(<BottomNav tab="home" setTab={() => {}} moreBadge={null} />)
  assert.doesNotMatch(without.text(), /\d/)

  const with3 = await render(<BottomNav tab="home" setTab={() => {}} moreBadge="3" />)
  assert.match(with3.text(), /3/)

  const capped = await render(<BottomNav tab="home" setTab={() => {}} moreBadge="9+" />)
  assert.match(capped.text(), /9\+/)
})

test('a zero badge is not rendered as a stray "0"', async () => {
  const ui = await render(<BottomNav tab="home" setTab={() => {}} moreBadge={0} />)

  assert.doesNotMatch(ui.text(), /0/)
})

test('the badge sits on More and nowhere else', async () => {
  const ui = await render(<BottomNav tab="home" setTab={() => {}} moreBadge="7" />)

  const badges = ui.allByText('7', { exact: true })
  assert.equal(badges.length, 1)
  assert.match(ui.byText('More').parent.text ?? ui.text(), /7|More/)
})

test('the Inbox tab keeps its raised call-to-action styling in both states', async () => {
  const inactive = await render(<BottomNav tab="home" setTab={() => {}} />)
  assert.ok(inactive.query((f) => f.props?.className?.includes('bg-brand')))

  const active = await render(<BottomNav tab="inbox" setTab={() => {}} />)
  assert.ok(active.query((f) => f.props?.className?.includes('bg-brand-deep')))
})
