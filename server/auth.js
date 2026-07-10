import crypto from 'node:crypto'
import {
  createAgent,
  findAgentByEmail,
  findAgentByPhone,
  getAgent,
  getMeta,
  normalizePhone,
  setMeta,
} from './db.js'

// Session secret: env override, else generated once and persisted so restarts keep sessions.
// Resolved lazily (and cached) because reading it from the meta table is async now.
let secretPromise = null
function getSecret() {
  if (process.env.SESSION_SECRET) return Promise.resolve(process.env.SESSION_SECRET)
  if (!secretPromise) {
    secretPromise = (async () => {
      const stored = await getMeta('session_secret')
      if (stored) return stored
      const s = crypto.randomBytes(32).toString('hex')
      await setMeta('session_secret', s)
      return s
    })()
  }
  return secretPromise
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(password, salt, 64)
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate)
  } catch {
    return false
  }
}

const sign = async (id) =>
  crypto.createHmac('sha256', await getSecret()).update(String(id)).digest('hex')

export const issueToken = async (agentId) => `${agentId}.${await sign(agentId)}`

export async function verifyToken(token) {
  if (!token) return null
  const [id, sig] = String(token).split('.')
  if (!id || !sig) return null
  const expected = await sign(id)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  return (await getAgent(Number(id))) || null
}

export async function signup({ name, phone, email, password, wa_phone_number }) {
  name = (name || '').trim()
  phone = (phone || '').trim()
  email = (email || '').trim().toLowerCase() // optional
  const waPhone = (wa_phone_number || '').trim() || null // optional WABA number
  if (!name || !phone || !password) throw new Error('Name, WhatsApp number and password are required')
  // A valid WhatsApp number is at least 10 digits (Indian mobile) once normalized.
  const digits = normalizePhone(phone).replace(/\D/g, '')
  if (digits.length < 10) throw new Error('Enter a valid WhatsApp number')
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
  // WABA number must differ from the agent's personal WhatsApp number.
  if (waPhone) {
    const normalizedWa = normalizePhone(waPhone)
    const normalizedPersonal = normalizePhone(phone)
    if (normalizedWa === normalizedPersonal) {
      throw new Error('Your WhatsApp Business number must be different from your personal WhatsApp number')
    }
  }
  if (await findAgentByPhone(phone))
    throw new Error('An account with this WhatsApp number already exists — log in instead')
  if (email && (await findAgentByEmail(email)))
    throw new Error('An account with this email already exists — log in instead')
  const agent = await createAgent(name, phone, email || null, hashPassword(password), waPhone)
  return { token: await issueToken(agent.id), agent }
}

export async function login({ phone, email, password }) {
  // Log in by WhatsApp number (email still accepted for older accounts).
  const row = phone ? await findAgentByPhone(phone) : await findAgentByEmail((email || '').trim())
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    throw new Error('Wrong WhatsApp number or password')
  }
  const agent = await getAgent(row.id)
  return { token: await issueToken(agent.id), agent }
}

// Express middleware for the dashboard API.
export function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  verifyToken(token)
    .then((agent) => {
      if (!agent) return res.status(401).json({ error: 'unauthorized' })
      req.agent = agent
      next()
    })
    .catch(next)
}
