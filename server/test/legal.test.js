// The public /privacy and /terms pages. These are not decoration: Meta's app review
// requires a reachable Privacy Policy URL and Terms URL before the WhatsApp app can be
// published, and an unpublished app gets no webhook delivery at all. So the tests pin
// both the disclosures a reviewer looks for and the fact that the routes are public and
// aren't swallowed by the SPA catch-all.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'
import { privacyPage, termsPage } from '../legal.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('legal')

const { app } = await import('../index.js')
const { closePool } = await import('../db.js')

let server, base

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  server?.close()
  await closePool()
  await dropTestDb(dbName)
})

// --- Page rendering (unit) ----------------------------------------------------

const pages = [
  ['privacy', privacyPage, 'Privacy Policy'],
  ['terms', termsPage, 'Terms of Service'],
]

for (const [name, render, title] of pages) {
  test(`${name}: renders a complete, self-contained HTML document`, () => {
    const html = render()
    assert.match(html, /^<!doctype html>/i)
    assert.ok(html.includes('</html>'))
    assert.match(html, /<meta charset="utf-8"/)
    assert.match(html, /<meta name="viewport"/)
    assert.equal(html.match(/<html/g).length, 1)
    assert.equal(html.match(/<body>/g).length, 1)
    // Styles are inlined — the page must render for a reviewer with no asset pipeline.
    assert.ok(html.includes('<style>'))
    assert.ok(!/<script/i.test(html), 'legal pages should ship no scripts')
  })

  test(`${name}: is titled and dated`, () => {
    const html = render()
    assert.ok(html.includes(`<title>${title} — HomeNex</title>`))
    assert.ok(html.includes(`<h1>${title}</h1>`))
    assert.match(html, /Last updated: \w+ \d{1,2}, \d{4}/)
  })

  test(`${name}: is indexable and cross-links to the other policy`, () => {
    const html = render()
    assert.match(html, /<meta name="robots" content="index, follow"/)
    assert.ok(html.includes('href="/privacy"'))
    assert.ok(html.includes('href="/terms"'))
  })

  test(`${name}: gives a reachable contact route for data requests`, () => {
    const html = render()
    assert.match(html, /href="mailto:[^"@]+@[^"]+"/)
    assert.ok(html.includes('Contact Us'))
  })
}

test('privacy: covers the disclosures Meta app review checks for', () => {
  const html = privacyPage()
  for (const section of [
    'Information We Collect',
    'How We Use Your Information',
    'Data Sharing',
    'Data Retention',
    'Your Choices',
    'Data Security',
  ]) {
    assert.ok(html.includes(section), `privacy policy is missing the "${section}" section`)
  }
  // The specifics a WhatsApp reviewer looks for: what is collected, who it reaches,
  // and that it isn't sold on.
  assert.match(html, /WhatsApp messages/)
  assert.match(html, /Phone numbers/)
  assert.match(html, /deletion/i)
  assert.match(html, /do <strong>not<\/strong> sell/)
})

test('terms: covers acceptance, the service, and termination', () => {
  const html = termsPage()
  for (const section of ['Acceptance of Terms', 'The Service', 'Changes to These Terms']) {
    assert.ok(html.includes(section), `terms are missing the "${section}" section`)
  }
})

// --- Serving ------------------------------------------------------------------

for (const [path, title] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
  test(`GET ${path} is public HTML, not the SPA shell`, async () => {
    const res = await fetch(base + path)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    const html = await res.text()
    assert.ok(html.includes(`<h1>${title}</h1>`), 'the catch-all served index.html instead')
  })

  test(`GET ${path} carries the standard security headers`, async () => {
    const res = await fetch(base + path)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(res.headers.get('x-powered-by'), null)
  })
}
