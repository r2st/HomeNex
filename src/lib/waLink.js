// wa.me click-to-chat — the default way the dashboard sends a WhatsApp message.
//
// Without the optional Meta WhatsApp Business API upgrade nothing is sent from our
// servers: the dashboard opens the agent's own WhatsApp (app on a phone, WhatsApp
// Desktop / Web on a computer) with the client's chat and the message pre-filled, and
// the agent taps send there. `wa_send_mode` on the lead / agent says which applies:
// 'link' (wa.me, the default) or 'api' (Meta Cloud API, opted in per account).

export const isLinkMode = (mode) => mode === 'link'

// wa.me/<digits>?text=<message>. Only digits survive from the phone; no phone gives
// the contact-picker form (wa.me/?text=…).
export function buildWaLink(phone, text) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const q = text ? `?text=${encodeURIComponent(text)}` : ''
  return `https://wa.me/${digits}${q}`
}

// Opens a wa.me link in a new tab, which hands off to the WhatsApp app. When the
// browser blocks the tab — iOS Safari does once an await has passed since the tap —
// the current page navigates to it instead; WhatsApp's universal link still opens the
// app and the agent comes straight back. Returns whether anything was opened.
export function openWhatsApp(url, win = globalThis.window) {
  if (!url || !win) return false
  let tab = null
  try {
    tab = win.open(url, '_blank')
  } catch {
    tab = null
  }
  if (tab) {
    try {
      tab.opener = null
    } catch {
      /* cross-origin already — nothing to sever */
    }
    return true
  }
  try {
    win.location.assign(url)
    return true
  } catch {
    return false
  }
}

// Copy for the send controls, so every screen says the same thing about where the
// message actually goes.
export const WA_LINK_HINT = 'Opens WhatsApp on your phone or computer with this message ready — tap send there.'
export const WA_API_HINT = 'Sends a real WhatsApp message from your business number.'
export const sendLabel = (mode, { done = false } = {}) =>
  isLinkMode(mode) ? (done ? '✓ Opened' : 'Open WhatsApp') : done ? '✓ Sent' : 'Send'
