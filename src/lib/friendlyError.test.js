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
