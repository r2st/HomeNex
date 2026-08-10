// renderMicroPage in isolation. The micro-page is the one HomeNex surface served to
// the open internet with no auth, built entirely from agent-entered strings, so the
// interesting cases are the sparse property (almost every field optional) and the
// hostile property (markup and javascript: URLs in fields the agent controls).
// The DB-backed happy path lives in micropage.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMicroPage } from '../micropage.js'

const full = {
  id: 1,
  title: 'Skyline Heights',
  property_type: 'apartment',
  bhk: '3',
  size_sqft: 1450,
  size_unit: 'sqft',
  price_paise: 145 * 1e7,
  locality: 'Baner',
  city: 'Pune',
  facing: 'East',
  floor: 7,
  total_floors: 14,
  builder_name: 'Skyline Group',
  status: 'ready',
  rera_project_number: 'P52100099999',
  amenities: ['Gym', 'Pool'],
  photos: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
  notes: 'Corner unit',
  agent_name: 'Priya',
  agent_wa_number: '+91 98000 00041',
}

// --- The sparse property ------------------------------------------------------

test('a title-only property still renders a valid page', () => {
  const html = renderMicroPage({ title: 'Plot in Wakad' })
  assert.match(html, /^<!doctype html>/i)
  assert.ok(html.includes('</html>'))
  assert.match(html, /<h1>Plot in Wakad<\/h1>/)
})

test('missing photos fall back to the placeholder, not a broken <img>', () => {
  const html = renderMicroPage({ title: 'Plot in Wakad' })
  assert.ok(html.includes('class="placeholder"'))
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('og:image'))
})

test('a property with no price omits the price block rather than printing null', () => {
  const html = renderMicroPage({ title: 'Plot in Wakad' })
  assert.ok(!html.includes('class="price"'))
  assert.ok(!/null|undefined|NaN/.test(html))
})

test('empty spec, amenity and note sections are dropped, not left as empty markup', () => {
  const html = renderMicroPage({ title: 'Plot in Wakad' })
  assert.ok(!html.includes('<table>'))
  assert.ok(!html.includes('class="amenities"'))
  assert.ok(!html.includes('class="notes"'))
  assert.ok(!html.includes('class="rera"'))
})

test('an agent with no WhatsApp number gets no dead CTA', () => {
  const html = renderMicroPage({ title: 'Plot in Wakad' })
  assert.ok(!html.includes('class="cta"'))
  assert.ok(!html.includes('wa.me'))
})

test('the CTA falls back to the login number when no WABA number is set', () => {
  const html = renderMicroPage({ title: 'X', agent_phone: '+919800000041' })
  assert.match(html, /https:\/\/wa\.me\/919800000041\?text=/)
})

test('a non-array amenities/photos value is ignored rather than crashing', () => {
  const html = renderMicroPage({ title: 'X', amenities: 'Gym, Pool', photos: 'http://x/y.jpg' })
  assert.ok(!html.includes('class="amenities"'))
  assert.ok(!html.includes('<img'))
})

test('non-string amenities are filtered out of the chip list', () => {
  const html = renderMicroPage({ title: 'X', amenities: ['Gym', null, 42, { a: 1 }, 'Pool'] })
  assert.ok(html.includes('<span>Gym</span>'))
  assert.ok(html.includes('<span>Pool</span>'))
  assert.ok(!html.includes('[object Object]'))
  assert.ok(!html.includes('<span>42</span>'))
})

// --- The full property --------------------------------------------------------

test('every populated field reaches the page', () => {
  const html = renderMicroPage(full)
  assert.match(html, /<h1>Skyline Heights<\/h1>/)
  assert.match(html, /₹ 1\.45Cr/)
  assert.match(html, /3 BHK · apartment · 1450 sqft/)
  assert.match(html, /Baner, Pune/)
  assert.match(html, /<td>Facing<\/td><td>East<\/td>/)
  assert.match(html, /<td>Floor<\/td><td>7 of 14<\/td>/)
  assert.match(html, /<td>Builder<\/td><td>Skyline Group<\/td>/)
  assert.match(html, /RERA: P52100099999/)
  assert.match(html, /class="notes">Corner unit</)
  assert.match(html, /og:image" content="https:\/\/example\.com\/a\.jpg"/)
})

test('ground floor (0) is shown, not swallowed as falsy', () => {
  const html = renderMicroPage({ title: 'X', floor: 0, total_floors: 12 })
  assert.match(html, /<td>Floor<\/td><td>0 of 12<\/td>/)
})

test('a floor with no building height renders alone', () => {
  const html = renderMicroPage({ title: 'X', floor: 3 })
  assert.match(html, /<td>Floor<\/td><td>3<\/td>/)
})

test('the photo strip is capped so one listing cannot ship a hundred images', () => {
  const photos = Array.from({ length: 30 }, (_, i) => `https://example.com/p${i}.jpg`)
  const html = renderMicroPage({ ...full, photos })
  assert.equal((html.match(/<img /g) || []).length, 8)
})

test('the amenity chips are capped too', () => {
  const amenities = Array.from({ length: 40 }, (_, i) => `Amenity${i}`)
  const html = renderMicroPage({ ...full, amenities })
  assert.equal((html.match(/<span>Amenity/g) || []).length, 20)
})

// --- The hostile property -----------------------------------------------------
// Every string here is agent-entered and the page is public, so an unescaped field
// would be stored XSS on our own origin — the same origin that holds session tokens.

test('markup in any text field is escaped, never emitted as HTML', () => {
  const html = renderMicroPage({
    title: '<img src=x onerror=alert(1)>',
    notes: '</div><script>alert(2)</script>',
    locality: '"><script>alert(3)</script>',
    builder_name: "'-alert(4)-'",
    rera_project_number: '<b>P123</b>',
    amenities: ['<script>alert(5)</script>'],
    agent_name: '<svg onload=alert(6)>',
  })
  // The payloads survive as inert text (`&lt;img … onerror=…&gt;`), which is the
  // point — what must never appear is the opening angle bracket that would turn
  // them back into elements.
  assert.ok(!html.includes('<script'), 'a script tag reached the page')
  assert.ok(!html.includes('<svg'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<b>P123'))
  assert.ok(!html.includes('</div><script'))
  assert.ok(html.includes('&lt;script&gt;alert(5)&lt;/script&gt;')) // amenity chip, escaped
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;')) // title, escaped
  // Attribute-context payloads must not be able to close their attribute.
  assert.ok(!html.includes('"><script'))
  assert.ok(html.includes('&quot;'))
  // The ampersand must be escaped first, or the escaping is itself bypassable.
  assert.ok(renderMicroPage({ title: '&lt;script&gt;' }).includes('&amp;lt;script&amp;gt;'))
})

test('only http(s) photo URLs are emitted into src attributes', () => {
  const html = renderMicroPage({
    ...full,
    photos: [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '//evil.example.com/x.jpg',
      'https://example.com/ok.jpg',
    ],
  })
  assert.ok(!html.includes('javascript:'))
  assert.ok(!html.includes('data:text/html'))
  assert.ok(!html.includes('vbscript:'))
  assert.ok(!html.includes('//evil.example.com'))
  assert.match(html, /src="https:\/\/example\.com\/ok\.jpg"/)
  assert.equal((html.match(/<img /g) || []).length, 1)
})

test('a quote-breaking photo URL cannot escape the src attribute', () => {
  const html = renderMicroPage({ title: 'X', photos: ['https://e.com/a.jpg" onerror="alert(1)'] })
  assert.ok(!/onerror="alert/.test(html))
  assert.ok(html.includes('&quot;'))
})

test('the WhatsApp CTA is built from digits only, so it cannot be steered elsewhere', () => {
  const html = renderMicroPage({ title: 'X', agent_wa_number: '91"><script>alert(1)</script>98000' })
  assert.ok(!html.includes('<script'))
  // Everything that isn't a digit is stripped before the number reaches the href —
  // the surviving "1" comes from alert(1), which is exactly the point: no markup,
  // no attribute break, just digits.
  assert.match(html, /href="https:\/\/wa\.me\/91198000\?text=/)
})

test('the prefilled WhatsApp message is URL-encoded, not raw', () => {
  const html = renderMicroPage({ title: 'A & B "quoted"', agent_name: 'Priya', agent_wa_number: '919800000041' })
  const href = html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)[1]
  assert.ok(!href.includes(' '))
  assert.ok(!href.includes('"'))
  assert.equal(decodeURIComponent(new URL(href).searchParams.get('text')).includes('A & B "quoted"'), true)
})
