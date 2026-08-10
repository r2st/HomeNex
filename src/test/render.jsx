// A tiny React renderer for tests — enough to mount the app's real components,
// run their hooks, fire events and assert on what the agent would actually see.
//
// Why this exists: the project deliberately ships with only react + vite as
// dependencies, so there is no jsdom and no testing-library. Rather than pull in a
// browser emulator to test 8k lines of components, this walks the element tree
// itself and keeps hook state in a fiber-like structure. It supports the hooks the
// app actually uses (useState, useReducer, useEffect, useLayoutEffect, useMemo,
// useCallback, useRef, useId, useContext), class components with error boundaries,
// fragments, memo and forwardRef.
//
// It is NOT a browser: there is no layout, no CSS and no real DOM. It answers
// "given these props and these interactions, what does the component render and
// which callbacks does it call?" — which is where component bugs live.
import React from 'react'

const Dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher

const FRAGMENT = Symbol.for('react.fragment')
const MEMO = Symbol.for('react.memo')
const FORWARD_REF = Symbol.for('react.forward_ref')
const PROVIDER = Symbol.for('react.provider')
const CONTEXT = Symbol.for('react.context')

// Form controls that a <label> can be associated with, for byLabel().
const CONTROLS = new Set(['input', 'select', 'textarea'])

// Implicit ARIA roles for the handful of tags the app uses. Only what's needed —
// a full role mapping would be dead weight.
const IMPLICIT_ROLE = {
  a: 'link',
  button: 'button',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  img: 'img',
  li: 'listitem',
  ol: 'list',
  option: 'option',
  select: 'combobox',
  table: 'table',
  textarea: 'textbox',
  ul: 'list',
}

const roleOf = (fiber) => {
  if (fiber.props?.role) return fiber.props.role
  if (fiber.type === 'input') {
    const t = fiber.props?.type || 'text'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'textbox'
  }
  return IMPLICIT_ROLE[fiber.type] || null
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let batchDepth = 0
const dirtyRoots = new Set()

function scheduleRender(root) {
  if (root.unmounted) return
  dirtyRoots.add(root)
  if (batchDepth === 0) flushSync()
}

let flushing = false

function flushSync() {
  // An effect that sets state re-enters here; let the outer loop own the work so
  // a render loop shows up as a clear error instead of a stack overflow.
  if (flushing) return
  flushing = true
  try {
    // Bounded so a genuine render loop fails the test instead of hanging it.
    for (let pass = 0; dirtyRoots.size; pass++) {
      if (pass > 50) {
        dirtyRoots.clear()
        throw new Error('render loop: state kept changing after 50 passes')
      }
      for (const root of [...dirtyRoots]) {
        dirtyRoots.delete(root)
        if (root.unmounted) continue
        renderRoot(root)
        runEffects(root)
      }
    }
  } finally {
    flushing = false
  }
}

/** Run `fn`, batching every state update it causes, then settle pending effects. */
export async function act(fn) {
  batchDepth++
  try {
    const out = fn?.()
    if (out && typeof out.then === 'function') await out
  } finally {
    batchDepth--
  }
  flushSync()
  // Let promise chains (api calls stubbed with resolved promises) settle, then
  // flush whatever state they set, until the tree stops changing.
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    if (!dirtyRoots.size) break
    flushSync()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

let active = null // the root currently rendering

const nextHook = () => {
  const fiber = active.current
  const i = fiber.hookIndex++
  return (fiber.hooks[i] ||= {})
}

const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function useEffectImpl(create, deps) {
  const hook = nextHook()
  const changed = !hook.mounted || deps === undefined || hook.deps === undefined || !depsEqual(hook.deps, deps)
  hook.mounted = true
  hook.deps = deps
  hook.create = create
  hook.isEffect = true
  if (changed) active.pendingEffects.push(hook)
}

const dispatcher = {
  useState(initial) {
    const hook = nextHook()
    if (!('state' in hook)) hook.state = typeof initial === 'function' ? initial() : initial
    if (!hook.setter) {
      const root = active
      hook.setter = (value) => {
        const next = typeof value === 'function' ? value(hook.state) : value
        if (Object.is(next, hook.state)) return
        hook.state = next
        scheduleRender(root)
      }
    }
    return [hook.state, hook.setter]
  },

  useReducer(reducer, initialArg, init) {
    const hook = nextHook()
    if (!('state' in hook)) hook.state = init ? init(initialArg) : initialArg
    hook.reducer = reducer
    if (!hook.dispatch) {
      const root = active
      hook.dispatch = (action) => {
        const next = hook.reducer(hook.state, action)
        if (Object.is(next, hook.state)) return
        hook.state = next
        scheduleRender(root)
      }
    }
    return [hook.state, hook.dispatch]
  },

  useRef(initial) {
    const hook = nextHook()
    hook.ref ||= { current: initial }
    return hook.ref
  },

  useMemo(factory, deps) {
    const hook = nextHook()
    if (!hook.computed || !depsEqual(hook.deps, deps)) {
      hook.value = factory()
      hook.deps = deps
      hook.computed = true
    }
    return hook.value
  },

  useCallback(fn, deps) {
    return dispatcher.useMemo(() => fn, deps)
  },

  useEffect: useEffectImpl,
  useLayoutEffect: useEffectImpl,
  useInsertionEffect: useEffectImpl,

  useContext(context) {
    return context._currentValue
  },

  useId() {
    const hook = nextHook()
    hook.id ||= `:r${active.idCounter++}:`
    return hook.id
  },

  useImperativeHandle(ref, create, deps) {
    useEffectImpl(() => {
      if (typeof ref === 'function') ref(create())
      else if (ref) ref.current = create()
    }, deps)
  },

  useDebugValue() {},
  useTransition() {
    return [false, (fn) => fn()]
  },
  useDeferredValue: (v) => v,
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  },
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const flatten = (children, out = []) => {
  if (children == null || typeof children === 'boolean') return out
  if (Array.isArray(children)) {
    for (const c of children) flatten(c, out)
    return out
  }
  out.push(children)
  return out
}

const typeOfElement = (el) => {
  if (el == null || typeof el === 'boolean') return null
  if (typeof el === 'string' || typeof el === 'number') return '#text'
  return el.type
}

function reconcile(root, elements, oldChildren, parent) {
  const list = flatten(elements)
  const taken = new Set()
  const next = list.map((el, i) => {
    const key = el?.key ?? null
    let old = null
    if (key != null) {
      old = oldChildren.find((o, oi) => !taken.has(oi) && o.key === key) || null
      if (old) taken.add(oldChildren.indexOf(old))
    } else {
      const candidate = oldChildren[i]
      if (candidate && candidate.key == null && !taken.has(i)) {
        old = candidate
        taken.add(i)
      }
    }
    // A changed element type means a fresh component — old hook state must go.
    if (old && old.type !== typeOfElement(el)) {
      unmountFiber(old)
      old = null
    }
    return renderElement(root, el, old, parent)
  })
  oldChildren.forEach((o, i) => {
    if (!taken.has(i)) unmountFiber(o)
  })
  return next.filter(Boolean)
}

function renderElement(root, element, old, parent) {
  if (element == null || typeof element === 'boolean') return null

  if (typeof element === 'string' || typeof element === 'number') {
    return { kind: 'text', type: '#text', key: null, text: String(element), parent, children: [] }
  }

  let type = element.type
  let props = element.props || {}
  const key = element.key ?? null

  // memo / forwardRef wrappers render straight through — the app has no use for
  // their bailout semantics, only their output.
  if (type && typeof type === 'object') {
    if (type.$$typeof === MEMO) type = type.type
    else if (type.$$typeof === FORWARD_REF) {
      const fiber = { kind: 'component', type: element.type, key, props, hooks: old?.hooks || [], parent, children: [] }
      fiber.hookIndex = 0
      const out = withDispatcher(root, fiber, () => type.render(props, element.ref ?? null))
      fiber.children = reconcile(root, [out], old?.children || [], fiber)
      return fiber
    } else if (type.$$typeof === PROVIDER) {
      type._context._currentValue = props.value
      const fiber = { kind: 'fragment', type: element.type, key, props, parent, children: [] }
      fiber.children = reconcile(root, props.children, old?.children || [], fiber)
      return fiber
    } else if (type.$$typeof === CONTEXT) {
      const fiber = { kind: 'fragment', type: element.type, key, props, parent, children: [] }
      fiber.children = reconcile(root, props.children(type._currentValue), old?.children || [], fiber)
      return fiber
    }
  }

  if (type === FRAGMENT) {
    const fiber = { kind: 'fragment', type, key, props, parent, children: [] }
    fiber.children = reconcile(root, props.children, old?.children || [], fiber)
    return fiber
  }

  if (typeof type === 'string') {
    const fiber = { kind: 'host', type, key, props, parent, children: [], root }
    fiber.children = reconcile(root, props.children, old?.children || [], fiber)
    return fiber
  }

  if (typeof type === 'function') {
    if (type.prototype?.isReactComponent) return renderClass(root, element, type, props, key, old, parent)
    const fiber = { kind: 'component', type, key, props, hooks: old?.hooks || [], parent, children: [] }
    fiber.hookIndex = 0
    const out = withDispatcher(root, fiber, () => type(props))
    fiber.children = reconcile(root, [out], old?.children || [], fiber)
    return fiber
  }

  throw new Error(`cannot render element of type ${String(type)}`)
}

function withDispatcher(root, fiber, fn) {
  const prevActive = active
  const prevCurrent = root.current
  const prevDispatcher = Dispatcher.current
  active = root
  root.current = fiber
  Dispatcher.current = dispatcher
  try {
    return fn()
  } finally {
    Dispatcher.current = prevDispatcher
    root.current = prevCurrent
    active = prevActive
  }
}

function renderClass(root, element, type, props, key, old, parent) {
  const fiber = { kind: 'class', type, key, props, parent, children: [], hooks: [] }
  let instance = old?.instance
  if (!instance) {
    instance = new type(props)
    instance.state ||= null
    instance.updater = {
      enqueueSetState(inst, partial, callback) {
        const patch = typeof partial === 'function' ? partial(inst.state, inst.props) : partial
        inst.state = { ...inst.state, ...patch }
        scheduleRender(root)
        callback?.()
      },
      enqueueForceUpdate() {
        scheduleRender(root)
      },
    }
  }
  instance.props = props
  fiber.instance = instance

  const renderOnce = () => reconcile(root, [instance.render()], old?.children || [], fiber)
  try {
    fiber.children = renderOnce()
  } catch (err) {
    if (!type.getDerivedStateFromError && !instance.componentDidCatch) throw err
    if (type.getDerivedStateFromError) instance.state = { ...instance.state, ...type.getDerivedStateFromError(err) }
    instance.componentDidCatch?.(err, { componentStack: '' })
    fiber.children = reconcile(root, [instance.render()], [], fiber)
  }
  return fiber
}

function renderRoot(root) {
  root.pendingEffects = []
  // A different element type at the root is a different component: drop the old
  // tree so its hook state and effects don't bleed into the new one.
  if (root.tree && root.tree.type !== typeOfElement(root.element)) {
    unmountFiber(root.tree)
    root.tree = null
  }
  root.tree = renderElement(root, root.element, root.tree, null)
}

function runEffects(root) {
  const pending = root.pendingEffects
  root.pendingEffects = []
  for (const hook of pending) {
    try {
      hook.cleanup?.()
    } catch {
      /* a cleanup that throws must not stop the rest from running */
    }
    const ret = hook.create()
    hook.cleanup = typeof ret === 'function' ? ret : undefined
  }
}

function unmountFiber(fiber) {
  if (!fiber) return
  for (const hook of fiber.hooks || []) {
    if (hook.isEffect && hook.cleanup) {
      try {
        hook.cleanup()
      } catch {
        /* ignore */
      }
      hook.cleanup = undefined
    }
  }
  fiber.instance?.componentWillUnmount?.()
  for (const child of fiber.children || []) unmountFiber(child)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function walk(fiber, fn) {
  if (!fiber) return
  fn(fiber)
  for (const child of fiber.children || []) walk(child, fn)
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

function textOf(fiber) {
  let out = ''
  walk(fiber, (f) => {
    if (f.kind === 'text') out += f.text
  })
  return norm(out)
}

const matches = (value, matcher, exact) => {
  if (value == null) return false
  const text = norm(value)
  if (matcher instanceof RegExp) return matcher.test(text)
  return exact ? text === norm(matcher) : text.includes(norm(matcher))
}

function describe(fiber, depth = 0) {
  let out = ''
  walk(fiber, () => {})
  const render = (f, d) => {
    const pad = '  '.repeat(d)
    if (f.kind === 'text') out += `${pad}"${f.text}"\n`
    else {
      const name = typeof f.type === 'function' ? f.type.name || 'Anonymous' : String(f.type?.description || f.type)
      out += `${pad}<${name}>\n`
    }
    for (const c of f.children || []) render(c, d + 1)
  }
  render(fiber, depth)
  return out
}

function makeView(root) {
  const hosts = () => {
    const out = []
    walk(root.tree, (f) => {
      if (f.kind === 'host') out.push(f)
    })
    return out
  }

  const fail = (what) => {
    throw new Error(`${what}\n--- rendered text ---\n${textOf(root.tree)}\n--- tree ---\n${describe(root.tree)}`)
  }

  // Prefer the innermost element that matches, so byText('Save') returns the
  // <button> and not every wrapper <div> that happens to contain it.
  const deepest = (candidates) =>
    candidates.filter((f) => !candidates.some((other) => other !== f && isAncestor(f, other)))

  const isAncestor = (maybeAncestor, node) => {
    let cur = node.parent
    while (cur) {
      if (cur === maybeAncestor) return true
      cur = cur.parent
    }
    return false
  }

  const view = {
    get tree() {
      return root.tree
    },
    text: () => textOf(root.tree),
    debug: () => describe(root.tree),

    all: (predicate) => hosts().filter(predicate),
    query: (predicate) => hosts().find(predicate) || null,
    get(predicate, label = 'element') {
      return view.query(predicate) || fail(`no ${label} matched`)
    },

    allByText(matcher, { exact = false, selector } = {}) {
      let found = hosts().filter((f) => matches(textOf(f), matcher, exact))
      if (selector) found = found.filter((f) => f.type === selector)
      return deepest(found)
    },
    queryByText(matcher, opts) {
      return view.allByText(matcher, opts)[0] || null
    },
    byText(matcher, opts) {
      return view.queryByText(matcher, opts) || fail(`no element with text ${matcher}`)
    },

    allByRole(role, { name } = {}) {
      return hosts().filter((f) => roleOf(f) === role && (name === undefined || matches(accessibleName(f), name, false)))
    },
    queryByRole(role, opts) {
      return view.allByRole(role, opts)[0] || null
    },
    byRole(role, opts) {
      return view.queryByRole(role, opts) || fail(`no element with role "${role}"${opts?.name ? ` and name ${opts.name}` : ''}`)
    },

    queryByLabel(matcher) {
      const aria = hosts().find((f) => matches(f.props?.['aria-label'], matcher, false))
      if (aria) return aria
      const label = hosts().find((f) => f.type === 'label' && matches(textOf(f), matcher, false))
      if (!label) return null
      let control = null
      walk(label, (f) => {
        if (!control && f.kind === 'host' && CONTROLS.has(f.type)) control = f
      })
      return control
    },
    byLabel(matcher) {
      return view.queryByLabel(matcher) || fail(`no form control labelled ${matcher}`)
    },

    queryByPlaceholder(matcher) {
      return hosts().find((f) => matches(f.props?.placeholder, matcher, false)) || null
    },
    byPlaceholder(matcher) {
      return view.queryByPlaceholder(matcher) || fail(`no element with placeholder ${matcher}`)
    },

    queryByTestId(id) {
      return hosts().find((f) => f.props?.['data-testid'] === id) || null
    },
    byTestId(id) {
      return view.queryByTestId(id) || fail(`no element with data-testid "${id}"`)
    },

    async rerender(element) {
      root.element = element
      dirtyRoots.add(root)
      await act(() => {})
    },

    unmount() {
      unmountFiber(root.tree)
      root.unmounted = true
      root.tree = null
      dirtyRoots.delete(root)
    },
  }
  return view
}

function accessibleName(fiber) {
  return fiber.props?.['aria-label'] || textOf(fiber)
}

/**
 * Mount `element` and return a view for querying and interacting with it.
 * Always `await` it — mount effects (data loading) run before it resolves.
 */
export async function render(element) {
  const root = { element, tree: null, current: null, pendingEffects: [], idCounter: 0, unmounted: false }
  await act(() => {
    dirtyRoots.add(root)
  })
  return makeView(root)
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const NON_INTERACTIVE_WHEN_DISABLED = new Set(['onClick', 'onChange', 'onInput', 'onKeyDown', 'onKeyUp', 'onSubmit'])

function synthetic(node, extra) {
  let stopped = false
  const event = {
    defaultPrevented: false,
    target: extra.target ?? shimTarget(node),
    currentTarget: null,
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {
      stopped = true
    },
    isPropagationStopped: () => stopped,
    ...extra,
  }
  // The spread above would clobber the methods if a caller passed one; re-attach.
  event.preventDefault = () => {
    event.defaultPrevented = true
  }
  event.stopPropagation = () => {
    stopped = true
  }
  event.isPropagationStopped = () => stopped
  return event
}

const shimTarget = (node) => ({
  value: node?.props?.value,
  checked: node?.props?.checked,
  name: node?.props?.name,
  tagName: String(node?.type || '').toUpperCase(),
})

/** Dispatch a React synthetic event at `node`, bubbling up through ancestors. */
export async function fire(node, handlerName, init = {}) {
  if (!node) throw new Error(`cannot fire ${handlerName} on a missing element`)
  if (node.props?.disabled && NON_INTERACTIVE_WHEN_DISABLED.has(handlerName)) return
  const event = synthetic(node, init)
  batchDepth++
  try {
    let cur = node
    while (cur) {
      const handler = cur.kind === 'host' ? cur.props?.[handlerName] : null
      if (typeof handler === 'function' && !cur.props?.disabled) {
        event.currentTarget = shimTarget(cur)
        handler(event)
        if (event.isPropagationStopped()) break
      }
      cur = cur.parent
    }
  } finally {
    batchDepth--
  }
  await act(() => {})
}

export const click = (node, init) => fire(node, 'onClick', init)
export const change = (node, value) => fire(node, 'onChange', { target: { ...shimTarget(node), value } })
export const check = (node, checked = true) => fire(node, 'onChange', { target: { ...shimTarget(node), checked } })
export const keyDown = (node, key, init = {}) => fire(node, 'onKeyDown', { key, ...init })
export const submit = (node, init) => fire(node, 'onSubmit', init)
export const blur = (node, init) => fire(node, 'onBlur', init)
export const focus = (node, init) => fire(node, 'onFocus', init)

/** Type into an input by firing onChange for the whole value (React-controlled inputs). */
export const type = (node, value) => change(node, value)
