// The bits of "what would a browser do with this element" that both the renderer
// and the accessibility audits need. Kept separate from render.jsx so the audit
// helpers don't import the renderer, and separate from a11y.js so the renderer
// doesn't import the audit.

/** Elements a <label> can be associated with. */
export const CONTROLS = new Set(['input', 'select', 'textarea'])

const ARIA_HIDDEN = (props) => props?.['aria-hidden'] === true || props?.['aria-hidden'] === 'true'

/**
 * Text of a subtree as assistive tech would read it: `aria-hidden` subtrees are
 * removed, everything else is concatenated in document order.
 */
export function visibleText(fiber) {
  if (!fiber) return ''
  if (fiber.kind === 'text') return String(fiber.text ?? '')
  if (ARIA_HIDDEN(fiber.props)) return ''
  return (fiber.children || []).map(visibleText).join('')
}

// Roles that a keyboard user is expected to be able to operate, when they appear on
// a non-interactive tag. `role="button"` on a <span> is a real pattern in this app
// (InfoTip nests inside card buttons, where a nested <button> would be invalid).
const INTERACTIVE_ROLES = new Set(['button', 'link', 'switch', 'checkbox', 'radio', 'tab', 'menuitem'])

// Tailwind's `hidden` is `display: none`, which takes an element out of the
// accessibility tree entirely. The app uses it for the real <input type="file"> behind
// every "Add photo" / "Change photo" button: the input is never reached by anyone, and
// the button in front of it is the control that has to carry the name. Counting the
// input would report a gap that no agent can experience and hide the one that matters.
const isDisplayNone = (props) => /(^|\s)hidden(\s|$)/.test(String(props?.className ?? ''))

/**
 * Is this something the agent can operate — and therefore something that has to say
 * what it does? Hidden inputs and inputs the agent cannot reach are excluded.
 */
export function isInteractive(fiber) {
  if (fiber.kind !== 'host') return false
  const { type, props } = fiber
  if (props?.['aria-hidden'] === true || props?.['aria-hidden'] === 'true') return false
  if (isDisplayNone(props)) return false
  if (INTERACTIVE_ROLES.has(props?.role)) return true
  if (props?.role) return false // an explicit non-interactive role wins over the tag
  if (type === 'button') return true
  if (type === 'a') return Boolean(props?.href)
  if (type === 'select' || type === 'textarea') return true
  if (type === 'input') return (props?.type || 'text') !== 'hidden'
  return false
}

/**
 * Controls a keyboard user can reach and operate. A `role="button"` span is only
 * one of those if it carries a tabIndex and a key handler — without both it is a
 * mouse-only control, which is the shape this catches.
 */
export function isKeyboardOperable(fiber) {
  if (fiber.type === 'button' || CONTROLS.has(fiber.type) || fiber.type === 'a') return true
  if (fiber.props?.tabIndex === undefined || fiber.props.tabIndex < 0) return false
  return typeof fiber.props.onKeyDown === 'function' || typeof fiber.props.onKeyUp === 'function'
}
