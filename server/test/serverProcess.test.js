// The startup and shutdown block — the one part of index.js that no in-process test
// can reach, because it is guarded by `NODE_ENV !== 'test'` precisely so that
// importing the app in a test does not start listening.
//
// So this file does what systemd does: it spawns `node` on a harness that imports
// the real server as its own process, and drives it from the outside — boot banner,
// a live request, the once-a-minute job tick, and then each of the four ways the
// process can be asked to stop (SIGTERM, SIGINT, an uncaught exception, and a
// shutdown that can't drain).
//
// What makes this worth the cost of spawning: every line here runs only on a deploy.
// A mistake in it — a job tick that stopped calling one of its two runners, a
// shutdown that exits before the pool drains, a second SIGTERM that re-enters and
// double-closes — is invisible in development and shows up as a wedged deploy or a
// dropped connection in production. Nothing else in the suite would catch it.
//
// The harness (fixtures/bootServer.mjs) shrinks the 60s tick and the 10s force-exit
// backstop before importing, so this file costs about a second rather than a minute.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
const dbName = await createTestDb('serverprocess')
const DATABASE_URL = process.env.DATABASE_URL

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bootServer.mjs')

// Ask the OS for a port, then hand it straight to the child. Binding to 0 inside the
// server instead would leave us with no way to learn the port it chose — it prints
// the PORT it was *given*, which is the whole point of the banner.
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

// One booted server process, with its output captured and a few awaitable hooks.
async function boot({ mode = 'boot', env = {} } = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [HARNESS], {
    env: childEnv({
      // The guard under test is `NODE_ENV !== 'test'`. Our own process sets it to
      // 'test', so it has to come off explicitly or the child starts nothing at all.
      NODE_ENV: env.NODE_ENV ?? '',
      HARNESS_MODE: mode,
      DATABASE_URL,
      PORT: String(port),
      // Exercise the access log too — it is mounted on the same NODE_ENV check and
      // is otherwise never constructed under test.
      LOG_REQUESTS: '1',
      // Every server started here stays alive until after(), so by the last test
      // eleven of them are holding pools open at once. At the default max of 10 that
      // is 110 possible backends against a postgres that ships with
      // max_connections=100 — and the in-process suites running alongside us
      // (--test-concurrency=4) want their own. Past the limit postgres closes the
      // socket during startup, which pg surfaces from `pool.connect()` as
      // "Connection terminated due to connection timeout": the child dies in
      // runMigrations before it ever prints the banner, and the test that was
      // waiting on the banner fails somewhere unrelated to what it was testing.
      // None of these children needs more than a couple of connections.
      PG_POOL_SIZE: '3',
      ...env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let out = ''
  const waiters = []
  const feed = (chunk) => {
    out += chunk
    for (const w of waiters.slice()) {
      if (w.re.test(out)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  }
  child.stdout.setEncoding('utf8').on('data', feed)
  child.stderr.setEncoding('utf8').on('data', feed)

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

  // Resolve as soon as the pattern has appeared, or reject with everything printed so
  // far — a bare timeout on a child process is otherwise undebuggable.
  //
  // The deadline is generous because of what the FIRST child has to do before it can
  // print anything: createTestDb hands out an empty database, so that child runs the
  // whole migration chain on boot while four other suites (--test-concurrency=4) are
  // using the same postgres. Measured alone it is about four seconds; contended it is
  // not, and at 15s this file failed in the full suite on a shutdown test that had
  // nothing to do with startup. Every later child finds the chain applied and is ready
  // in ~250ms, so the ceiling only ever costs anything when it is genuinely needed.
  const waitFor = (re, ms = 45_000) =>
    new Promise((resolve, reject) => {
      if (re.test(out)) return resolve()
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${re} — server said:\n${out || '(nothing)'}`)),
        ms,
      )
      waiters.push({ re, resolve: () => (clearTimeout(timer), resolve()) })
    })

  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    exited,
    waitFor,
    output: () => out,
    // Ask nicely first: a SIGKILL'd child never runs its exit hooks, so it leaves its
    // Postgres connections for the server to reap and can outlive the drop of the test
    // database. SIGKILL stays as the backstop for a child that will not go.
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return exited
      child.kill('SIGTERM')
      const forced = setTimeout(() => child.kill('SIGKILL'), 3_000)
      try {
        return await exited
      } finally {
        clearTimeout(forced)
      }
    },
  }
}

// Every spawned child, so a failed assertion can never strand a listening server.
const running = []
const start = async (opts) => {
  const s = await boot(opts)
  running.push(s)
  return s
}

after(async () => {
  await Promise.all(running.map((s) => s.kill()))
  await dropTestDb(dbName)
})

test('the server boots, announces its port, and answers a real request', async () => {
  const s = await start()
  await s.waitFor(/HomeNex server on :\d+/)

  const res = await fetch(`${s.base}/healthz`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, true, 'a booted server could not reach its own database')
  assert.equal(typeof body.uptime, 'number')

  // The banner prints the port it was given, which is what an operator reads out of
  // journalctl to check the unit came up where they expected.
  assert.match(s.output(), new RegExp(`HomeNex server on :${s.port}`))

  // The access log is mounted on the same NODE_ENV check as the listener, so it is
  // only ever constructed here. A request must show up in it, with its status and
  // timing — that line is the whole diagnostic surface of a production request.
  await s.waitFor(/GET \/healthz 200 [\d.]+ms/)
})

test('boot warns about each missing credential rather than failing silently', async () => {
  const s = await start({ env: { WHATSAPP_ACCESS_TOKEN: '', OPENROUTER_API_KEY: '', WHATSAPP_APP_SECRET: '' } })

  // An agent whose sends are quietly disabled has no way to discover it; these lines
  // in the boot log are the only notice anyone gets. Wait for each rather than
  // reading the buffer after the banner — the banner and the warnings that follow it
  // are separate writes and do not necessarily arrive in the same chunk.
  await s.waitFor(/WhatsApp credentials missing — dashboard works, sends disabled/)
  await s.waitFor(/OPENROUTER_API_KEY missing — AI replies\/extraction disabled/)
  // Outside production a missing app secret only disables the signature check.
  await s.waitFor(/webhook signature check disabled \(dev only\)/)
})

test('in production a missing app secret is reported as a REJECTED inbound pipeline', async () => {
  // Same missing secret, opposite meaning: production fails closed, so every inbound
  // webhook is being 401'd. "Signature check disabled" would be actively misleading —
  // it reads as a relaxed check, not a dead pipeline.
  const s = await start({
    mode: 'boot',
    env: { NODE_ENV: 'production', WHATSAPP_APP_SECRET: '', SESSION_SECRET: 'x'.repeat(32) },
  })
  await s.waitFor(/inbound webhooks are being REJECTED \(401\)/)
  assert.doesNotMatch(s.output(), /signature check disabled/)
})

test('the once-a-minute tick drives BOTH the festive delivery and the scheduler', async () => {
  // The tick is a single setInterval with two calls in it. Losing one of them is a
  // silent failure — festive greetings simply stop going out, or every scheduled job
  // stops firing, with nothing in the log to say so. Point both at a failure so each
  // one announces itself, then assert both announcements arrive.
  //
  // OPENROUTER/WhatsApp are absent, so the runners do real (empty) work against the
  // database; what is being asserted is that the tick reaches them at all, which we
  // observe by the tick running repeatedly without the process dying.
  const s = await start({ mode: 'fast-timers' })
  await s.waitFor(/HARNESS READY/)

  // 50ms tick — give it several turns, then confirm the process is still healthy.
  // A throwing tick would have taken the process down via uncaughtException.
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(s.child.exitCode, null, `the job tick killed the server:\n${s.output()}`)
  const res = await fetch(`${s.base}/healthz`)
  assert.equal(res.status, 200, 'the server stopped answering after the job tick ran')
  assert.doesNotMatch(s.output(), /scheduler error/, 'the scheduler tick threw')
  assert.doesNotMatch(s.output(), /festive scheduler error/, 'the festive tick threw')
})

test('SIGTERM drains and exits 0', async () => {
  const s = await start()
  await s.waitFor(/HomeNex server on :\d+/)

  s.child.kill('SIGTERM')
  const { code } = await s.exited

  assert.match(s.output(), /SIGTERM received — shutting down gracefully/)
  assert.equal(code, 0, `a clean shutdown must exit 0, not ${code}`)
  // No pool error on the way out — the drain succeeded.
  assert.doesNotMatch(s.output(), /error closing pool/)
})

test('SIGINT drains and exits 0 as well', async () => {
  const s = await start()
  await s.waitFor(/HomeNex server on :\d+/)

  s.child.kill('SIGINT')
  const { code } = await s.exited

  assert.match(s.output(), /SIGINT received — shutting down gracefully/)
  assert.equal(code, 0)
})

test('a second signal during shutdown is ignored, not re-entered', async () => {
  // systemd sends SIGTERM and, if the unit is slow, an impatient operator sends
  // another. Re-entering shutdown would clear the interval twice, start a second
  // force-exit timer, and call server.close() on an already-closing server.
  const s = await start()
  await s.waitFor(/HomeNex server on :\d+/)

  s.child.kill('SIGTERM')
  s.child.kill('SIGTERM')
  s.child.kill('SIGINT')
  const { code } = await s.exited

  assert.equal(code, 0)
  const announcements = s.output().match(/received — shutting down gracefully/g) || []
  assert.equal(announcements.length, 1, `shutdown ran ${announcements.length} times, expected once`)
})

test('an unhandled rejection is logged and the server keeps serving', async () => {
  const s = await start({ mode: 'reject' })
  await s.waitFor(/unhandledRejection:/)

  // The deliberate choice here is to survive: a rejected promise is usually one bad
  // request, and killing the process would drop every other agent's session with it.
  assert.match(s.output(), /simulated unhandled rejection/)
  assert.equal(s.child.exitCode, null, 'an unhandled rejection killed the process')
  const res = await fetch(`${s.base}/healthz`)
  assert.equal(res.status, 200, 'the server stopped serving after an unhandled rejection')
})

test('an uncaught exception is fatal, but still shuts down cleanly and exits non-zero', async () => {
  const s = await start({ mode: 'crash' })
  const { code } = await s.exited

  assert.match(s.output(), /uncaughtException:/)
  assert.match(s.output(), /simulated uncaught exception/)
  // It goes through the same graceful path — the pool is drained, not abandoned.
  assert.match(s.output(), /uncaughtException received — shutting down gracefully/)
  // Non-zero so systemd restarts into a known-good state instead of treating a
  // corrupt process as a clean stop.
  assert.equal(code, 1, `a fatal exception must exit non-zero, got ${code}`)
})

test('a pool that is already gone does not stop the shutdown from completing', async () => {
  // The drain is best-effort by design: whatever state the pool is in, the process
  // still has to exit, or a deploy hangs waiting for a unit that will never stop.
  const s = await start({ mode: 'pool-gone' })
  await s.waitFor(/HARNESS POOL CLOSED/)

  s.child.kill('SIGTERM')
  const { code } = await s.exited

  assert.match(s.output(), /error closing pool/, 'the failed drain was swallowed without a word')
  assert.equal(code, 0, 'a failed pool drain must not change the exit code')
})

test('a connection that will not drain is force-exited rather than hanging the deploy', async () => {
  // server.close() waits for open connections. A keep-alive socket that never sends
  // another byte would hold the process open indefinitely, which on a deploy means a
  // unit stuck in "deactivating" until systemd's own timeout kills it.
  const s = await start({ mode: 'fast-timers' }) // 10s backstop shrunk to 150ms
  await s.waitFor(/HomeNex server on :\d+/)

  // The socket has to be mid-request, not merely open: since Node 19 `server.close()`
  // terminates *idle* keep-alive connections by itself, so a socket that has already
  // had its reply would drain cleanly and never reach the backstop. Send a request
  // whose headers never terminate and the server stays waiting on it.
  const socket = net.connect(s.port, '127.0.0.1')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.once('connect', resolve)
  })
  socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n')
  // No terminating blank line. Give the server a moment to register the connection
  // as active before asking it to stop.
  await new Promise((r) => setTimeout(r, 100))

  s.child.kill('SIGTERM')
  const { code } = await s.exited
  socket.destroy()

  assert.match(s.output(), /shutdown timed out — forcing exit/)
  // The backstop reports failure even for a signal that asked for a clean exit —
  // `code || 1` — so a deploy script can tell a drained stop from a forced one.
  assert.equal(code, 1, 'a forced exit must not look like a clean one')
})
