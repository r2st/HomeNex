// The production bootstrap block at the bottom of index.js — everything guarded by
// `NODE_ENV !== 'test'`. Every other suite imports `app` and calls listen() itself,
// so none of it has ever run: not the config gate, not the listen banner, and not
// the graceful-shutdown path that a deploy depends on.
//
// These tests spawn the real entrypoint as a child process, so the code under test
// is the same `node server/index.js` that systemd runs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { childEnv, createTestDb, dropTestDb } from './helpers.js'

const dbName = await createTestDb('bootstrap')
const DATABASE_URL = process.env.DATABASE_URL

// A one-shot connection rather than importing ../db.js: this file's subject is the
// child process, and pulling in the pool here would mean owning its shutdown too.
async function query(sql, params) {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return await client.query(sql, params)
  } finally {
    await client.end()
  }
}
const ENTRYPOINT = fileURLToPath(new URL('../index.js', import.meta.url))

// A port the OS just told us is free. Racy in principle, private to this box in
// practice — and far better than guessing a fixed port in a parallel test run.
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const children = []

// Boots the entrypoint with a valid production config and resolves once it has
// logged its listen banner. `env` overrides win, so a test can break the config.
async function boot(env = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: childEnv({
      NODE_ENV: 'production',
      DATABASE_URL,
      SESSION_SECRET: 'a'.repeat(32),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      PORT: String(port),
      LOG_REQUESTS: '0',
      // These children live until after(), so their pools stack up alongside
      // serverProcess.test.js's and the in-process suites'. See the note there: past
      // postgres's max_connections the child dies in runMigrations rather than
      // failing the assertion it was spawned for.
      PG_POOL_SIZE: '3',
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b) => (stdout += b))
  child.stderr.on('data', (b) => (stderr += b))

  // 'close' rather than 'exit': it fires once the stdio streams have drained too, so
  // a test that reads out()/err() after awaiting it sees the process's whole output.
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))

  return {
    child,
    port,
    exited,
    out: () => stdout,
    err: () => stderr,
    // Resolves when `re` shows up on `stream`, or rejects if the process dies or the
    // deadline passes — so a boot failure fails loudly instead of hanging. The stream
    // matters: validateEnv warns to stderr in almost the same words the listen banner
    // uses on stdout, so an 'any' match would return before stdout has anything.
    async waitFor(re, what, { stream = 'any', ms = 20_000 } = {}) {
      const deadline = Date.now() + ms
      const seen = () =>
        (stream !== 'stderr' && re.test(stdout)) || (stream !== 'stdout' && re.test(stderr))
      let dead = false
      exited.then(() => (dead = true))
      while (Date.now() < deadline) {
        if (seen()) return
        if (dead) break
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`timed out waiting for ${what}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    },
  }
}

after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  await dropTestDb(dbName)
})

test('a production boot warns about the missing optional services and serves /healthz', async () => {
  const srv = await boot({
    WHATSAPP_ACCESS_TOKEN: '',
    WHATSAPP_PHONE_NUMBER_ID: '',
    OPENROUTER_API_KEY: '',
    WHATSAPP_APP_SECRET: '',
  })
  // The banner and its three warnings are logged in one go but can reach us in
  // separate chunks, so wait for the last of them before reading the buffer.
  await srv.waitFor(/inbound webhooks are being REJECTED/, 'the startup warnings', { stream: 'stdout' })

  assert.match(srv.out(), new RegExp(`HomeNex server on :${srv.port}`))
  assert.match(srv.out(), /sends disabled/, 'sends are announced as disabled')
  assert.match(srv.out(), /AI replies\/extraction disabled/, 'AI is announced as disabled')

  const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, true, 'the probe really did reach Postgres')
  assert.equal(typeof body.uptime, 'number')

  srv.child.kill('SIGTERM')
  assert.deepEqual(await srv.exited, { code: 0, signal: null }, 'SIGTERM is a clean exit')
})

// The whole point of the fail-closed change: this is the one place the check runs in
// a REAL production process (NODE_ENV=production is set by the parent, not faked in
// a unit test), against the real express stack and the real public route.
test('a production deploy with no app secret rejects unsigned webhooks', async () => {
  const srv = await boot({ WHATSAPP_APP_SECRET: '' })
  await srv.waitFor(/HomeNex server on :/, 'the listen banner', { stream: 'stdout' })

  const payload = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: 'pnid-forged' },
      messages: [{ id: 'wamid.forged.1', from: '919888899999', type: 'text', text: { body: 'Hi' } }],
    } }] }],
  }
  const post = (headers = {}) =>
    fetch(`http://127.0.0.1:${srv.port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })

  // No secret configured means nothing can produce a signature we'd accept, so every
  // shape of request is refused — not just the unsigned one.
  assert.equal((await post()).status, 401, 'an unsigned webhook was accepted in production')
  assert.equal((await post({ 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) })).status, 401)

  // And the forged message never made it into the database.
  await new Promise((r) => setTimeout(r, 200))
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM messages WHERE wa_message_id = 'wamid.forged.1'`)
  assert.equal(rows[0].n, 0, 'a rejected webhook still persisted its message')

  srv.child.kill('SIGTERM')
  await srv.exited
})

test('SIGTERM drains the server instead of dropping it', async () => {
  const srv = await boot()
  await srv.waitFor(/HomeNex server on :/, 'the listen banner', { stream: 'stdout' })
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200)

  srv.child.kill('SIGTERM')
  assert.deepEqual(await srv.exited, { code: 0, signal: null })
  assert.match(srv.out(), /SIGTERM received — shutting down gracefully/)
  assert.doesNotMatch(srv.err(), /shutdown timed out/, 'the pool drained without the force-exit backstop')

  await assert.rejects(fetch(`http://127.0.0.1:${srv.port}/healthz`), 'the port is released')
})

test('SIGINT shuts down the same way, and a second signal is ignored', async () => {
  const srv = await boot()
  await srv.waitFor(/HomeNex server on :/, 'the listen banner', { stream: 'stdout' })

  srv.child.kill('SIGINT')
  srv.child.kill('SIGINT') // the shuttingDown latch must swallow this one
  assert.deepEqual(await srv.exited, { code: 0, signal: null })
  assert.equal(srv.out().match(/shutting down gracefully/g).length, 1, 'shutdown ran exactly once')
})

test('an invalid production config is refused at startup, not served', async () => {
  const srv = await boot({ SESSION_SECRET: '' })
  assert.deepEqual(await srv.exited, { code: 1, signal: null })
  assert.match(srv.err(), /SESSION_SECRET must be set in production/)
  assert.match(srv.err(), /Refusing to start with an invalid production configuration/)
  assert.doesNotMatch(srv.out(), /HomeNex server on :/, 'it never reached listen')
})

test('a too-short session secret is refused just as firmly', async () => {
  const srv = await boot({ SESSION_SECRET: 'short' })
  assert.deepEqual(await srv.exited, { code: 1, signal: null })
  assert.match(srv.err(), /SESSION_SECRET is too short/)
})
