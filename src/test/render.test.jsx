// Tests for the test harness itself. If the renderer quietly stops running effects
// or re-rendering on setState, every component test below it turns green while
// asserting nothing — so the harness gets the same scrutiny as the app.
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState, useEffect, useMemo, useRef, useReducer, memo, forwardRef, Component } from 'react'
import { render, act, click, change, keyDown } from './render.jsx'

test('renders host elements, text and nested children', async () => {
  const ui = await render(
    <div>
      <h1>Leads</h1>
      <p>You have {3} hot leads</p>
    </div>,
  )
  assert.equal(ui.text(), 'LeadsYou have 3 hot leads')
  assert.equal(ui.byText('Leads', { exact: true }).type, 'h1')
})

test('skips null, false and undefined children', async () => {
  const ui = await render(
    <div>
      {null}
      {false}
      {undefined}
      <span>only me</span>
      {[]}
    </div>,
  )
  assert.equal(ui.text(), 'only me')
})

test('useState re-renders and keeps state across updates', async () => {
  function Counter() {
    const [n, setN] = useState(0)
    return <button onClick={() => setN(n + 1)}>count {n}</button>
  }
  const ui = await render(<Counter />)
  assert.match(ui.text(), /count 0/)
  await click(ui.byRole('button'))
  await click(ui.byRole('button'))
  assert.match(ui.text(), /count 2/)
})

test('functional setState sees the latest value within one batch', async () => {
  function Counter() {
    const [n, setN] = useState(0)
    const bump = () => {
      setN((v) => v + 1)
      setN((v) => v + 1)
    }
    return <button onClick={bump}>n={n}</button>
  }
  const ui = await render(<Counter />)
  await click(ui.byRole('button'))
  assert.match(ui.text(), /n=2/)
})

test('useEffect runs on mount, re-runs when deps change, and cleans up', async () => {
  const events = []
  function Widget({ id }) {
    useEffect(() => {
      events.push(`mount:${id}`)
      return () => events.push(`cleanup:${id}`)
    }, [id])
    return <span>{id}</span>
  }
  const ui = await render(<Widget id="a" />)
  assert.deepEqual(events, ['mount:a'])

  await ui.rerender(<Widget id="b" />)
  assert.deepEqual(events, ['mount:a', 'cleanup:a', 'mount:b'])

  ui.unmount()
  assert.deepEqual(events, ['mount:a', 'cleanup:a', 'mount:b', 'cleanup:b'])
})

test('an effect with an empty dep array runs exactly once', async () => {
  let runs = 0
  function Once() {
    const [n, setN] = useState(0)
    useEffect(() => {
      runs++
    }, [])
    return <button onClick={() => setN(n + 1)}>{n}</button>
  }
  const ui = await render(<Once />)
  await click(ui.byRole('button'))
  await click(ui.byRole('button'))
  assert.equal(runs, 1)
})

test('state set from an async effect lands before render() resolves', async () => {
  function Loader() {
    const [data, setData] = useState(null)
    useEffect(() => {
      Promise.resolve(['Priya', 'Rahul']).then(setData)
    }, [])
    return <div>{data ? data.join(', ') : 'Loading…'}</div>
  }
  const ui = await render(<Loader />)
  assert.equal(ui.text(), 'Priya, Rahul')
})

test('useMemo, useCallback and useRef keep identity across renders', async () => {
  const seen = []
  function Memoed({ tick }) {
    const [, setN] = useState(0)
    const expensive = useMemo(() => ({ tick }), [tick])
    const ref = useRef({ id: 'stable' })
    seen.push({ expensive, ref: ref.current })
    return <button onClick={() => setN((n) => n + 1)}>go</button>
  }
  const ui = await render(<Memoed tick={1} />)
  await click(ui.byRole('button'))
  assert.equal(seen[0].expensive, seen[1].expensive, 'useMemo recomputed with unchanged deps')
  assert.equal(seen[0].ref, seen[1].ref, 'useRef returned a new object')
})

test('useReducer dispatches through the latest reducer', async () => {
  function Stage() {
    const [stage, dispatch] = useReducer((cur, action) => (action === 'next' ? cur + 1 : 0), 0)
    return (
      <div>
        <span>stage {stage}</span>
        <button onClick={() => dispatch('next')}>next</button>
      </div>
    )
  }
  const ui = await render(<Stage />)
  await click(ui.byRole('button'))
  assert.match(ui.text(), /stage 1/)
})

test('events bubble to ancestor handlers and stopPropagation halts them', async () => {
  const hits = []
  const ui = await render(
    <div onClick={() => hits.push('outer')}>
      <button onClick={() => hits.push('inner')}>tap</button>
    </div>,
  )
  await click(ui.byRole('button'))
  assert.deepEqual(hits, ['inner', 'outer'])

  hits.length = 0
  const stopped = await render(
    <div onClick={() => hits.push('outer')}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          hits.push('inner')
        }}
      >
        tap
      </button>
    </div>,
  )
  await click(stopped.byRole('button'))
  assert.deepEqual(hits, ['inner'])
})

test('a disabled control ignores clicks, like the real DOM', async () => {
  let clicks = 0
  const ui = await render(
    <button disabled onClick={() => clicks++}>
      Save
    </button>,
  )
  await click(ui.byRole('button'))
  assert.equal(clicks, 0)
})

test('change() drives a controlled input', async () => {
  function Form() {
    const [value, setValue] = useState('')
    return <input placeholder="Phone" value={value} onChange={(e) => setValue(e.target.value)} />
  }
  const ui = await render(<Form />)
  await change(ui.byPlaceholder('Phone'), '9876543210')
  assert.equal(ui.byPlaceholder('Phone').props.value, '9876543210')
})

test('keyDown carries the key through', async () => {
  const keys = []
  const ui = await render(<input placeholder="q" onKeyDown={(e) => keys.push(e.key)} />)
  await keyDown(ui.byPlaceholder('q'), 'Enter')
  assert.deepEqual(keys, ['Enter'])
})

test('byLabel finds the control inside a <label>, and by aria-label', async () => {
  const ui = await render(
    <div>
      <label>
        <span>Phone number</span>
        <input placeholder="tel" />
      </label>
      <button aria-label="Close panel">×</button>
    </div>,
  )
  assert.equal(ui.byLabel('Phone number').props.placeholder, 'tel')
  assert.equal(ui.byLabel('Close panel').type, 'button')
})

test('byText returns the innermost match, not every wrapper', async () => {
  const ui = await render(
    <div>
      <div>
        <span>Site visit booked</span>
      </div>
    </div>,
  )
  assert.equal(ui.byText('Site visit booked').type, 'span')
})

test('byRole filters by accessible name', async () => {
  const ui = await render(
    <div>
      <button>Save</button>
      <button>Save &amp; open WhatsApp</button>
    </div>,
  )
  assert.equal(ui.allByRole('button').length, 2)
  assert.equal(ui.byRole('button', { name: 'open WhatsApp' }).children.length, 1)
})

test('queryBy* returns null instead of throwing; getBy* throws with the tree', async () => {
  const ui = await render(<div>nothing here</div>)
  assert.equal(ui.queryByText('missing'), null)
  assert.throws(() => ui.byText('missing'), /nothing here/)
})

test('keyed list children keep their own state when reordered', async () => {
  function Row({ label }) {
    const [n, setN] = useState(0)
    return (
      <button onClick={() => setN(n + 1)}>
        {label}:{n}
      </button>
    )
  }
  function List({ order }) {
    return (
      <div>
        {order.map((label) => (
          <Row key={label} label={label} />
        ))}
      </div>
    )
  }
  const ui = await render(<List order={['a', 'b']} />)
  await click(ui.byText('a:0'))
  assert.match(ui.text(), /a:1/)
  await ui.rerender(<List order={['b', 'a']} />)
  assert.match(ui.text(), /a:1/, 'state followed the key, not the index')
})

test('replacing a component type discards the old hook state', async () => {
  function A() {
    const [n] = useState('A-state')
    return <span>{n}</span>
  }
  function B() {
    const [n] = useState('B-state')
    return <span>{n}</span>
  }
  const ui = await render(<A />)
  await ui.rerender(<B />)
  assert.equal(ui.text(), 'B-state')
})

test('memo and forwardRef components render through', async () => {
  const Memo = memo(function Inner({ text }) {
    return <span>{text}</span>
  })
  const Fwd = forwardRef(function Input(props, ref) {
    return <input ref={ref} placeholder={props.placeholder} />
  })
  const ui = await render(
    <div>
      <Memo text="memoised" />
      <Fwd placeholder="fwd" />
    </div>,
  )
  assert.equal(ui.text(), 'memoised')
  assert.equal(ui.byPlaceholder('fwd').type, 'input')
})

test('class components render, setState and catch child errors', async () => {
  class Boundary extends Component {
    constructor(props) {
      super(props)
      this.state = { failed: false }
    }
    static getDerivedStateFromError() {
      return { failed: true }
    }
    componentDidCatch() {}
    render() {
      return this.state.failed ? <p>Something went wrong</p> : this.props.children
    }
  }
  function Boom() {
    throw new Error('render crash')
  }
  const ui = await render(
    <Boundary>
      <Boom />
    </Boundary>,
  )
  assert.equal(ui.text(), 'Something went wrong')
})

test('act() batches updates made inside it', async () => {
  let renders = 0
  let setter
  function Counted() {
    const [n, setN] = useState(0)
    setter = setN
    renders++
    return <span>{n}</span>
  }
  const ui = await render(<Counted />)
  const before = renders
  await act(() => {
    setter(1)
    setter(2)
    setter(3)
  })
  assert.equal(ui.text(), '3')
  assert.equal(renders - before, 1, 'three setState calls in one act should render once')
})

test('a runaway render loop fails loudly instead of hanging', async () => {
  function Runaway() {
    const [n, setN] = useState(0)
    useEffect(() => {
      setN((v) => v + 1)
    })
    return <span>{n}</span>
  }
  await assert.rejects(() => render(<Runaway />), /render loop/)
})
