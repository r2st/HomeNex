// The Settings card that says how messages reach clients. The default needs no setup
// (wa.me opens the agent's own WhatsApp); the Meta Business API is an optional
// upgrade that can only be switched on once the server has Meta credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser, mockFetch } from '../test/browserEnv.js'
import WaSendingCard from './WaSendingCard.jsx'

function setup(t, cfg, routes = {}) {
  const env = installBrowser()
  const net = mockFetch({ 'GET /api/agent/phone-config': cfg, ...routes })
  t.after(() => {
    net.restore()
    env.restore()
  })
  return { env, net }
}

const toggle = (ui) => ui.get((f) => f.type === 'button' && f.props.role === 'switch', 'API switch')

test('by default messages open the agent\'s WhatsApp app, no Meta setup needed', async (t) => {
  setup(t, { wa_send_mode: 'link', wa_api_enabled: false, wa_api_available: true })
  const ui = await render(<WaSendingCard />)

  assert.match(ui.text(), /Your WhatsApp app/)
  assert.match(ui.text(), /no Meta setup needed/)
  assert.match(ui.text(), /WhatsApp Business API \(optional upgrade\)/)
  assert.equal(toggle(ui).props['aria-checked'], false)
})

test('switching the Business API on and off goes through the server', async (t) => {
  const ctx = setup(t, { wa_send_mode: 'link', wa_api_enabled: false, wa_api_available: true }, {
    'PUT /api/agent/wa-api': (call) => ({
      wa_api_enabled: call.body.enabled,
      wa_send_mode: call.body.enabled ? 'api' : 'link',
    }),
  })
  const ui = await render(<WaSendingCard />)

  await click(toggle(ui))
  assert.deepEqual(ctx.net.to('/api/agent/wa-api', 'PUT')[0].body, { enabled: true })
  assert.equal(toggle(ui).props['aria-checked'], true)
  assert.match(ui.text(), /from your WhatsApp Business number through Meta/)

  await click(toggle(ui))
  assert.deepEqual(ctx.net.to('/api/agent/wa-api', 'PUT')[1].body, { enabled: false })
  assert.equal(toggle(ui).props['aria-checked'], false)
})

test('the upgrade cannot be switched on before support has connected Meta', async (t) => {
  setup(t, { wa_send_mode: 'link', wa_api_enabled: false, wa_api_available: false })
  const ui = await render(<WaSendingCard />)

  assert.equal(toggle(ui).props.disabled, true)
  assert.match(ui.text(), /Contact support to connect your number first/)
})

test('a refused switch reports why and leaves the mode alone', async (t) => {
  setup(t, { wa_send_mode: 'link', wa_api_enabled: false, wa_api_available: true }, {
    'PUT /api/agent/wa-api': { status: 409, body: { error: 'The WhatsApp Business API isn\'t connected for this workspace yet' } },
  })
  const ui = await render(<WaSendingCard />)

  await click(toggle(ui))
  assert.match(ui.text(), /isn't connected for this workspace yet/)
  assert.equal(toggle(ui).props['aria-checked'], false)
})

test('nothing renders when the config cannot be loaded', async (t) => {
  setup(t, { status: 500, body: {} })
  const ui = await render(<WaSendingCard />)
  assert.equal(ui.text(), '')
})
