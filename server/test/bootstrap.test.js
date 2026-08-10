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
import { createTestDb, dropTestDb } from './helpers.js'

const dbName = await createTestDb('bootstrap')
const DATABASE_URL = process.env.DATABASE_URL
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
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL,
      SESSION_SECRET: 'a'.repeat(32),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      PORT: String(port),
      LOG_REQUESTS: '0',
      ...env,
    },
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
  await srv.waitFor(/webhook signature check disabled/, 'the startup warnings', { stream: 'stdout' })

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
