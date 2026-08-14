// The server's 4xx strings are the UI's copy, whether anyone meant them to be.
//
// api.js hands the server's `error` string to friendlyMessage(), which shows it to
// the agent verbatim — unless it reads technical, in which case it is swapped for a
// generic line ("Some details look incorrect. Please check and try again."). That
// swap is the right behaviour for a leaked stack trace and the wrong one for a
// specific, fixable problem: the agent is told less than the server knew.
//
// Nothing connects the two files, so a message written on the server can be silently
// downgraded on the client and no test on either side notices. This is that test. It
// reads the real strings out of the real routes and asserts each one survives the
// trip to the screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { friendlyMessage } from '../lib/friendlyError.js'

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server')

// `res.status(4xx).json({ error: '…' })` with a literal string. Template literals are
// included: their static prefix is what decides whether the string reads technical.
const ERROR_CALL = /status\((4\d\d)\)\.json\(\{\s*error:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g

function serverErrors() {
  const out = []
  for (const file of readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(path.join(SERVER_DIR, file), 'utf8')
    for (const m of src.matchAll(ERROR_CALL)) {
      const message = m[2] ?? m[3] ?? m[4]
      if (!message) continue
      out.push({ file, status: Number(m[1]), message, line: src.slice(0, m.index).split('\n').length })
    }
  }
  return out
}

test('the scan finds the 4xx errors it is supposed to be checking', () => {
  // A regex that quietly stopped matching would leave this file passing forever while
  // checking nothing, so assert it still sees a realistic number of routes.
  const found = serverErrors()
  assert.ok(found.length > 100, `expected the routes' 4xx errors, found ${found.length}`)
  assert.ok(
    found.some((e) => e.message === 'You can only reassign a chat to someone on your team.'),
    'a known human message is missing — the scan is not reading the routes',
  )
})

test('every 4xx message the server writes reaches the agent unchanged', () => {
  const swallowed = serverErrors()
    .filter(({ status, message }) => friendlyMessage({ status, serverMessage: message }) !== message)
    .map(({ file, line, message }) => `${file}:${line} ${JSON.stringify(message)}`)

  assert.deepEqual(
    [...new Set(swallowed)],
    [],
    'these are replaced by a generic line before the agent sees them — either rewrite ' +
      'the message so it reads like something an agent can act on, or make the route ' +
      'return the generic case deliberately:\n  ' + [...new Set(swallowed)].join('\n  '),
  )
})

test('friendlyMessage still swallows what it is meant to swallow', () => {
  // The guard above is only worth having if the filter it leans on still fires — an
  // always-true friendlyMessage would make it pass while checking nothing.
  for (const technical of ['HTTP 500', 'ECONNREFUSED', 'TypeError: x is not a function', 'value is undefined']) {
    assert.notEqual(
      friendlyMessage({ status: 400, serverMessage: technical }),
      technical,
      `${JSON.stringify(technical)} should never reach the screen`,
    )
  }
})
