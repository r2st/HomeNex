import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendlyMessage, isNetworkError } from './friendlyError.js'

test('passes through a real, human server message unchanged', () => {
  assert.equal(
    friendlyMessage({ status: 401, serverMessage: 'Wrong WhatsApp number or password' }),
    'Wrong WhatsApp number or password',
  )
})

test('rewrites a bare HTTP 500 into a friendly line', () => {
  const msg = friendlyMessage({ status: 500, serverMessage: 'HTTP 500' })
  assert.match(msg, /something went wrong/i)
  assert.doesNotMatch(msg, /HTTP|500/)
})

test('hides the generic server "internal error" string', () => {
  const msg = friendlyMessage({ status: 500, serverMessage: 'internal error' })
  assert.doesNotMatch(msg, /internal error/)
  assert.match(msg, /try again/i)
})

test('maps status codes with no useful server message', () => {
  assert.match(friendlyMessage({ status: 404 }), /couldn't find/i)
  assert.match(friendlyMessage({ status: 403 }), /permission/i)
  assert.match(friendlyMessage({ status: 429 }), /too many/i)
  assert.match(friendlyMessage({ status: 413 }), /too large/i)
})

test('unknown 4xx / 5xx fall back to sensible buckets', () => {
  assert.match(friendlyMessage({ status: 418 }), /details look incorrect/i)
  assert.match(friendlyMessage({ status: 599 }), /our side/i)
})

test('network errors read as offline', () => {
  assert.match(friendlyMessage(new TypeError('Failed to fetch')), /offline/i)
  assert.match(friendlyMessage({ isNetwork: true }), /offline/i)
})

test('plain technical strings are replaced; plain human strings pass through', () => {
  assert.match(friendlyMessage('ECONNREFUSED 127.0.0.1:5432'), /something went wrong/i)
  assert.equal(friendlyMessage('Enter a valid WhatsApp number'), 'Enter a valid WhatsApp number')
})

test('null / undefined never leak — always a usable sentence', () => {
  assert.match(friendlyMessage(null), /try again/i)
  assert.match(friendlyMessage(undefined), /try again/i)
})

test('isNetworkError detects fetch TypeErrors', () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true)
  assert.equal(isNetworkError(new Error('Wrong password')), false)
})

test('a network failure always reads as "you are offline", whatever the status', () => {
  assert.equal(friendlyMessage(new TypeError('Failed to fetch')), "You're offline. Check your internet and try again.")
  assert.equal(friendlyMessage({ isNetwork: true, status: 500 }), "You're offline. Check your internet and try again.")
  assert.equal(friendlyMessage({ status: 0 }), "You're offline. Check your internet and try again.")
})

test('an unmapped status falls back by class, not to a bare number', () => {
  assert.equal(friendlyMessage({ status: 418 }), 'Some details look incorrect. Please check and try again.')
  assert.equal(friendlyMessage({ status: 599 }), 'Something went wrong on our side. Please try again in a moment.')
  assert.equal(friendlyMessage({ status: 302 }), 'Something went wrong. Please try again.')
  assert.equal(friendlyMessage({}), 'Something went wrong. Please try again.')
  assert.equal(friendlyMessage(null), 'Something went wrong. Please try again.')
  assert.equal(friendlyMessage(undefined), 'Something went wrong. Please try again.')
})

test('a plain string is passed through unless it reads as internal noise', () => {
  assert.equal(friendlyMessage('Wrong WhatsApp number or password'), 'Wrong WhatsApp number or password')
  for (const noise of [
    'HTTP 500', 'connect ECONNREFUSED 127.0.0.1:5432', 'fetch failed', 'NetworkError when attempting to fetch',
    'internal error', 'Cannot read properties of undefined', '[object Object]', 'value is NaN', 'TypeError: x',
    'at Object.<anonymous> stack trace', '',
  ]) {
    assert.equal(friendlyMessage(noise), 'Something went wrong. Please try again.', noise)
  }
})

test('a real server message beats the status default, but noise does not', () => {
  assert.equal(
    friendlyMessage({ status: 409, serverMessage: 'A property with that micro-page link already exists' }),
    'A property with that micro-page link already exists',
  )
  assert.equal(
    friendlyMessage({ status: 409, serverMessage: 'HTTP 409' }),
    "That didn't go through — it may already exist or have changed. Please refresh and try again.",
  )
})

test('an Error with no status or serverMessage uses its own message when it is readable', () => {
  assert.equal(friendlyMessage(new Error('Your trial has ended')), 'Your trial has ended')
})

test('isNetworkError recognizes both a TypeError and the browsers\' wording', () => {
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true)
  assert.equal(isNetworkError({ message: 'Load failed' }), true) // Safari
  assert.equal(isNetworkError({ message: 'NetworkError when attempting to fetch resource.' }), true) // Firefox
  assert.equal(isNetworkError(new Error('Budget must be a number')), false)
  assert.equal(isNetworkError(null), false)
  assert.equal(isNetworkError(undefined), false)
})
