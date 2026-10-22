import test from 'node:test'
import assert from 'node:assert/strict'
import { render, click } from '../test/render.jsx'
import { installBrowser } from '../test/browserEnv.js'
import ShareButtons from './ShareButtons.jsx'

test('ShareButtons renders WhatsApp link', async (t) => {
  installBrowser()
  const ui = await render(<ShareButtons url="https://example.com" title="Test" />)
  const waLink = ui.byText('WhatsApp')
  assert.ok(waLink)
  assert.ok(waLink.props.href.includes('wa.me'))
})

test('ShareButtons renders Twitter link', async (t) => {
  installBrowser()
  const ui = await render(<ShareButtons url="https://example.com" title="Test" />)
  assert.ok(ui.text().includes('Twitter'))
})

test('ShareButtons encodes url in share links', async (t) => {
  installBrowser()
  const ui = await render(<ShareButtons url="https://example.com/path?q=1" title="Test Title" />)
  const waLink = ui.byText('WhatsApp')
  assert.ok(waLink.props.href.includes(encodeURIComponent('https://example.com/path?q=1')))
})

test('ShareButtons renders copy button', async (t) => {
  installBrowser()
  const ui = await render(<ShareButtons url="https://example.com" title="Test" />)
  assert.ok(ui.text().includes('Copy link'))
})

test('ShareButtons controls meet the 48px touch-target minimum', async (t) => {
  installBrowser()
  const ui = await render(<ShareButtons url="https://example.com" title="Test" />)
  for (const label of ['WhatsApp', 'X / Twitter', 'Copy link']) {
    const node = ui.byText(label)
    assert.ok(node, `${label} control renders`)
    assert.match(node.props.className, /min-h-\[48px\]/, `${label} has a 48px min height`)
  }
})
