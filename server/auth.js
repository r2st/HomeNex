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

// A password check against an account that doesn't exist still has to cost what a
// real one costs. scryptSync takes ~100ms; a lookup miss takes microseconds, so
// returning early on "no such agent" turns login into a reliable oracle for
// enumerating which numbers hold HomeNex accounts — and in a market where the
// login id IS the agent's WhatsApp number, that list is worth money to a
// competitor or a spammer. Every miss is verified against this throwaway hash
// instead, so hit and miss do the same work.
const ABSENT_ACCOUNT_HASH = hashPassword(crypto.randomBytes(32).toString('hex'))

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(password, salt, 64)
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), candidate)
  } catch {
    return false
  }
}

// The signed payload is the agent id AND their current token version. There is no
// server-side session row to delete, so the version is what makes revocation
// possible at all: bumping the agent's token_version changes what every token for
// that agent must be signed over, and every token issued under the old value stops
// verifying. Password change bumps it (see db.updateAgentPassword).
const sign = async (id, version) =>
  crypto.createHmac('sha256', await getSecret()).update(`${id}.${version}`).digest('hex')

// The version is optional: a caller that already holds the agent row passes it to
// save a read, and anyone holding only an id gets the agent's current one looked up.
// Defaulting to a lookup rather than to a constant is what stops a caller from
// quietly minting a token under a version that has already been rotated away.
export async function issueToken(agentId, version) {
  const v = version ?? (await getAgent(agentId))?.token_version ?? 1
  return `${agentId}.${v}.${await sign(agentId, v)}`
}

export async function verifyToken(token) {
  if (!token) return null
  // Three parts exactly: a legacy two-part token from before versioning has no
  // version to check and is refused rather than trusted.
  const parts = String(token).split('.')
  if (parts.length !== 3) return null
  const [id, version, sig] = parts
  if (!id || !version || !sig) return null
  const expected = await sign(id, version)
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  const agent = await getAgent(Number(id))
  // A deactivated agent's existing sessions stop working immediately, and so do the
  // sessions of anyone whose password has since changed — this pair of checks is
  // what makes both take effect for someone already logged in.
  if (!agent || agent.is_active !== 1) return null
  if (Number(agent.token_version) !== Number(version)) return null
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
  return { token: await issueToken(agent.id, agent.token_version), agent }
}

export async function login({ phone, email, password }) {
  // Log in by WhatsApp number (email still accepted for older accounts).
  const row = phone ? await findAgentByPhone(phone) : await findAgentByEmail((email || '').trim())
  // Always verify, even with nothing to verify against — see ABSENT_ACCOUNT_HASH.
  const ok = verifyPassword(password || '', row ? row.password_hash : ABSENT_ACCOUNT_HASH)
  if (!row || !ok) {
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
  return { token: await issueToken(agent.id, agent.token_version), agent }
}

// Change the logged-in agent's own WhatsApp number. That number is how they log in,
// so the current password is required — a stolen session alone must not be enough to
// move the account onto an attacker's number. This does not touch token_version, so
// every device stays logged in: the account itself hasn't changed hands.
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
//
// Changing the password signs every other device out. An agent who changes it
// because someone else has their phone expects exactly that, and before token
// versioning they didn't get it: the old sessions kept working and the only real
// remedy was for an admin to deactivate the account. The device making the change
// is handed a token signed with the new version, so it alone stays logged in.
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
  const agent = await updateAgentPassword(agentId, hashPassword(next))
  return { agent, token: await issueToken(agent.id, agent.token_version) }
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
