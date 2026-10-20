import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWaLink, openWhatsApp, isLinkMode, sendLabel } from './waLink.js'

const fakeWindow = ({ blocked = false, throws = false } = {}) => {
  const calls = { opened: [], assigned: [] }
  const tab = { opener: 'parent' }
  return {
    calls,
    tab,
    open: (url, name) => {
      if (throws) throw new Error('popup blocked')
      calls.opened.push({ url, name })
      return blocked ? null : tab
    },
    location: { assign: (url) => calls.assigned.push(url) },
  }
}

test('buildWaLink keeps only the digits of the phone and encodes the message', () => {
  assert.equal(
    buildWaLink('+91 98765 43210', 'Hi Priya, 2BHK in Baner @ ₹85L?'),
    'https://wa.me/919876543210?text=Hi%20Priya%2C%202BHK%20in%20Baner%20%40%20%E2%82%B985L%3F',
  )
  assert.equal(buildWaLink('919876543210', 'line one\nline two'), 'https://wa.me/919876543210?text=line%20one%0Aline%20two')
})

test('buildWaLink without text is a plain chat link, without a phone the contact picker', () => {
  assert.equal(buildWaLink('919876543210'), 'https://wa.me/919876543210')
  assert.equal(buildWaLink('919876543210', ''), 'https://wa.me/919876543210')
  assert.equal(buildWaLink(null, 'hello'), 'https://wa.me/?text=hello')
  assert.equal(buildWaLink(undefined), 'https://wa.me/')
})

test('openWhatsApp opens a new tab and severs its opener', () => {
  const win = fakeWindow()
  assert.equal(openWhatsApp('https://wa.me/91999', win), true)
  assert.deepEqual(win.calls.opened, [{ url: 'https://wa.me/91999', name: '_blank' }])
  assert.equal(win.tab.opener, null)
  assert.deepEqual(win.calls.assigned, [])
})

test('a blocked tab falls back to navigating to the link', () => {
  const blocked = fakeWindow({ blocked: true })
  assert.equal(openWhatsApp('https://wa.me/91999', blocked), true)
  assert.deepEqual(blocked.calls.assigned, ['https://wa.me/91999'])

  const throwing = fakeWindow({ throws: true })
  assert.equal(openWhatsApp('https://wa.me/91999', throwing), true)
  assert.deepEqual(throwing.calls.assigned, ['https://wa.me/91999'])
})

test('openWhatsApp does nothing without a link or a window', () => {
  const win = fakeWindow()
  assert.equal(openWhatsApp(null, win), false)
  assert.equal(openWhatsApp('', win), false)
  assert.equal(openWhatsApp('https://wa.me/1', null), false)
  assert.deepEqual(win.calls.opened, [])
})

test('openWhatsApp reports false when even navigation is refused', () => {
  const win = { open: () => null, location: { assign: () => { throw new Error('nope') } } }
  assert.equal(openWhatsApp('https://wa.me/1', win), false)
})

test('labels say "Open WhatsApp" in link mode and "Send" on the Cloud API', () => {
  assert.equal(isLinkMode('link'), true)
  assert.equal(isLinkMode('api'), false)
  assert.equal(isLinkMode(undefined), false)
  assert.equal(sendLabel('link'), 'Open WhatsApp')
  assert.equal(sendLabel('link', { done: true }), '✓ Opened')
  assert.equal(sendLabel('api'), 'Send')
  assert.equal(sendLabel('api', { done: true }), '✓ Sent')
})
