// aiQueue.js — a tiny concurrency-limited request queue with exponential backoff.
//
// OpenRouter's free tier is rate-limited (HTTP 429) and occasionally 5xx's. Firing
// an unbounded number of extraction/reply calls at it — one per inbound WhatsApp
// message, plus suggestions and auto-fill — trips those limits and drops requests
// on the floor. This queue is the single choke point every AI call flows through:
//
//   * concurrency cap    — never more than N in flight at once (default 2)
//   * retry with backoff — 429 / 5xx / network errors are retried with exponential
//                          backoff + jitter, honouring a Retry-After header when the
//                          server sends one
//   * fail-open          — after the last retry the error propagates; ai.js turns
//                          that into a null/[] result so the app keeps working.
//
// Pure and deterministic under test: `sleep` and `jitter` are injectable so the
// backoff tests run instantly and without real timers.

export class RetryableError extends Error {
  constructor(message, { retryAfterMs = null, status = null } = {}) {
    super(message)
    this.name = 'RetryableError'
    this.retryable = true
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

// HTTP statuses worth retrying: 429 (rate limited) and any 5xx (transient server).
export const isRetryableStatus = (status) => status === 429 || (status >= 500 && status <= 599)

// Parse a Retry-After header (either "<seconds>" or an HTTP date) into ms, or null.
export function retryAfterMs(header, now = Date.now()) {
  if (!header) return null
  const secs = Number(header)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(header)
  return Number.isNaN(when) ? null : Math.max(0, when - now)
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class RequestQueue {
  constructor({
    concurrency = 2,
    maxRetries = 4,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    sleep = defaultSleep,
    // Jitter multiplier in [0.5, 1.5] by default; injectable (constant) for tests.
    jitter = () => 0.5 + Math.random(),
  } = {}) {
    this.concurrency = Math.max(1, concurrency)
    this.maxRetries = maxRetries
    this.baseDelayMs = baseDelayMs
    this.maxDelayMs = maxDelayMs
    this.sleep = sleep
    this.jitter = jitter
    this.active = 0
    this.pending = []
    // Observability for tests / health: how many attempts and retries we've made.
    this.stats = { enqueued: 0, attempts: 0, retries: 0, failures: 0, succeeded: 0 }
  }

  // Backoff for the Nth retry (0-indexed): base * 2^n, jittered, capped, or the
  // server's Retry-After when it gave us one.
  backoffMs(attempt, serverRetryAfterMs = null) {
    if (serverRetryAfterMs != null) return Math.min(serverRetryAfterMs, this.maxDelayMs)
    const exp = this.baseDelayMs * 2 ** attempt
    return Math.min(Math.round(exp * this.jitter()), this.maxDelayMs)
  }

  // Enqueue an async task. It runs when a concurrency slot frees up. The task may
  // throw a RetryableError (or an error with `.retryable === true`) to request a
  // retry; anything else fails immediately. Resolves/rejects with the task result.
  enqueue(task, { label = 'ai' } = {}) {
    this.stats.enqueued++
    return new Promise((resolve, reject) => {
      this.pending.push({ task, label, resolve, reject })
      this._drain()
    })
  }

  _drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift()
      this.active++
      this._run(job).finally(() => {
        this.active--
        this._drain()
      })
    }
  }

  async _run({ task, resolve, reject }) {
    for (let attempt = 0; ; attempt++) {
      this.stats.attempts++
      try {
        const result = await task()
        this.stats.succeeded++
        return resolve(result)
      } catch (err) {
        const retryable = err?.retryable === true
        if (!retryable || attempt >= this.maxRetries) {
          this.stats.failures++
          return reject(err)
        }
        this.stats.retries++
        await this.sleep(this.backoffMs(attempt, err.retryAfterMs))
      }
      // The loop has no exit condition — every path out of the body returns — so the
      // "fell off the end" edge on the closing brace is unreachable by construction.
      /* node:coverage ignore next */
    }
  }
}

// The process-wide queue every AI call shares. Concurrency 2 keeps us comfortably
// under the free tier's per-minute ceiling while still overlapping I/O.
export const aiQueue = new RequestQueue({
  concurrency: Number(process.env.AI_CONCURRENCY) || 2,
  maxRetries: Number(process.env.AI_MAX_RETRIES) || 4,
})
