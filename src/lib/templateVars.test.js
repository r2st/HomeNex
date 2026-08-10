import { test } from 'node:test'
import assert from 'node:assert/strict'
import { varsOf, fillKnown, missingVars } from './templateVars.js'

test('varsOf lists placeholders in first-appearance order', () => {
  assert.deepEqual(varsOf('Hi {{name}} about {{property}}'), ['name', 'property'])
  assert.deepEqual(varsOf('{{b}} then {{a}}'), ['b', 'a'])
})

test('varsOf dedupes repeated placeholders', () => {
  assert.deepEqual(varsOf('{{name}}, yes {{name}}, really {{name}}'), ['name'])
})

test('varsOf tolerates whitespace inside the braces', () => {
  assert.deepEqual(varsOf('Hi {{ name }} and {{  property  }}'), ['name', 'property'])
})

test('varsOf returns nothing for bodies without placeholders', () => {
  assert.deepEqual(varsOf('Plain text with no variables'), [])
  assert.deepEqual(varsOf(''), [])
  assert.deepEqual(varsOf(null), [])
  assert.deepEqual(varsOf(undefined), [])
})

test('varsOf ignores malformed braces rather than inventing variables', () => {
  assert.deepEqual(varsOf('{{}} {{ }} {single} {{spaces here}} {{kebab-case}}'), [])
  assert.deepEqual(varsOf('{{ok_1}} {{bad-name}}'), ['ok_1'])
})

test('fillKnown substitutes the lead name', () => {
  assert.equal(fillKnown('Hi {{name}}!', { name: 'Priya' }), 'Hi Priya!')
  assert.equal(fillKnown('{{ name }} — welcome', { name: 'Priya' }), 'Priya — welcome')
})

test('fillKnown replaces every occurrence, not just the first', () => {
  assert.equal(fillKnown('{{name}} and {{name}}', { name: 'Amit' }), 'Amit and Amit')
})

test('fillKnown leaves unknown placeholders visible for the agent to complete', () => {
  assert.equal(
    fillKnown('Hi {{name}}, about {{property}} at {{price}}', { name: 'Priya' }),
    'Hi Priya, about {{property}} at {{price}}',
  )
})

test('fillKnown leaves {{name}} alone when the lead has no name', () => {
  // Blanking it would send "Hi ," — the placeholder is the safer thing to show.
  assert.equal(fillKnown('Hi {{name}}!', {}), 'Hi {{name}}!')
  assert.equal(fillKnown('Hi {{name}}!', { name: '' }), 'Hi {{name}}!')
  assert.equal(fillKnown('Hi {{name}}!', null), 'Hi {{name}}!')
})

test('fillKnown handles empty and missing bodies', () => {
  assert.equal(fillKnown('', { name: 'Priya' }), '')
  assert.equal(fillKnown(null, { name: 'Priya' }), '')
  assert.equal(fillKnown(undefined, { name: 'Priya' }), '')
})

test('a lead name containing braces does not create a new placeholder', () => {
  // The replacement result must not be re-scanned as a template.
  const out = fillKnown('Hi {{name}}', { name: '{{property}}' })
  assert.equal(out, 'Hi {{property}}')
  assert.deepEqual(missingVars('Hi {{name}}', { name: 'Priya' }), [])
})

test('missingVars reports only what the agent still has to fill in', () => {
  assert.deepEqual(missingVars('Hi {{name}}, see {{property}}', { name: 'Priya' }), ['property'])
  assert.deepEqual(missingVars('Hi {{name}}', { name: 'Priya' }), [])
  assert.deepEqual(missingVars('Hi {{name}}', {}), ['name'])
  assert.deepEqual(missingVars('No variables here', { name: 'Priya' }), [])
})
