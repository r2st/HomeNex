// The card that tells a broker which number to put on their hoardings.
//
// Everything downstream of this app depends on buyers messaging the right number, so
// the two things worth pinning are: the number shown is the one the server says is
// connected (not a stale one on the agent record), and while nothing is connected the
// card says so in words a broker can act on rather than showing a blank or a technical
// id they were never given.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import ShareNumberCard from './ShareNumberCard.jsx'

const AGENT = { id: 1, name: 'Rohit Sharma', wa_phone_number: '+91 98200 11111' }

function setup(t, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({
    '/api/agent/phone-config': { wa_phone_number: '+91 98200 22222' },
    ...routes,
  })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

// --- Which number wins ------------------------------------------------------

test('the connected number comes from the server, not from the agent record', async (t) => {
  // The agent row carries whatever was last saved on it; phone-config is what the
  // webhook is actually routing. When they disagree, the routing one is the truth —
  // the other sends buyers to a number nothing is listening on.
  setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  assert.match(ui.text(), /\+91 98200 22222/)
  assert.doesNotMatch(ui.text(), /\+91 98200 11111/)
})

test('the agent record is used when the server has nothing to say', async (t) => {
  setup(t, { '/api/agent/phone-config': {} })
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  assert.match(ui.text(), /\+91 98200 11111/)
})

test('a failed phone-config request falls back rather than blanking the card', async (t) => {
  setup(t, { '/api/agent/phone-config': { status: 500, body: { error: 'down' } } })
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  assert.match(ui.text(), /\+91 98200 11111/)
  assert.match(ui.text(), /YOUR WHATSAPP BUSINESS NUMBER/)
})

test('with no number anywhere, the card explains who is doing what', async (t) => {
  setup(t, { '/api/agent/phone-config': {} })
  const ui = await render(<ShareNumberCard agent={{ id: 1 }} />)

  assert.match(ui.text(), /BEING SET UP/)
  assert.match(ui.text(), /Our team is connecting your WhatsApp Business number/)
  assert.equal(ui.queryByRole('button', { name: 'Copy' }), null, 'there is nothing to copy yet')
})

// --- Sharing ----------------------------------------------------------------

test('copying puts the number on the clipboard and says it did', async (t) => {
  const { env } = setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  await click(ui.byRole('button', { name: 'Copy' }))

  assert.deepEqual(env.copied, ['+91 98200 22222'])
  assert.equal(ui.queryByRole('button', { name: 'Copied' })?.props.children, 'Copied')
})

test('a clipboard the browser refuses does not claim the number was copied', async (t) => {
  const { env } = setup(t)
  navigator.clipboard.writeText = async () => {
    throw new Error('denied')
  }
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  await click(ui.byRole('button', { name: 'Copy' }))

  assert.deepEqual(env.copied, [])
  assert.ok(ui.queryByRole('button', { name: 'Copy' }), 'the button must not flip to Copied on a failed copy')
})

test('the WhatsApp link is the number with everything but the digits stripped', async (t) => {
  setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} />)

  const link = ui.byRole('link', { name: /Open in WhatsApp/ })
  assert.equal(link.props.href, 'https://wa.me/919820022222')
  assert.equal(link.props.rel, 'noopener noreferrer', 'a target=_blank link without this hands the opener away')
})

// --- The compact chip on Home ------------------------------------------------

test('the compact chip renders nothing at all until a number is connected', async (t) => {
  setup(t, { '/api/agent/phone-config': {} })
  const ui = await render(<ShareNumberCard agent={{ id: 1 }} compact />)

  assert.equal(ui.text(), '', 'Home has its own onboarding banner; this must not add a second one')
})

test('the compact chip confirms the connection without taking over the screen', async (t) => {
  setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} compact />)

  assert.match(ui.text(), /WhatsApp connected/)
  assert.match(ui.text(), /\+91 98200 22222/)
  assert.doesNotMatch(ui.text(), /Share this number with your clients/, 'the explainer stays folded away')
})

test('the compact chip opens and closes its share panel', async (t) => {
  setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} compact />)

  await click(ui.byRole('button', { name: /Share/ }))
  assert.match(ui.text(), /Share this number with your clients/)
  assert.equal(ui.byRole('link', { name: /Open in WhatsApp/ }).props.href, 'https://wa.me/919820022222')

  await click(ui.byRole('button', { name: /Share/ }))
  assert.doesNotMatch(ui.text(), /Share this number with your clients/)
})

test('the compact panel copies the same number the full card would', async (t) => {
  const { env } = setup(t)
  const ui = await render(<ShareNumberCard agent={AGENT} compact />)

  await click(ui.byRole('button', { name: /Share/ }))
  await click(ui.byRole('button', { name: 'Copy' }))

  assert.deepEqual(env.copied, ['+91 98200 22222'])
})
