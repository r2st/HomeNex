// Accessible-name resolution, for audits that sweep a whole screen rather than
// naming one control at a time.
//
// `accessibleNames.test.jsx` asserts that a *particular* control is named. That
// catches the gap you already know about. This module exists for the other half:
// mount a screen, ask which of its controls announce nothing, and fail on the whole
// set. A control added tomorrow is covered by a test written today.
//
// The rules below are the browser's, not an approximation of them, in the three
// places where the difference decides whether a real gap is reported:
//
//   1. A name is computed from CONTENTS with `aria-hidden` subtrees removed. Every
//      icon button in this app is `<button aria-label="…"><span aria-hidden>←</span>`,
//      so a resolver that counted hidden text would score the ones MISSING the
//      aria-label as named — the exact bug being looked for.
//   2. A wrapping `<label>` with no `for` names its FIRST labelable descendant and
//      stops. Two boxes in one label is a real shape in this app (country code +
//      phone number), and the second box genuinely has no name.
//   3. A `placeholder` is not a name. It disappears the moment the agent types.
//
// And one rule that is stricter than the platform's on purpose: a name has to
// contain a letter or a digit. "✓", "←", "→", "🗑" are names a browser will happily
// expose and a screen reader will announce as "check mark button" — which tells an
// agent using one exactly as much as silence does.
import { CONTROLS, isInteractive, isKeyboardOperable, visibleText } from './domish.js'

/** Text of a subtree as a screen reader would read it — aria-hidden removed. */
export { visibleText, isInteractive }

const hasWords = (s) => /[\p{L}\p{N}]/u.test(s)

function walkHosts(fiber, fn) {
  if (fiber.kind === 'host') fn(fiber)
  for (const child of fiber.children || []) walkHosts(child, fn)
}

// A <label> with no `for` names its first labelable descendant, and only that one.
function wrappingLabelName(fiber) {
  let cur = fiber.parent
  while (cur) {
    if (cur.kind === 'host' && cur.type === 'label') {
      let first = null
      walkHosts(cur, (f) => {
        if (!first && CONTROLS.has(f.type)) first = f
      })
      return first === fiber ? visibleText(cur).trim() : ''
    }
    cur = cur.parent
  }
  return ''
}

/**
 * The name a browser would expose for `fiber`, or '' if it would expose none.
 * `aria-labelledby` is trusted rather than resolved — the ids it points at live in
 * the same render, and the components using it (Sheet, Confirm) generate both ends
 * from one useId().
 */
export function accessibleNameOf(fiber) {
  const aria = fiber.props?.['aria-label']
  if (aria != null && String(aria).trim()) return String(aria).trim()
  if (fiber.props?.['aria-labelledby']) return String(fiber.props['aria-labelledby'])

  // Controls take their name from a label or a title, never from their own contents
  // (a <select>'s contents are its options) and never from a placeholder.
  if (CONTROLS.has(fiber.type)) {
    return wrappingLabelName(fiber) || String(fiber.props?.title ?? '').trim()
  }

  return visibleText(fiber).trim() || String(fiber.props?.title ?? '').trim()
}

/** Short "<button> ‹className›" description, for a failure message worth reading. */
export function describeControl(fiber) {
  const attrs = [
    fiber.props?.type && `type=${fiber.props.type}`,
    fiber.props?.placeholder && `placeholder=${JSON.stringify(fiber.props.placeholder)}`,
    fiber.props?.name && `name=${fiber.props.name}`,
  ].filter(Boolean)
  const text = visibleText(fiber).trim() || String(fiber.props?.children ?? '').trim()
  return `<${fiber.type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${text ? ` — renders ${JSON.stringify(text.slice(0, 40))}` : ''}`
}

/**
 * Every interactive control on the mounted screen that announces nothing, or
 * announces only a symbol. Returns descriptions, so an assertion failure names the
 * controls instead of printing fiber objects.
 */
export function namelessControls(view) {
  return view
    .all(isInteractive)
    .filter((f) => !hasWords(accessibleNameOf(f)))
    .map(describeControl)
}

/**
 * Assert the screen has no nameless control. Kept here rather than in each test so
 * the failure message — which controls, on which screen — is written once.
 */
export function assertAllControlsNamed(assert, view, screen) {
  const nameless = namelessControls(view)
  assert.deepEqual(
    nameless,
    [],
    `${screen}: ${nameless.length} control(s) announce nothing to a screen reader:\n  ${nameless.join('\n  ')}`,
  )
}

/**
 * Every interactive control the agent can see but cannot reach from the keyboard.
 * A `role="button"` on a <span> or <div> is the shape this catches: it looks and
 * clicks like a button, and without both a tabIndex and a key handler it is a
 * mouse-only control that a keyboard or switch user simply cannot operate.
 */
export function mouseOnlyControls(view) {
  return view.all(isInteractive).filter((f) => !isKeyboardOperable(f)).map(describeControl)
}

/**
 * Assert the screen has no mouse-only control. The companion to
 * `assertAllControlsNamed`: that one asks whether a control says what it does,
 * this one asks whether the agent can reach it at all.
 */
export function assertAllControlsKeyboardOperable(assert, view, screen) {
  const stranded = mouseOnlyControls(view)
  assert.deepEqual(
    stranded,
    [],
    `${screen}: ${stranded.length} control(s) cannot be reached from the keyboard:\n  ${stranded.join('\n  ')}`,
  )
}
