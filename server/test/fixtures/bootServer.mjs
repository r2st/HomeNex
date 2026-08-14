// Boot the real server the way systemd does — as its own process, with NODE_ENV
// unset — so serverProcess.test.js can drive the startup/shutdown block that the
// in-process tests can never reach (it is guarded by `NODE_ENV !== 'test'`).
//
// Everything here happens BEFORE `../../index.js` is imported, because the things
// worth steering — the once-a-minute job tick and the ten-second shutdown backstop —
// are created at import time and never exported. HARNESS_MODE picks the scenario:
//
//   boot        just start; the default
//   fast-timers shrink the 60s job tick and the 10s force-exit backstop
//   crash       start, then throw from a timer with no handler (uncaughtException)
//   reject      start, then reject a promise nobody awaits (unhandledRejection)
//   pool-gone   start, then drain the pool early so shutdown's closePool() throws
//
// Timer shrinking is by *duration*, not by callback identity: matching 60_000 and
// 10_000 hits exactly the two the server creates and leaves every other timer in the
// process (pg's keep-alives, the rate-limit sweeps) running at their real speed.
const MODE = process.env.HARNESS_MODE || 'boot'

if (MODE === 'fast-timers' || MODE === 'crash' || MODE === 'pool-gone') {
  const realInterval = globalThis.setInterval
  const realTimeout = globalThis.setTimeout
  // The job tick: a minute in production, 50ms here, so a test can observe that the
  // tick genuinely drives both job runners without waiting a minute for it.
  globalThis.setInterval = (fn, ms, ...rest) => realInterval(fn, ms === 60_000 ? 50 : ms, ...rest)
  // The shutdown backstop: ten seconds in production, 150ms here.
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms === 10_000 ? 150 : ms, ...rest)
}

await import('../../index.js')

// Tell the test the process is past import. The listen callback prints its own line;
// this one fires even for the modes that care about what happens after boot.
console.log('HARNESS READY')

if (MODE === 'crash') {
  // Thrown from a timer, so there is no local try/catch anywhere up the stack and
  // the process-level uncaughtException handler is the only thing that can see it.
  setTimeout(() => {
    throw new Error('harness: simulated uncaught exception')
  }, 120)
}

if (MODE === 'reject') {
  // A rejected promise nobody awaits. The server must log it and KEEP RUNNING —
  // one bad request must not take the process down with it.
  setTimeout(() => {
    Promise.reject(new Error('harness: simulated unhandled rejection'))
  }, 120)
}

if (MODE === 'pool-gone') {
  // Drain the pool out from under the shutdown path: pg throws "Called end on pool
  // more than once", which is exactly the failure the shutdown's try/catch exists for.
  const { closePool } = await import('../../db.js')
  await closePool()
  console.log('HARNESS POOL CLOSED')
}
