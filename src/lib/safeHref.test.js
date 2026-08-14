// The rendering half of the stored-link fix.
//
// The server refuses to store a non-web link now, which closes the door going in.
// It does not go back and clean the listings written before that check existed, and
// those rows are read by the same <a href> as everything else — so this is the guard
// that actually stands between an old `javascript:` brochure link and the agent who
// opens that listing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { safeHref, isSafeHref } from './safeHref.js'

// undefined, not '' or '#': `href={undefined}` drops the attribute, so the element
// stops being a link at all rather than becoming one that goes somewhere else.
const REFUSED = [
  ['a script URL', 'javascript:alert(1)'],
  ['a script URL in mixed case', 'JaVaScRiPt:alert(1)'],
  ['a script URL behind leading whitespace', '   javascript:alert(1)'],
  ['a script URL behind a leading newline', '\n\tjavascript:alert(1)'],
  ['an inline HTML document', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['a local file', 'file:///etc/passwd'],
  ['a protocol-relative link to another origin', '//evil.example/b.pdf'],
  ['an empty string', ''],
  ['whitespace only', '   '],
]

for (const [what, url] of REFUSED) {
  test(`safeHref drops ${what}`, () => {
    assert.equal(safeHref(url), undefined)
    assert.equal(isSafeHref(url), false)
  })
}

const ALLOWED = [
  ['an https link', 'https://cdn.example/floorplan.pdf'],
  ['an http link', 'http://builder.example/b.pdf'],
  ['an https link with a query string', 'https://cdn.example/b.pdf?v=2&t=1'],
  // What saveUpload returns when PUBLIC_BASE_URL is unset, which is most
  // deployments — a guard that dropped this would break every uploaded brochure.
  ['our own relative upload path', '/uploads/deadbeef.pdf'],
]

for (const [what, url] of ALLOWED) {
  test(`safeHref passes ${what} through unchanged`, () => {
    assert.equal(safeHref(url), url)
    assert.equal(isSafeHref(url), true)
  })
}

test('safeHref returns the ORIGINAL string, not a trimmed or normalised one', () => {
  // The value is handed back rather than rebuilt, so a link that survives the check
  // is byte-for-byte what was stored — no chance of the guard itself changing where
  // a legitimate link points.
  const url = 'https://cdn.example/a%20b.pdf#page=2'
  assert.equal(safeHref(url), url)
})

test('safeHref refuses anything that is not a string', () => {
  // A JSONB column can hand back a number, an object or null, and `String(x)` on any
  // of them would produce something that could still pass a scheme test.
  for (const value of [null, undefined, 42, {}, [], true, { toString: () => 'https://ok.example' }]) {
    assert.equal(safeHref(value), undefined, `${JSON.stringify(value)} was treated as a link`)
  }
})
