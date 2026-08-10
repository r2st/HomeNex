// /healthz is what a load balancer polls to decide whether this node still takes
// traffic. Its whole point is the failure arm: if Postgres is unreachable the probe
// must answer 503 so the node is pulled out of rotation, rather than 200 because the
// process itself is technically alive. That arm had never run.
//
// The pool is torn down deliberately in the last test, so this file owns its own
// database and nothing else may be added after it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
delete process.env.WHATSAPP_APP_SECRET
const dbName = await createTestDb('healthz')

const { app } = await import('../index.js')
const { closePool, ready } = await import('../db.js')

let server, base

before(async () => {
  await ready
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  server?.close()
  await dropTestDb(dbName)
})

test('a healthy node reports the database it can actually reach', async () => {
  const res = await fetch(`${base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual({ ok: body.ok, db: body.db }, { ok: true, db: true })
  assert.equal(typeof body.uptime, 'number')
})

test('the probe needs no credentials — a load balancer has none', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
})

// Must stay last: it takes the pool down for good.
test('a node that has lost Postgres reports 503, not a cheerful 200', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    await closePool()
    const res = await fetch(`${base}/healthz`)
    assert.equal(res.status, 503, 'the load balancer is told to stop sending traffic')
    assert.deepEqual(await res.json(), { ok: false, db: false })
  } finally {
    console.error = quiet
  }
})
