import crypto from 'node:crypto'
import {
  createAgent,
  findAgentByEmail,
  findAgentByPhone,
  getAgent,
  getAgentPasswordHash,
  getMeta,
  normalizePhone,
  setMeta,
  updateAgentPassword,
  updateAgentPhone,
} from './db.js'

export const MIN_PASSWORD_LENGTH = 6
const DEACTIVATED_MESSAGE = 'This account has been deactivated. Contact your admin.'

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
  const agent = await getAgent(Number(id))
  // A deactivated agent's existing sessions stop working immediately: the token is
  // an HMAC of the agent id with no server-side session to revoke, so this check
  // is what makes deactivation take effect for anyone already logged in.
  if (!agent || agent.is_active !== 1) return null
  return agent
}

export async function signup({ name, phone, email, password, wa_phone_number }) {
  name = (name || '').trim()
  phone = (phone || '').trim()
  email = (email || '').trim().toLowerCase() // optional
  if (!name || !phone || !password) throw new Error('Name, WhatsApp number and password are required')
  // A valid WhatsApp number is at least 10 digits (Indian mobile) once normalized.
  const digits = normalizePhone(phone).replace(/\D/g, '')
  if (digits.length < 10) throw new Error('Enter a valid WhatsApp number')
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  // We now use a single number: the agent's WhatsApp number IS their WhatsApp Business
  // number. Default the WABA number to the signup number (an explicit override is still
  // honoured, and may match the login number).
  const waPhone = (wa_phone_number || '').trim() || phone
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
  // Checked after the password so a deactivated account can't be discovered by
  // anyone who doesn't already hold its credentials.
  if (row.is_active !== 1) {
    const err = new Error(DEACTIVATED_MESSAGE)
    err.code = 'DEACTIVATED'
    throw err
  }
  const agent = await getAgent(row.id)
  return { token: await issueToken(agent.id), agent }
}

// Change the logged-in agent's own WhatsApp number. That number is how they log in,
// so the current password is required — a stolen session alone must not be enough to
// move the account onto an attacker's number. The session token is an HMAC of the agent
// id, so it stays valid afterwards and the agent is not logged out.
export async function changePhone(agentId, { phone, password } = {}) {
  const hash = await getAgentPasswordHash(agentId)
  if (!hash || !verifyPassword(password || '', hash)) {
    const err = new Error('Wrong password')
    err.code = 'BAD_PASSWORD'
    throw err
  }
  return updateAgentPhone(agentId, phone)
}

// Change the logged-in agent's own password. The current password is required —
// a stolen session alone must not be enough to lock the real agent out.
// The session token is an HMAC of the agent id, so it survives the change and the
// agent stays logged in here; sessions on other devices also keep working.
export async function changePassword(agentId, { current_password, new_password } = {}) {
  const hash = await getAgentPasswordHash(agentId)
  if (!hash || !verifyPassword(current_password || '', hash)) {
    const err = new Error('Wrong password')
    err.code = 'BAD_PASSWORD'
    throw err
  }
  const next = String(new_password ?? '')
  if (next.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    err.code = 'WEAK_PASSWORD'
    throw err
  }
  if (verifyPassword(next, hash)) {
    const err = new Error('New password must be different from your current password')
    err.code = 'SAME_PASSWORD'
    throw err
  }
  return updateAgentPassword(agentId, hashPassword(next))
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
