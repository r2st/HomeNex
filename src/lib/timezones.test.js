import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  timezoneLabel,
  timezoneOptions,
  COMMON_TIMEZONES,
  DEFAULT_TIMEZONE,
} from './timezones.js'

test('maps IANA zones to friendly names', () => {
  assert.equal(timezoneLabel('Asia/Kolkata'), 'India (IST)')
  assert.equal(timezoneLabel('Asia/Dubai'), 'Dubai (GST)')
  assert.equal(timezoneLabel('UTC'), 'UTC')
})

test('default zone is India and label is friendly', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Kolkata')
  assert.equal(timezoneLabel(null), 'India (IST)')
  assert.equal(timezoneLabel(''), 'India (IST)')
})

test('unknown zone degrades readably, no underscores', () => {
  const label = timezoneLabel('Antarctica/McMurdo')
  assert.ok(!label.includes('_'))
  assert.equal(label, 'Antarctica / McMurdo')
})

test('options include every common zone', () => {
  const opts = timezoneOptions('Asia/Kolkata')
  assert.equal(opts.length, COMMON_TIMEZONES.length)
  assert.ok(opts.every((o) => o.value && o.label))
})

test('an exotic stored zone is prepended once', () => {
  const opts = timezoneOptions('Pacific/Chatham')
  assert.equal(opts[0].value, 'Pacific/Chatham')
  assert.equal(opts.length, COMMON_TIMEZONES.length + 1)
})
