// Agent self-service over WhatsApp: a registered agent can text the shared HomeNex
// Business number to manage their own client list, instead of using the dashboard.
//   "9876543210" / "+919876543210" / "add 9876543210"  -> add that number as a client
//   a forwarded WhatsApp contact card                    -> add that contact
//   "list" / "my clients"                                -> reply with their client list
//   anything else                                        -> a short help message
import {
  normalizePhone,
  addContact,
  getContactByPhone,
  listContacts,
  logActivity,
} from './db.js'
import { sendText } from './whatsapp.js'

const LIST_WORDS = new Set(['list', 'clients', 'my clients', 'list clients', 'show clients'])
export const HELP_TEXT = "Send a phone number to add a client, or 'list' to see your clients"

// Pull the first phone-number-looking token out of free text (handles spaces, dashes, parens).
export function extractPhoneFromText(text) {
  if (!text) return null
  const m = String(text).match(/\+?\d[\d\s().-]{8,}\d/)
  if (!m) return null
  const cleaned = m[0].replace(/[^\d+]/g, '')
  if (cleaned.replace(/\D/g, '').length < 10) return null
  return cleaned
}

// Classify an agent's inbound message.
// -> { kind: 'list' } | { kind: 'add', phone, name } | { kind: 'help' }
export function parseAgentCommand(msg) {
  // A forwarded / shared WhatsApp contact card is the natural "add this customer" gesture.
  if (msg.type === 'contacts') {
    const card = msg.contacts?.[0]
    const phone = card?.phones?.[0]?.phone || card?.phones?.[0]?.wa_id
    if (phone) {
      const name = card?.name?.formatted_name || card?.name?.first_name || null
      return { kind: 'add', phone, name }
    }
    return { kind: 'help' }
  }
  if (msg.type !== 'text') return { kind: 'help' }
  const body = (msg.text?.body || '').trim()
  if (LIST_WORDS.has(body.toLowerCase())) return { kind: 'list' }
  const phone = extractPhoneFromText(body)
  if (phone) return { kind: 'add', phone, name: null }
  return { kind: 'help' }
}

async function formatClientList(agentId) {
  const clients = await listContacts(agentId)
  if (!clients.length) return 'You have no clients yet. Send a phone number to add one.'
  const lines = clients.map(
    (c, i) => `${i + 1}. ${c.phone}${c.name && c.name !== c.phone ? ' — ' + c.name : ''}`,
  )
  return `Your clients (${clients.length}):\n${lines.join('\n')}`
}

// Decide the reply for an agent command and apply any DB change. Pure of WhatsApp I/O
// so it can be unit-tested; the caller sends the returned text back over WhatsApp.
export async function runAgentCommand(agent, msg) {
  const cmd = parseAgentCommand(msg)
  if (cmd.kind === 'list') return formatClientList(agent.id)
  if (cmd.kind === 'add') {
    const p = normalizePhone(cmd.phone)
    const existing = await getContactByPhone(p)
    if (existing) {
      return existing.agent_id === agent.id
        ? 'Already in your client list'
        : 'This number is already registered by another agent'
    }
    try {
      await addContact(agent.id, p, cmd.name || p)
      await logActivity(agent.id, null, 'agent', `Added client ${p} via WhatsApp`)
      return `Added ${p} to your client list`
    } catch (err) {
      return err.message || HELP_TEXT
    }
  }
  return HELP_TEXT
}

// Full handler used by the webhook: run the command and reply to the agent on WhatsApp.
export async function handleAgentCommand({ agent, msg, phoneNumberId = null, send = true }) {
  const reply = await runAgentCommand(agent, msg)
  if (send) {
    try {
      await sendText(msg.from, reply, phoneNumberId)
    } catch (err) {
      console.error('agent reply send failed', err.message)
    }
  }
  return reply
}
