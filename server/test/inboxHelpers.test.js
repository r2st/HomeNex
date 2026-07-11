// Unit tests for the pure inbox/template helpers — no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractPlaceholders,
  fillTemplate,
  reraLine,
  appendRera,
  renderTemplate,
  waMediaType,
  AUTO_LABEL_KEYS,
} from '../inbox.js'

test('extractPlaceholders returns de-duplicated, first-seen order', () => {
  assert.deepEqual(
    extractPlaceholders('Hi {{name}}, about {{property}} — {{name}}?'),
    ['name', 'property'],
  )
  assert.deepEqual(extractPlaceholders('no vars here'), [])
  assert.deepEqual(extractPlaceholders('{{ visit_time }}'), ['visit_time']) // tolerates spaces
})

test('fillTemplate substitutes supplied variables', () => {
  const { text, missing } = fillTemplate('Hi {{name}}, visit {{property}} at {{visit_time}}', {
    name: 'Asha',
    property: 'Green Acres 3BHK',
    visit_time: 'Sat 4pm',
  })
  assert.equal(text, 'Hi Asha, visit Green Acres 3BHK at Sat 4pm')
  assert.deepEqual(missing, [])
})

test('fillTemplate reports missing/blank variables and leaves the placeholder', () => {
  const { text, missing } = fillTemplate('Hi {{name}}, about {{property}}', { name: '  ' })
  // whitespace-only name counts as missing, so both placeholders remain
  assert.deepEqual(missing, ['name', 'property'])
  assert.equal(text, 'Hi {{name}}, about {{property}}')
})

test('reraLine formats number with optional state, empty when absent', () => {
  assert.equal(reraLine({ rera_id: 'A123', rera_state: 'Maharashtra' }), 'RERA (Maharashtra): A123')
  assert.equal(reraLine({ rera_id: 'A123' }), 'RERA: A123')
  assert.equal(reraLine({ rera_id: '' }), '')
  assert.equal(reraLine(null), '')
})

test('appendRera adds the line once and is idempotent', () => {
  const agent = { rera_id: 'A123', rera_state: 'MH' }
  const once = appendRera('Check this out', agent)
  assert.equal(once, 'Check this out\n\nRERA (MH): A123')
  // Re-appending should not duplicate the number
  assert.equal(appendRera(once, agent), once)
  // No RERA on file -> unchanged
  assert.equal(appendRera('hello', {}), 'hello')
})

test('renderTemplate appends RERA only for opted-in marketing templates', () => {
  const agent = { rera_id: 'A123' }
  const marketing = { category: 'marketing', rera_auto_append: true, body: 'New: {{property}}' }
  const utility = { category: 'utility', rera_auto_append: false, body: 'Hi {{name}}' }

  const m = renderTemplate(marketing, { property: 'Sea View 2BHK' }, agent)
  assert.equal(m.text, 'New: Sea View 2BHK\n\nRERA: A123')
  assert.deepEqual(m.missing, [])

  const u = renderTemplate(utility, { name: 'Ravi' }, agent)
  assert.equal(u.text, 'Hi Ravi') // utility never gets RERA
})

test('waMediaType maps kinds to Cloud API message types', () => {
  assert.equal(waMediaType('photo'), 'image')
  assert.equal(waMediaType('video'), 'video')
  assert.equal(waMediaType('brochure'), 'document')
  assert.equal(waMediaType('floor_plan'), 'document')
  assert.equal(waMediaType('document'), 'document')
})

test('AUTO_LABEL_KEYS covers the six lifecycle labels', () => {
  assert.deepEqual(
    [...AUTO_LABEL_KEYS].sort(),
    ['broker', 'hot', 'lost', 'new', 'site_visit_scheduled', 'token_paid'],
  )
})
