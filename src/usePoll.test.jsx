// usePoll — the hook every live screen in the app is built on, and until now the
// only untested part of api.js.
//
// Three behaviours here are load-bearing for what the agent actually sees:
//   * a change of SUBJECT (a different lead, contact or filter) must not leave the
//     previous subject's data on screen under the new heading;
//   * a failed FIRST request must end the loading state, because every screen
//     branches on `!data` to decide whether to show "Loading…";
//   * refresh() after a save must not blank the screen it is refreshing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { render, act, click } from './test/render.jsx'
import { installBrowser } from './test/browserEnv.js'
import { usePoll } from './api.js'

// A probe that renders the hook's whole return value as text, so an assertion can
// read exactly what a component would branch on.
function Probe({ fn, deps = [], intervalMs = 1000, onState }) {
  const { data, error, loading, refresh } = usePoll(fn, intervalMs, deps)
  onState?.({ data, error, loading, refresh })
  return (
    <div>
      <span>data:{data === null ? 'null' : JSON.stringify(data)}</span>
      <span>error:{error ? error.message : 'none'}</span>
      <span>loading:{String(loading)}</span>
      <button onClick={() => refresh()}>refresh</button>
    </div>
  )
}

// A fetcher whose every response is controlled by the test: it hands back a promise
// per call so a response can be held open across a deps change or a refresh.
function deferrable() {
  const pending = []
  const fn = () => {
    let settle
    const p = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    pending.push(settle)
    return p
  }
  fn.calls = pending
  fn.resolve = async (value, i = pending.length - 1) => {
    pending[i].resolve(value)
    await act(() => {})
  }
  fn.reject = async (err, i = pending.length - 1) => {
    pending[i].reject(err)
    await act(() => {})
  }
  return fn
}

const setup = (t) => {
  const env = installBrowser()
  t.after(env.restore)
  return env
}

test('starts in a loading state with no data and no error', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  assert.match(view.text(), /data:null/)
  assert.match(view.text(), /loading:true/)
  assert.match(view.text(), /error:none/)
  assert.equal(fn.calls.length, 1, 'it fetches immediately rather than waiting a full interval')
})

test('a resolved fetch delivers the data and ends loading', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  await fn.resolve({ n: 1 })
  assert.match(view.text(), /data:\{"n":1\}/)
  assert.match(view.text(), /loading:false/)
})

// --- the fail-loudly rule -----------------------------------------------------

test('a failed FIRST fetch ends loading and reports the error', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  await fn.reject(new Error('offline'))
  // The old hook left loading implicit in `data === null`, so this state was
  // indistinguishable from "still fetching" and screens showed a spinner for ever.
  assert.match(view.text(), /loading:false/, 'a failed first fetch left the screen loading')
  assert.match(view.text(), /error:offline/)
  assert.match(view.text(), /data:null/)
})

test('a failure AFTER a success keeps the last good data on screen', async (t) => {
  const env = setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} intervalMs={1000} />)
  await fn.resolve({ n: 1 })

  await act(() => env.advance(1000))
  await fn.reject(new Error('blip'))
  // A transient poll failure must not blank a working screen.
  assert.match(view.text(), /data:\{"n":1\}/)
  assert.match(view.text(), /error:blip/)
})

test('a success after a failure clears the error', async (t) => {
  const env = setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} intervalMs={1000} />)
  await fn.reject(new Error('blip'))
  assert.match(view.text(), /error:blip/)

  await act(() => env.advance(1000))
  await fn.resolve({ n: 2 })
  assert.match(view.text(), /error:none/)
  assert.match(view.text(), /data:\{"n":2\}/)
})

// --- the subject-change rule --------------------------------------------------

test('changing deps drops the previous subject instead of showing it as the new one', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} deps={['lead-1']} />)
  await fn.resolve({ name: 'Priya' })
  assert.match(view.text(), /Priya/)

  await view.rerender(<Probe fn={fn} deps={['lead-2']} />)
  // Lead 2's panel must not show lead 1's name and price while it loads.
  assert.match(view.text(), /data:null/, "the previous subject's data survived a deps change")
  assert.match(view.text(), /loading:true/)

  await fn.resolve({ name: 'Rahul' })
  assert.match(view.text(), /Rahul/)
})

test('a response for the OLD deps that lands late is discarded', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} deps={['lead-1']} />)
  await view.rerender(<Probe fn={fn} deps={['lead-2']} />)
  assert.equal(fn.calls.length, 2)

  // Lead 2 answers first, then lead 1's slow response arrives.
  await fn.resolve({ name: 'Rahul' }, 1)
  await fn.resolve({ name: 'Priya' }, 0)
  assert.match(view.text(), /Rahul/, "a slow response for the old subject overwrote the new one")
  assert.doesNotMatch(view.text(), /Priya/)
})

test('an error from the OLD deps does not surface on the new subject', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} deps={['a']} />)
  await view.rerender(<Probe fn={fn} deps={['b']} />)
  await fn.reject(new Error('stale failure'), 0)
  assert.match(view.text(), /error:none/)
  assert.match(view.text(), /loading:true/, 'the new subject is still legitimately loading')
})

// --- refresh() ----------------------------------------------------------------

test('refresh() refetches without blanking what is already on screen', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  await fn.resolve({ n: 1 })

  await click(view.byText('refresh'))
  assert.equal(fn.calls.length, 2, 'refresh() issued a request')
  // The subject hasn't changed, so the screen keeps showing it — no flash of
  // skeletons after every save, which is why refreshKey used to be a poll dep.
  assert.match(view.text(), /data:\{"n":1\}/, 'refresh() blanked the screen')
  assert.match(view.text(), /loading:false/)

  await fn.resolve({ n: 2 })
  assert.match(view.text(), /data:\{"n":2\}/)
})

test('refresh() keeps a stable identity across renders', async (t) => {
  setup(t)
  const fn = deferrable()
  const seen = []
  await render(<Probe fn={fn} onState={(s) => seen.push(s.refresh)} />)
  await fn.resolve({ n: 1 })
  assert.ok(seen.length > 1, 'the probe re-rendered at least once')
  assert.equal(new Set(seen).size, 1, 'refresh changed identity, which would re-fire callers effects')
})

test('an interval response that loses the race to refresh() is discarded', async (t) => {
  const env = setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} intervalMs={1000} />)
  await fn.resolve({ n: 1 })

  await act(() => env.advance(1000)) // interval fires -> call index 1
  await click(view.byText('refresh')) // refresh fires -> call index 2
  await fn.resolve({ n: 3 }, 2) // the newer request answers first
  await fn.resolve({ n: 2 }, 1) // the older one straggles in
  assert.match(view.text(), /data:\{"n":3\}/, 'a straggling poll overwrote a newer refresh')
})

// --- polling and cleanup ------------------------------------------------------

test('it keeps polling on the interval', async (t) => {
  const env = setup(t)
  const fn = deferrable()
  await render(<Probe fn={fn} intervalMs={1000} />)
  await fn.resolve({ n: 1 })
  await act(() => env.advance(3000))
  assert.equal(fn.calls.length, 4, 'one immediate fetch plus three ticks')
})

test('a poll calls the CURRENT fetcher, not the one captured at mount', async (t) => {
  const env = setup(t)
  const first = deferrable()
  const second = deferrable()
  const view = await render(<Probe fn={first} intervalMs={1000} />)
  await first.resolve({ n: 1 })

  // Same deps, new closure — the common case where a component re-renders and the
  // inline arrow closes over fresh props. A stale closure would poll the old one.
  await view.rerender(<Probe fn={second} intervalMs={1000} />)
  await act(() => env.advance(1000))
  assert.equal(second.calls.length, 1, 'the interval kept calling the stale fetcher')
})

test('a re-render with unchanged deps does not refetch', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} deps={['x']} />)
  await fn.resolve({ n: 1 })
  await view.rerender(<Probe fn={fn} deps={['x']} />)
  assert.equal(fn.calls.length, 1, 'a plain re-render restarted the poll')
  assert.match(view.text(), /data:\{"n":1\}/)
})

test('unmounting clears the interval', async (t) => {
  const env = setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  assert.equal(env.liveIntervals, 1)
  view.unmount()
  assert.equal(env.liveIntervals, 0, 'the poll kept running after unmount')
})

test('a response arriving after unmount does not throw', async (t) => {
  setup(t)
  const fn = deferrable()
  const view = await render(<Probe fn={fn} />)
  view.unmount()
  await fn.resolve({ n: 1 }) // must not blow up on a setState into a dead tree
})
