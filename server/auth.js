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
const SECRET =
  process.env.SESSION_SECRET ||
  getMeta('session_secret') ||
  (() => {
    const s = crypto.randomBytes(32).toString('hex')
    setMeta('session_secret', s)
    return s
  })()

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

const sign = (id) => crypto.createHmac('sha256', SECRET).update(String(id)).digest('hex')

export const issueToken = (agentId) => `${agentId}.${sign(agentId)}`

export function verifyToken(token) {
  if (!token) return null
  const [id, sig] = String(token).split('.')
  if (!id || !sig) return null
  const expected = sign(id)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  return getAgent(Number(id)) || null
}

export function signup({ name, phone, email, password }) {
  name = (name || '').trim()
  phone = (phone || '').trim()
  email = (email || '').trim().toLowerCase() // optional
  if (!name || !phone || !password) throw new Error('Name, WhatsApp number and password are required')
  // A valid WhatsApp number is at least 10 digits (Indian mobile) once normalized.
  const digits = normalizePhone(phone).replace(/\D/g, '')
  if (digits.length < 10) throw new Error('Enter a valid WhatsApp number')
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
  if (findAgentByPhone(phone))
    throw new Error('An account with this WhatsApp number already exists — log in instead')
  if (email && findAgentByEmail(email)) throw new Error('An account with this email already exists — log in instead')
  const agent = createAgent(name, phone, email || null, hashPassword(password))
  return { token: issueToken(agent.id), agent }
}

export function login({ phone, email, password }) {
  // Log in by WhatsApp number (email still accepted for older accounts).
  const row = phone ? findAgentByPhone(phone) : findAgentByEmail((email || '').trim())
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    throw new Error('Wrong WhatsApp number or password')
  }
  const agent = getAgent(row.id)
  return { token: issueToken(agent.id), agent }
}

// Express middleware for the dashboard API.
export function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const agent = verifyToken(token)
  if (!agent) return res.status(401).json({ error: 'unauthorized' })
  req.agent = agent
  next()
}
