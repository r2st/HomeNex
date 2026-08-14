// The AI request queue: bounded concurrency + exponential backoff on rate limits.
// Deterministic — `sleep` and `jitter` are injected so retries don't burn wall time.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { RequestQueue, RetryableError, isRetryableStatus, retryAfterMs } = await import('../aiQueue.js')

// A queue whose sleeps are recorded instead of awaited, and whose jitter is fixed,
// so backoff timing is exactly predictable.
function testQueue(opts = {}) {
  const slept = []
  const q = new RequestQueue({
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    jitter: () => 1, // no randomness
    sleep: async (ms) => { slept.push(ms) },
    ...opts,
  })
  return { q, slept }
}

// --- retry classification ----------------------------------------------------

test('isRetryableStatus: 429 and 5xx retry, 4xx do not', () => {
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(500), true)
  assert.equal(isRetryableStatus(503), true)
  assert.equal(isRetryableStatus(400), false)
  assert.equal(isRetryableStatus(401), false)
  assert.equal(isRetryableStatus(200), false)
})

test('retryAfterMs parses seconds and HTTP-date, tolerates junk', () => {
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs(null), null)
  assert.equal(retryAfterMs('garbage'), null)
  const now = Date.now()
  const future = new Date(now + 5000).toUTCString()
  const ms = retryAfterMs(future, now)
  assert.ok(ms >= 4000 && ms <= 5000, `expected ~5000, got ${ms}`)
})

// --- retry behaviour ---------------------------------------------------------

test('a retryable failure is retried and eventually succeeds', async () => {
  const { q, slept } = testQueue()
  let calls = 0
  const result = await q.enqueue(async () => {
    calls++
    if (calls < 3) throw new RetryableError('429 rate limited', { status: 429 })
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  // Two backoffs: base*2^0 and base*2^1 = 100, 200 (jitter fixed at 1).
  assert.deepEqual(slept, [100, 200])
})

test('backoff is exponential and capped at maxDelayMs', async () => {
  const { q, slept } = testQueue({ maxRetries: 10, baseDelayMs: 100, maxDelayMs: 500 })
  let calls = 0
  await q.enqueue(async () => {
    calls++
    if (calls < 6) throw new RetryableError('boom', { status: 500 })
    return 'done'
  })
  // 100, 200, 400, then capped at 500, 500.
  assert.deepEqual(slept, [100, 200, 400, 500, 500])
})

test('a server Retry-After overrides the computed backoff', async () => {
  const { q, slept } = testQueue()
  let calls = 0
  await q.enqueue(async () => {
    calls++
    if (calls < 2) throw new RetryableError('429', { status: 429, retryAfterMs: 3000 })
    return 'x'
  })
  assert.deepEqual(slept, [3000])
})

test('gives up after maxRetries and rejects with the last error', async () => {
  const { q, slept } = testQueue({ maxRetries: 2 })
  let calls = 0
  await assert.rejects(
    q.enqueue(async () => {
      calls++
      throw new RetryableError('still 429', { status: 429 })
    }),
    /still 429/,
  )
  assert.equal(calls, 3) // initial + 2 retries
  assert.equal(slept.length, 2)
})

test('a non-retryable error fails immediately, no retries', async () => {
  const { q, slept } = testQueue()
  let calls = 0
  await assert.rejects(
    q.enqueue(async () => {
      calls++
      const e = new Error('bad api key')
      e.retryable = false
      throw e
    }),
    /bad api key/,
  )
  assert.equal(calls, 1)
  assert.equal(slept.length, 0)
})

// --- concurrency -------------------------------------------------------------

test('never runs more than `concurrency` tasks at once', async () => {
  const { q } = testQueue({ concurrency: 2 })
  let active = 0
  let peak = 0
  const task = () => q.enqueue(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 10))
    active--
    return true
  })
  await Promise.all(Array.from({ length: 8 }, task))
  assert.ok(peak <= 2, `peak concurrency was ${peak}`)
})

test('stats track attempts and retries', async () => {
  const { q } = testQueue()
  let calls = 0
  await q.enqueue(async () => {
    calls++
    if (calls < 2) throw new RetryableError('429', { status: 429 })
    return 'ok'
  })
  assert.equal(q.stats.succeeded, 1)
  assert.equal(q.stats.retries, 1)
  assert.equal(q.stats.attempts, 2)
})

test('a task that rejects with a non-object fails immediately instead of crashing', async () => {
  // callOpenRouter always throws an Error, but the queue takes any thunk, and a
  // task that rejects with undefined must not make the retry classifier itself
  // throw — that would reject the job with a TypeError and hide the real failure.
  const { q } = testQueue()
  await assert.rejects(
    q.enqueue(() => Promise.reject(undefined)),
    (e) => e === undefined,
  )
  assert.equal(q.stats.retries, 0, 'a non-retryable rejection was retried')
  assert.equal(q.stats.failures, 1)
})
