import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decayLead, hybridScore, ruleSignals } from './scoring.js'
import { worklistItem, rankWorklist, worklistCounts, followupPriority } from './worklist.js'
import { rankPropertyMatches } from './matching.js'
import { gstBreakdown, GST_RATE } from './money.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// COUNT()/BIGINT (paise) come back as JS numbers, not strings. Safe: 2^53 paise
// is ~90 trillion rupees. NUMERIC (commission_pct) likewise parses to a number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)))
// DATE (rera_expiry, commission payout dates) comes back as a plain 'YYYY-MM-DD'
// string, not a JS Date at local midnight — avoids off-by-one timezone shifts.
pg.types.setTypeParser(1082, (v) => v)

const connectionString =
  process.env.DATABASE_URL || 'postgres://homenex:homenex@localhost:5432/homenex'

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PG_POOL_SIZE || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})
pool.on('error', (err) => console.error('idle postgres client error', err.message))

const q = (text, params) => pool.query(text, params)

// --- Migrations: versioned SQL files in server/migrations/, applied in order once. ---
const MIGRATION_LOCK = 727274 // arbitrary app-wide advisory lock id

async function runMigrations() {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    const dir = path.join(__dirname, 'migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    )
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
        await client.query('COMMIT')
        console.log(`migration applied: ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        err.message = `migration ${file} failed: ${err.message}`
        throw err
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {})
    client.release()
  }
}

// Await this before serving requests (index.js and tests do).
export const ready = runMigrations()

export async function closePool() {
  await pool.end()
}

// Cheap liveness probe for /healthz — confirms a client can be checked out and the
// database answers. Throws if the pool is exhausted or Postgres is unreachable.
export async function dbPing() {
  const { rows } = await q('SELECT 1 AS ok')
  return rows[0]?.ok === 1
}

// Build "SET col = $n" fragments from an allowlisted field object. JSONB columns
// need their JS values stringified or pg would send arrays as postgres arrays.
function buildSet(allowed, fields, startIndex = 1) {
  const sets = []
  const params = []
  for (const [col, kind] of Object.entries(allowed)) {
    if (!(col in fields)) continue
    let v = fields[col]
    if (kind === 'jsonb' && v !== null && v !== undefined) v = JSON.stringify(v)
    sets.push(`${col} = $${startIndex + params.length}`)
    params.push(v === undefined ? null : v)
  }
  return { sets, params }
}

// Ownership check for an OPTIONAL foreign key supplied by the client (a deal's
// property_id, a commission's deal_id, and so on).
//
// The row itself is always written with the caller's agent_id, so the row can't
// be stolen — but the id it *points at* is client-controlled, and these ids are
// sequential integers, so an agent could point at another agent's row and read
// the joined columns back out. Enforced here rather than in each route so a new
// caller cannot forget it.
//
// `table` is a code-level literal, never client input.
async function assertOwned(table, id, agentId, label) {
  if (id === null || id === undefined || id === '') return null
  const { rows } = await q(`SELECT 1 FROM ${table} WHERE id = $1 AND agent_id = $2`, [id, agentId])
  if (!rows.length) {
    // Deliberately the same message whether the row is missing or belongs to
    // someone else — the difference would confirm the id exists.
    const err = new Error(`${label} not found`)
    err.code = 'NOT_OWNED'
    throw err
  }
  return id
}

// Canonical storage form for a WhatsApp number: leading "+" and digits only.
// A bare 10-digit Indian number is assumed to be +91.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+')) return '+' + d.slice(1).replace(/\D/g, '')
  d = d.replace(/\D/g, '')
  // India's STD trunk prefix. Agents type "098765 43210" out of habit, but the 0
  // is a domestic-dialling artefact, never part of the number — keeping it made
  // an unroutable "+09876543210". Dropping it turns an 11-digit trunk-dialled
  // number back into the 10 national digits the next rule expands to +91
  // (this also fixes STD landlines: "022 2345 6789" -> "+912223456789").
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length === 10) d = '91' + d // default Indian country code
  return '+' + d
}

// Strict form of normalizePhone for numbers that must be Indian mobiles — the agent's
// own login number. Accepts what agents actually type ("9876543210", "098765 43210",
// "+91 98765-43210", "919876543210") and returns canonical "+919876543210".
// Returns null for anything that is not a 10-digit mobile starting 6-9.
export function normalizeIndianMobile(raw) {
  const s = String(raw ?? '').trim()
  // Only digits and the separators people type — letters or punctuation mean it isn't a number.
  // The digit-shape check below is what actually validates it.
  if (!s || !/^[+\d\s().-]+$/.test(s)) return null
  let d = s.replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2) // country code
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1) // STD trunk prefix
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null
}

// Digits only, for loose comparison against Meta's display_phone_number (which has no "+").
const phoneDigits = (raw) => String(raw || '').replace(/\D/g, '')

const AGENT_COLS =
  'id, name, phone, email, business_name, city, bio, rera_id, rera_state, rera_expiry, avatar_url, ' +
  'timezone, language, notify_new_lead, notify_followup_due, notify_daily_digest, ' +
  'quiet_hours_start, quiet_hours_end, is_active, deactivated_at, ' +
  'wa_phone_number_id, wa_phone_number, waba_status, waba_registered_at, meta_waba_id, is_admin, ingest_token, ' +
  'token_version, created_at'

export async function createAgent(name, phone, email, passwordHash, waPhoneNumber = null) {
  const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
  if (pn && pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid WhatsApp Business number')
  let rows
  try {
    ;({ rows } = await q(
      `INSERT INTO agents (name, phone, email, password_hash, wa_phone_number, waba_status, ingest_token)
       VALUES ($1, $2, $3, $4, $5, $6, substr(md5(random()::text || clock_timestamp()::text), 1, 12))
       RETURNING id`,
      [name, normalizePhone(phone), email ? email.toLowerCase() : null, passwordHash, pn, pn ? 'pending' : 'none'],
    ))
  } catch (e) {
    // signup checks both of these first, so reaching the constraint means two
    // signups raced. Surface the same message the pre-check would have, not the
    // raw Postgres text.
    if (e.code !== '23505') throw e
    const err = new Error(
      e.constraint === 'idx_agents_email_unique'
        ? 'An account with this email already exists — log in instead'
        : 'An account with this WhatsApp number already exists — log in instead',
    )
    err.code = 'AGENT_EXISTS'
    throw err
  }
  // Every workspace starts with the system labels, default quick replies and the
  // curated pre-approved template pack (mirrors the 010 migration seed for new agents).
  await seedWorkspaceDefaults(rows[0].id)
  return getAgent(rows[0].id)
}

export async function getAgent(id) {
  const { rows } = await q(`SELECT ${AGENT_COLS} FROM agents WHERE id = $1`, [id])
  return rows[0]
}

export async function findAgentByPhone(phone) {
  const { rows } = await q('SELECT * FROM agents WHERE phone = $1', [normalizePhone(phone)])
  return rows[0]
}

// Matched on lower(email) so it rides the unique index from migration 017 (and so
// a differently-cased address resolves to the one account that owns it).
export async function findAgentByEmail(email) {
  if (!email) return null
  const { rows } = await q('SELECT * FROM agents WHERE lower(email) = $1', [email.toLowerCase()])
  return rows[0] || null
}

// getAgent() deliberately omits password_hash; fetch it explicitly when re-authenticating.
export async function getAgentPasswordHash(agentId) {
  const { rows } = await q('SELECT password_hash FROM agents WHERE id = $1', [agentId])
  return rows[0]?.password_hash || null
}

// Update an agent's per-agent WhatsApp Business number configuration.
// waPhoneNumber is the display number (E.164), waPhoneNumberId is the Meta API phone_number_id.
// Either or both can be null to clear the configuration.
export async function updateAgentPhoneConfig(agentId, waPhoneNumber, waPhoneNumberId) {
  const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
  if (pn && pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid WhatsApp Business number')
  // Ensure wa_phone_number_id is unique across agents (two agents can't share the same line).
  if (waPhoneNumberId) {
    const { rows } = await q('SELECT id FROM agents WHERE wa_phone_number_id = $1 AND id != $2', [
      waPhoneNumberId,
      agentId,
    ])
    if (rows[0]) {
      const err = new Error('This WhatsApp Business number ID is already assigned to another agent')
      err.code = 'PHONE_ID_TAKEN'
      throw err
    }
  }
  await q('UPDATE agents SET wa_phone_number = $1, wa_phone_number_id = $2 WHERE id = $3', [
    pn,
    waPhoneNumberId || null,
    agentId,
  ])
  return getAgent(agentId)
}

// Agent sets/updates their WA Business number: first-time set moves waba_status to 'pending'.
export async function setAgentWaPhone(agentId, waPhoneNumber) {
  const norm = normalizePhone(waPhoneNumber)
  const current = await getAgent(agentId)
  const isNew = !current.wa_phone_number
  await q(
    `UPDATE agents SET wa_phone_number = $1,
       waba_status = CASE WHEN waba_status = 'none' THEN 'pending' ELSE waba_status END
     WHERE id = $2`,
    [norm, agentId],
  )
  if (isNew) await q(`UPDATE agents SET waba_status = 'pending' WHERE id = $1`, [agentId])
  return getAgent(agentId)
}

// Find the agent who owns a specific Meta phone_number_id. Used for inbound webhook routing:
// when a message arrives on a specific WhatsApp Business line, route it to the agent who owns it.
// Only returns agents whose WABA status is 'active' — pending/registered numbers aren't live yet.
// Deactivated agents are never matched: their line must stop capturing leads.
export async function findAgentByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null
  // First try active WABA agents (the main production path).
  const active = (
    await q(
      `SELECT * FROM agents WHERE wa_phone_number_id = $1 AND waba_status = 'active' AND is_active = 1`,
      [phoneNumberId],
    )
  ).rows[0]
  if (active) return active
  // Fallback: agents who manually configured phone_number_id (pre-WABA flow, backward compat).
  return (
    (await q('SELECT * FROM agents WHERE wa_phone_number_id = $1 AND is_active = 1', [phoneNumberId])).rows[0] ||
    null
  )
}

// --- Contacts: the agent's known clients on the shared WhatsApp number ---

// Shared number routing: find which agent owns an inbound sender's number.
// Matches on full digits, then on a 10-digit suffix as a fallback (a client saved
// as '9812000001' must still route when WhatsApp reports '919812000001').
//
// This runs for every message that arrives on the shared number, so it is the
// hottest read in the product. It used to fetch `SELECT * FROM contacts` — every
// agent's entire address book — and scan it twice in JavaScript. The digit
// comparison is now done in SQL against the expression indexes from migration 018,
// so it reads one row instead of the whole table.
//
// The ORDER BY keeps the old priority (an exact digit match beats a suffix match)
// and settles ties by id, where the JS scan settled them by whatever order the
// table happened to come back in. Oldest contact wins is at least a rule.
export async function findContactByWaId(waId) {
  const digits = phoneDigits(waId)
  if (!digits) return null
  const { rows } = await q(
    `SELECT * FROM contacts
      WHERE regexp_replace(phone, '\\D', '', 'g') = $1
         OR right(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
      ORDER BY (regexp_replace(phone, '\\D', '', 'g') = $1) DESC, id
      LIMIT 1`,
    [digits, digits.slice(-10)],
  )
  return rows[0] || null
}

// Look up a client row by phone (across all agents), used to decide whose list a number is in.
export async function getContactByPhone(phone) {
  const { rows } = await q('SELECT * FROM contacts WHERE phone = $1', [normalizePhone(phone)])
  return rows[0]
}

// List an agent's clients, annotated with whether that number has ever messaged.
// q searches name/phone (substring); source filters on how the contact was captured.
//
// Paged by default, like the lead list and for the sharper of the two reasons. The
// contact row is narrow, but every row costs two correlated subqueries over messages
// and leads, so the price of this query is paid per row returned — and the Contacts
// screen re-runs it every 6 seconds. Unbounded, an agent with 10k captured numbers was
// making postgres do 20k index scans a poll to render a screen that shows about eight.
// Callers that want the true total ask contactCount() rather than measuring the array.
export async function listContacts(agentId, { search = '', source = '', limit, offset } = {}) {
  const { where, params } = contactFilter(agentId, search, source)
  params.push(pageLimit(limit))
  const limitParam = `$${params.length}`
  params.push(pageOffset(offset))
  const offsetParam = `$${params.length}`
  const { rows } = await q(
    // Both subqueries match a lead by phone number, and both must ALSO match on
    // agent_id. Without it they matched every agent's lead for that number: the same
    // buyer messaging two brokers on the shared line gave each of them the other's
    // message count and last-activity time. It is also the whole cost of this query —
    // `WHERE l.wa_id = ...` alone can't use UNIQUE (agent_id, wa_id), so each contact
    // row drove a sequential scan of the entire leads table.
    `SELECT c.*,
       (SELECT COUNT(*) FROM messages m
          JOIN leads l ON l.id = m.lead_id
          WHERE l.agent_id = c.agent_id AND l.wa_id = replace(c.phone, '+', '')
            AND m.role = 'buyer') AS msg_count,
       (SELECT MAX(l.updated_at) FROM leads l
          WHERE l.agent_id = c.agent_id AND l.wa_id = replace(c.phone, '+', '')) AS last_at
     FROM contacts c
     WHERE ${where.join(' AND ')}
     -- id breaks the tie, for the same reason it does in listLeads: neither
     -- last_message_at nor created_at is unique — a batch import stamps a whole set of
     -- contacts within the same millisecond — and a non-deterministic sort makes OFFSET
     -- paging drop and duplicate rows across pages.
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  )
  return rows
}

// The WHERE that listContacts and contactCount must agree on. Shared so the count can
// never describe a different set of rows than the page it accompanies — the header
// saying 900 while the filter that produced the list matched 3.
function contactFilter(agentId, search, source) {
  const where = ['c.agent_id = $1']
  const params = [agentId]
  if (search) {
    params.push(`%${search}%`)
    where.push(`(c.name ILIKE $${params.length} OR c.phone LIKE $${params.length})`)
  }
  if (source) {
    params.push(source)
    where.push(`c.source = $${params.length}`)
  }
  return { where, params }
}

// How many contacts match, without shipping them. This is what lets the Contacts header
// say "1,204 auto-captured from WhatsApp" while the list below holds one page — the
// count the screen used to get by calling .length on an unbounded response.
export async function contactCount(agentId, { search = '', source = '' } = {}) {
  const { where, params } = contactFilter(agentId, search, source)
  const { rows } = await q(
    `SELECT COUNT(*)::int AS total FROM contacts c WHERE ${where.join(' AND ')}`,
    params,
  )
  return { total: rows[0].total }
}

// Contact detail: the contact row plus every lead linked to it (or matching its number).
export async function getContactDetail(id, agentId) {
  const contact = await getContact(id, agentId)
  if (!contact) return null
  const { rows: leads } = await q(
    `SELECT * FROM leads
     WHERE agent_id = $1 AND (contact_id = $2 OR wa_id = replace($3, '+', ''))
     ORDER BY updated_at DESC`,
    [agentId, id, contact.phone],
  )
  return { ...contact, leads }
}

// Add one client. Throws on a phone already claimed (by any agent — UNIQUE(phone)).
// opts.source tags where the contact came from (whatsapp_inbound/portal/facebook/walk_in/referral).
export async function addContact(agentId, phone, name, notes = null, opts = {}) {
  const p = normalizePhone(phone)
  if (p.replace(/\D/g, '').length < 10) throw new Error('Enter a valid phone number')
  if (!name || !String(name).trim()) throw new Error('Client name is required')
  const existing = await getContactByPhone(p)
  if (existing) {
    const err = new Error(
      existing.agent_id === agentId
        ? 'This client is already in your list'
        : 'This number is already claimed by another agent',
    )
    err.code = 'CONTACT_EXISTS'
    throw err
  }
  const { rows } = await q(
    `INSERT INTO contacts (agent_id, phone, name, notes, source, source_detail)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      agentId,
      p,
      String(name).trim(),
      notes ? String(notes).trim() : null,
      opts.source || 'whatsapp_inbound',
      opts.sourceDetail || null,
    ],
  )
  return rows[0]
}

export async function getContact(id, agentId) {
  const { rows } = await q('SELECT * FROM contacts WHERE id = $1 AND agent_id = $2', [id, agentId])
  return rows[0]
}

export async function updateContact(id, agentId, fields) {
  const { sets, params } = buildSet(
    { name: 'text', notes: 'text', opt_in_status: 'text', labels: 'jsonb', source: 'text', source_detail: 'text' },
    fields,
  )
  if (!sets.length) return getContact(id, agentId)
  const { rows } = await q(
    `UPDATE contacts SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0]
}

// Stamp message activity on a contact (first/last message timestamps).
export async function recordContactMessage(phone) {
  await q(
    `UPDATE contacts SET
       first_message_at = COALESCE(first_message_at, now()),
       last_message_at = now(),
       updated_at = now()
     WHERE phone = $1`,
    [normalizePhone(phone)],
  )
}

export async function deleteContact(id, agentId) {
  const contact = await getContact(id, agentId)
  if (!contact) return false
  // Leads keep their conversation history; they just lose the contact link.
  await q('UPDATE leads SET contact_id = NULL WHERE contact_id = $1', [id])
  const res = await q('DELETE FROM contacts WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
}

export async function getMeta(key) {
  const { rows } = await q('SELECT value FROM meta WHERE key = $1', [key])
  return rows[0]?.value
}

export async function setMeta(key, value) {
  await q(
    'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  )
}

export async function upsertLead(agentId, waId, name) {
  const { rows } = await q(
    `INSERT INTO leads (agent_id, wa_id, name, phone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id, wa_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, leads.name),
       updated_at = now()
     RETURNING *`,
    [agentId, waId, name || null, waId],
  )
  // A new lead is the number an agent watches for on the dashboard, so don't make
  // them wait out the stats TTL to see it.
  invalidateStats(agentId)
  return rows[0]
}

// Unassigned pool: a message from an unknown sender on the shared number. Deduped by
// wa_id among the NULL-agent rows (the UNIQUE constraint does not cover NULLs).
export async function upsertUnassignedLead(waId, name) {
  const existing = (await q('SELECT * FROM leads WHERE agent_id IS NULL AND wa_id = $1', [waId])).rows[0]
  if (existing) {
    const { rows } = await q(
      'UPDATE leads SET name = COALESCE($1, name), updated_at = now() WHERE id = $2 RETURNING *',
      [name || null, existing.id],
    )
    return rows[0]
  }
  const { rows } = await q(
    `INSERT INTO leads (agent_id, wa_id, name, phone, source) VALUES (NULL, $1, $2, $3, 'WhatsApp') RETURNING *`,
    [waId, name || null, waId],
  )
  return rows[0]
}

// Link an agent-owned lead to its CRM contact and give it a pipeline position.
// Idempotent: never overwrites an existing link, pipeline type, or stage.
export async function attachLeadContact(leadId, contactId) {
  await q(
    `UPDATE leads SET
       contact_id = COALESCE(contact_id, $2),
       pipeline_type = COALESCE(pipeline_type, 'buy_primary'),
       stage = COALESCE(stage, 'New')
     WHERE id = $1`,
    [leadId, contactId],
  )
}

// Claim an unassigned lead. Only succeeds while the lead is still in the pool.
export async function assignLead(leadId, agentId) {
  const res = await q('UPDATE leads SET agent_id = $1 WHERE id = $2 AND agent_id IS NULL', [agentId, leadId])
  return res.rowCount > 0 ? getLead(leadId) : null
}

export async function getLead(id) {
  return (await q('SELECT * FROM leads WHERE id = $1', [id])).rows[0]
}

// Ownership-checked lookup for dashboard routes: only returns the lead if it belongs to the agent.
export async function getLeadForAgent(id, agentId) {
  return (await q('SELECT * FROM leads WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
}

// Like getLeadForAgent, but also returns unassigned-pool leads so any agent can inspect/claim them.
export async function getAssignableLead(id, agentId) {
  return (
    await q('SELECT * FROM leads WHERE id = $1 AND (agent_id = $2 OR agent_id IS NULL)', [id, agentId])
  ).rows[0]
}

export async function addMessage(leadId, role, text, waMessageId = null) {
  const { rows } = await q(
    'INSERT INTO messages (lead_id, role, text, wa_message_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [leadId, role, text, waMessageId],
  )
  // The 24h service window's anchor (last_inbound_at) and its outbound twin are no
  // longer stamped here: migration 025 moved both onto an AFTER INSERT trigger, so
  // they hold for every write path rather than only this one, and they carry the
  // message's own created_at instead of now(). This UPDATE still runs — updated_at is
  // what orders every lead list — and the owning agent comes back from it, so
  // freshening their cached counters (messages today, threads active in 24h) costs no
  // extra round-trip.
  const touched = await q(
    'UPDATE leads SET updated_at = now() WHERE id = $1 RETURNING agent_id',
    [leadId],
  )
  const ownerId = touched.rows[0]?.agent_id
  if (ownerId != null) invalidateStats(ownerId)
  return rows[0]
}

// WhatsApp 24h service window state for a lead. The window opens on the last
// inbound (buyer) message; after 24h only template messages may be sent.
export function serviceWindow(lead) {
  if (!lead?.last_inbound_at) return { open: false, expires_at: null }
  const expires = new Date(new Date(lead.last_inbound_at).getTime() + 24 * 3600_000)
  return { open: expires.getTime() > Date.now(), expires_at: expires.toISOString() }
}

// --- Who spoke last, straight off the lead row -----------------------------
// Both columns are maintained by the trigger added in migration 025, which is also
// where the reasoning lives. These two fragments are the only way the app should ask
// the question: written once, they stay word-for-word identical to the predicates on
// idx_leads_awaiting_reply and idx_leads_last_contact, which is what lets the planner
// prove those partial indexes apply.

// The buyer has spoken since we last did — the lead is waiting on a reply. A lead
// with no inbound at all is not waiting, and a tie counts as answered.
export const AWAITING_REPLY =
  '(l.last_inbound_at IS NOT NULL AND (l.last_outbound_at IS NULL OR l.last_outbound_at < l.last_inbound_at))'

// The last time anyone said anything, in either direction. NULL for a lead created by
// hand that has never exchanged a message.
export const LAST_CONTACT_AT = 'GREATEST(l.last_inbound_at, l.last_outbound_at)'

export async function getMessages(leadId, limit = 200) {
  return (await q('SELECT * FROM messages WHERE lead_id = $1 ORDER BY id LIMIT $2', [leadId, limit])).rows
}

export async function recordFirstResponse(leadId) {
  const lead = await getLead(leadId)
  if (!lead || lead.first_response_s != null) return
  const row = (
    await q(
      `SELECT EXTRACT(EPOCH FROM (
         (SELECT MIN(created_at) FROM messages WHERE lead_id = $1 AND role IN ('ai','agent')) -
         (SELECT MIN(created_at) FROM messages WHERE lead_id = $1 AND role = 'buyer')
       ))::float AS seconds`,
      [leadId],
    )
  ).rows[0]
  if (row.seconds == null) return
  await q('UPDATE leads SET first_response_s = $1 WHERE id = $2', [Math.max(row.seconds, 0), leadId])
}

export async function applyExtraction(leadId, x) {
  // Legacy budget columns are lakhs; the CRM columns (budget_min/budget_max) are paise.
  const paise = (lakhs) => (lakhs == null ? null : Math.round(Number(lakhs) * 1e7))
  const { rows: touched } = await q(
    `UPDATE leads SET
       intent = COALESCE($17, intent),
       bhk = COALESCE($18, bhk),
       preferred_localities = COALESCE($19, preferred_localities),
       financing = COALESCE($20, financing),
       budget_min = COALESCE($21, budget_min),
       budget_max = COALESCE($22, budget_max),
       ai_score = COALESCE($23, ai_score),
       ai_score_reason = COALESCE($24, ai_score_reason),
       ai_extracted = COALESCE($25, ai_extracted),
       name = COALESCE($1, name),
       temp = COALESCE($2, temp),
       score = COALESCE($3, score),
       config = COALESCE($4, config),
       config_note = COALESCE($5, config_note),
       locality = COALESCE($6, locality),
       location_note = COALESCE($7, location_note),
       budget_min_l = COALESCE($8, budget_min_l),
       budget_max_l = COALESCE($9, budget_max_l),
       budget_note = COALESCE($10, budget_note),
       timeline = COALESCE($11, timeline),
       timeline_note = COALESCE($12, timeline_note),
       ai_summary = COALESCE($13, ai_summary),
       next_step = COALESCE($14, next_step),
       score_breakdown = COALESCE($15, score_breakdown),
       updated_at = now()
     WHERE id = $16
     RETURNING agent_id`,
    [
      x.name ?? null,
      x.temp ?? null,
      x.score ?? null,
      x.config ?? null,
      x.config_note ?? null,
      x.locality ?? null,
      x.location_note ?? null,
      x.budget_min_l ?? null,
      x.budget_max_l ?? null,
      x.budget_note ?? null,
      x.timeline ?? null,
      x.timeline_note ?? null,
      x.summary ?? null,
      x.next_step ?? null,
      x.score_breakdown ? JSON.stringify(x.score_breakdown) : null,
      leadId,
      x.intent ?? null,
      x.bhk ?? null,
      x.preferred_localities ? JSON.stringify(x.preferred_localities) : null,
      x.financing ?? null,
      paise(x.budget_min_l),
      paise(x.budget_max_l),
      x.temp ? x.temp.toLowerCase() : null,
      x.score_reason ?? null,
      JSON.stringify(x),
    ],
  )
  // temp, score and the budget columns all feed the dashboard counters (hot_now,
  // pipeline_l, qualified). The inbound path invalidates on the buyer's message,
  // which happens BEFORE this runs — so without this the extraction's numbers could
  // sit behind a cache entry written from the pre-extraction row.
  const ownerId = touched[0]?.agent_id
  if (ownerId != null) invalidateStats(ownerId)
}

export async function logActivity(agentId, leadId, kind, text) {
  await q('INSERT INTO activity (agent_id, lead_id, kind, text) VALUES ($1, $2, $3, $4)', [
    agentId,
    leadId,
    kind,
    text,
  ])
}

// How many rows one page of a polled list returns when the caller doesn't say, and the
// most it will return however loudly the caller asks. The lead list row is wide (every
// lead column plus the last message, the unread count and the labels), so an agent
// with 10k leads used to be served a ~12MB JSON body on a phone, every 4 seconds, from
// two screens at once. 100 fills the longest screen twice over; 500 is the ceiling for
// the rare caller that genuinely wants a big page.
export const PAGE_DEFAULT = 100
export const PAGE_MAX = 500

// Clamp a caller-supplied page size to [1, PAGE_MAX]. Anything that isn't a positive
// number — absent, '', 'all', NaN, 0, negative — falls back to the default rather than
// erroring, so an old client that never learned about paging keeps working and simply
// gets the first page.
export function pageLimit(raw, fallback = PAGE_DEFAULT) {
  const n = Math.floor(Number(raw))
  // Infinity is deliberately not a fallback case: `?limit=Infinity` is a caller asking
  // for as much as it can get, and the answer to that is the cap, not the default.
  if (Number.isNaN(n) || n < 1) return fallback
  return Math.min(n, PAGE_MAX)
}

// Same idea for the offset: a missing or nonsensical value means "start at the top".
export function pageOffset(raw) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0
}

// The agent's own leads plus the shared unassigned pool. `unassigned` flags pool rows;
// `contact_name` is the client name from the agent's contacts, when the sender is known.
//
// Paged by default (see PAGE_DEFAULT). `search` matches the lead name, the phone
// number, or the agent's own contact name for that number — server-side, because a
// client filtering a page it was handed can only ever search the first page.
export async function listLeads(
  agentId,
  { pipelineType = '', stage = '', search = '', limit, offset } = {},
) {
  const where = ['(l.agent_id = $1 OR l.agent_id IS NULL)']
  const params = [agentId]
  // Pipeline filters only apply to the agent's own leads; a lead that predates the CRM
  // columns counts as buy_primary/New (the defaults attachLeadContact would give it).
  if (pipelineType) {
    params.push(pipelineType)
    where.push(`COALESCE(l.pipeline_type, 'buy_primary') = $${params.length}`)
  }
  if (stage) {
    params.push(stage)
    where.push(`COALESCE(l.stage, 'New') = $${params.length}`)
  }
  const term = String(search ?? '').trim()
  if (term) {
    // ILIKE with both wildcards escaped so a buyer literally named "100%" can be found
    // instead of matching everyone.
    params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    const like = `$${params.length}`
    where.push(`(l.name ILIKE ${like} OR l.wa_id ILIKE ${like}
       OR EXISTS (SELECT 1 FROM contacts c
                   WHERE c.agent_id = $1 AND replace(c.phone, '+', '') = l.wa_id
                     AND c.name ILIKE ${like}))`)
  }
  params.push(pageLimit(limit))
  const limitParam = `$${params.length}`
  params.push(pageOffset(offset))
  const offsetParam = `$${params.length}`
  const { rows } = await q(
    `SELECT l.*,
       (l.agent_id IS NULL)::int AS unassigned,
       (SELECT c.name FROM contacts c
          WHERE c.agent_id = $1 AND replace(c.phone, '+', '') = l.wa_id LIMIT 1) AS contact_name,
       -- One lateral lookup for the last message, not three correlated subqueries
       -- fetching three columns of the same row. This is the list the inbox and the
       -- pipeline board both poll every few seconds, so it ran 3 index scans per
       -- lead where 1 does.
       last.text AS last_msg,
       last.role AS last_role,
       last.created_at AS last_at,
       -- Unread = buyer messages newer than the last time the agent opened the thread.
       (SELECT count(*) FROM messages m
          WHERE m.lead_id = l.id AND m.role = 'buyer'
            AND (l.last_read_at IS NULL OR m.created_at > l.last_read_at))::int AS unread_count,
       COALESCE(l.assigned_agent_id, l.agent_id) AS handling_agent_id,
       COALESCE(
         (SELECT json_agg(json_build_object('id', lb.id, 'name', lb.name, 'color', lb.color) ORDER BY lb.sort, lb.id)
            FROM lead_labels ll JOIN labels lb ON lb.id = ll.label_id
            WHERE ll.lead_id = l.id),
         '[]'::json) AS labels
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT m.text, m.role, m.created_at FROM messages m
        WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1
     ) last ON true
     WHERE ${where.join(' AND ')}
     -- id breaks the tie: updated_at alone is not unique (a batch rescore stamps a
     -- whole set of leads in the same transaction), and a non-deterministic sort makes
     -- OFFSET paging drop and duplicate rows across pages.
     ORDER BY l.updated_at DESC, l.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  )
  return rows
}

// Every count the Leads screen needs, in one grouped pass over the agent's leads —
// the pipeline chips, the per-stage column headers, and the unassigned-pool badge.
// This exists so the board can show "247 in Qualified" without the client first
// downloading 247 lead rows to call .length on them.
//
// Shape: { total, unassigned, by_pipeline: { <type>: n }, by_stage: { <type>: { <stage>: n } } }
// A lead that predates the CRM columns counts as buy_primary/New, matching listLeads.
export async function leadCounts(agentId) {
  const { rows } = await q(
    `SELECT COALESCE(l.pipeline_type, 'buy_primary') AS pipeline_type,
            COALESCE(l.stage, 'New') AS stage,
            (l.agent_id IS NULL) AS unassigned,
            COUNT(*)::int AS n
       FROM leads l
      WHERE (l.agent_id = $1 OR l.agent_id IS NULL)
      GROUP BY 1, 2, 3`,
    [agentId],
  )
  const counts = { total: 0, unassigned: 0, by_pipeline: {}, by_stage: {} }
  for (const r of rows) {
    counts.total += r.n
    if (r.unassigned) counts.unassigned += r.n
    counts.by_pipeline[r.pipeline_type] = (counts.by_pipeline[r.pipeline_type] || 0) + r.n
    const stages = (counts.by_stage[r.pipeline_type] ||= {})
    stages[r.stage] = (stages[r.stage] || 0) + r.n
  }
  return counts
}

export async function listActivity(agentId, limit = 30) {
  return (
    await q('SELECT * FROM activity WHERE agent_id = $1 ORDER BY id DESC LIMIT $2', [agentId, limit])
  ).rows
}

export async function setAiEnabled(leadId, enabled) {
  await q('UPDATE leads SET ai_enabled = $1 WHERE id = $2', [enabled ? 1 : 0, leadId])
}

export async function listNetworkPosts() {
  return (await q('SELECT * FROM network_posts ORDER BY id DESC LIMIT 50')).rows
}

export async function addNetworkPost(p) {
  const { rows } = await q(
    `INSERT INTO network_posts (type, broker, firm, text, config, locality, budget_min_l, budget_max_l)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [p.type, p.broker, p.firm ?? null, p.text, p.config ?? null, p.locality ?? null, p.budget_min_l ?? null, p.budget_max_l ?? null],
  )
  return rows[0]
}

// Real matching: your qualified buyers x posted inventory, on locality + config + budget overlap.
export async function computeMatches(agentId) {
  const leads = (
    await q(`SELECT * FROM leads WHERE agent_id = $1 AND locality IS NOT NULL AND temp != 'Cold'`, [agentId])
  ).rows
  const inventory = (await q(`SELECT * FROM network_posts WHERE type = 'INVENTORY'`)).rows
  const matches = []
  for (const lead of leads) {
    for (const inv of inventory) {
      let pct = 0
      if (
        inv.locality &&
        lead.locality &&
        (inv.locality.toLowerCase().includes(lead.locality.toLowerCase()) ||
          lead.locality.toLowerCase().includes(inv.locality.toLowerCase()))
      )
        pct += 45
      if (
        inv.config &&
        lead.config &&
        inv.config.replace(/\s/g, '').toLowerCase() === lead.config.replace(/\s/g, '').toLowerCase()
      )
        pct += 30
      const budgetsKnown =
        inv.budget_min_l != null && inv.budget_max_l != null &&
        lead.budget_min_l != null && lead.budget_max_l != null
      if (budgetsKnown && inv.budget_min_l <= lead.budget_max_l && inv.budget_max_l >= lead.budget_min_l)
        pct += 25
      if (pct >= 70) matches.push({ lead, inventory: inv, matchPct: pct })
    }
  }
  return matches.sort((a, b) => b.matchPct - a.matchPct)
}

// --- Admin / WABA management ---

// List all agents with their WABA status (for admin panel).
export async function listAllAgents() {
  return (
    await q(
      `SELECT id, name, phone, email, wa_phone_number, wa_phone_number_id,
              waba_status, waba_registered_at, meta_waba_id, is_admin, created_at
       FROM agents ORDER BY created_at DESC`,
    )
  ).rows
}

// Auto-promote the first agent to admin if no admin can log in (lazy, on first
// admin-route hit). "Can log in" means active: an install whose only admin was
// deactivated would otherwise have no way back into the admin screens.
export async function ensureAdminExists() {
  const hasAdmin = (await q('SELECT 1 FROM agents WHERE is_admin = 1 AND is_active = 1 LIMIT 1')).rows[0]
  if (!hasAdmin) {
    const first = (await q('SELECT id FROM agents WHERE is_active = 1 ORDER BY id LIMIT 1')).rows[0]
    if (first) {
      await q('UPDATE agents SET is_admin = 1 WHERE id = $1', [first.id])
      console.log(`Auto-promoted agent #${first.id} to admin (first active agent)`)
    }
  }
}

// Update an agent's WABA registration status (admin action).
// status must be one of: none, pending, registered, active.
export async function updateWabaStatus(agentId, { status, metaWabaId, waPhoneNumberId, waPhoneNumber }) {
  const valid = ['none', 'pending', 'registered', 'active']
  if (!valid.includes(status)) throw new Error(`Invalid WABA status: ${status}`)

  const agent = await getAgent(agentId)
  if (!agent) throw new Error('Agent not found')

  const updates = ['waba_status = $1']
  const params = [status]

  // Set registered_at when transitioning to 'registered' or 'active'
  if ((status === 'registered' || status === 'active') && !agent.waba_registered_at) {
    updates.push('waba_registered_at = now()')
  }
  // Clear registered_at when going back to 'none' or 'pending'
  if (status === 'none' || status === 'pending') {
    updates.push('waba_registered_at = NULL')
  }

  if (metaWabaId !== undefined) {
    params.push(metaWabaId || null)
    updates.push(`meta_waba_id = $${params.length}`)
  }
  if (waPhoneNumberId !== undefined) {
    params.push(waPhoneNumberId || null)
    updates.push(`wa_phone_number_id = $${params.length}`)
  }
  if (waPhoneNumber !== undefined) {
    params.push(waPhoneNumber ? normalizePhone(waPhoneNumber) : null)
    updates.push(`wa_phone_number = $${params.length}`)
  }

  params.push(agentId)
  await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
  return getAgent(agentId)
}

// Admin dashboard stats.
export async function adminStats() {
  const one = async (sql) => Object.values((await q(sql)).rows[0])[0]
  return {
totalAgents: await one('SELECT COUNT(*) FROM agents'),
    newAgents7d: await one(`SELECT COUNT(*) FROM agents WHERE created_at >= now() - interval '7 days'`),
    newAgents30d: await one(`SELECT COUNT(*) FROM agents WHERE created_at >= now() - interval '30 days'`),
    noneWaba: await one(`SELECT COUNT(*) FROM agents WHERE waba_status = 'none'`),
    pendingWaba: await one(`SELECT COUNT(*) FROM agents WHERE waba_status = 'pending'`),
    registeredWaba: await one(`SELECT COUNT(*) FROM agents WHERE waba_status = 'registered'`),
    activeWaba: await one(`SELECT COUNT(*) FROM agents WHERE waba_status = 'active'`),
    totalLeads: await one('SELECT COUNT(*) FROM leads'),
    totalContacts: await one('SELECT COUNT(*) FROM contacts'),
    // A conversation is "active" when the lead exchanged at least one message in the last 24h.
    activeConversations: await one(
      `SELECT COUNT(DISTINCT lead_id) FROM messages WHERE created_at >= now() - interval '1 day'`,
    ),
  }
}

// Paginated, searchable agent listing for the admin site.
// search matches name/email/phone (substring); status filters on waba_status.
export async function listAgentsAdmin({ search = '', status = '', active = '', page = 1, pageSize = 20 } = {}) {
  const where = []
  const params = []
  if (search) {
    params.push(`%${search}%`)
    const n = params.length
    where.push(`(a.name ILIKE $${n} OR a.email ILIKE $${n} OR a.phone ILIKE $${n} OR a.wa_phone_number ILIKE $${n})`)
  }
  if (status) {
    params.push(status)
    where.push(`a.waba_status = $${params.length}`)
  }
  if (active === '1' || active === '0' || active === 0 || active === 1) {
    params.push(Number(active))
    where.push(`a.is_active = $${params.length}`)
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = (await q(`SELECT COUNT(*) AS n FROM agents a ${whereSql}`, params)).rows[0].n
  const size = Math.min(Math.max(1, Number(pageSize) || 20), 100)
  const p = Math.max(1, Number(page) || 1)
  const { rows: agents } = await q(
    `SELECT a.id, a.name, a.phone, a.email, a.business_name, a.city, a.avatar_url,
            a.is_active, a.deactivated_at,
            a.wa_phone_number, a.wa_phone_number_id,
            a.waba_status, a.waba_registered_at, a.meta_waba_id, a.is_admin, a.created_at,
            (SELECT MAX(created_at) FROM activity WHERE agent_id = a.id) AS last_active,
            (SELECT COUNT(*) FROM leads l WHERE l.agent_id = a.id) AS lead_count
     FROM agents a ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, (p - 1) * size],
  )
  return { agents, total, page: p, pageSize: size, totalPages: Math.max(1, Math.ceil(total / size)) }
}

// Full agent profile for the admin detail view: counts + recent activity.
export async function getAgentDetail(id) {
  const agent = await getAgent(id)
  if (!agent) return null
  const one = async (sql, ...args) => Object.values((await q(sql, args)).rows[0])[0]
  return {
    ...agent,
    lead_count: await one('SELECT COUNT(*) FROM leads WHERE agent_id = $1', id),
    contact_count: await one('SELECT COUNT(*) FROM contacts WHERE agent_id = $1', id),
    message_count: await one(
      'SELECT COUNT(*) FROM messages WHERE lead_id IN (SELECT id FROM leads WHERE agent_id = $1)',
      id,
    ),
    last_active: await one('SELECT MAX(created_at) FROM activity WHERE agent_id = $1', id),
    recent_activity: (
      await q('SELECT * FROM activity WHERE agent_id = $1 ORDER BY id DESC LIMIT 15', [id])
    ).rows,
  }
}

// Admin edit of an agent's profile. Only provided fields are changed.
//
// Deliberately cannot touch is_admin. Granting and revoking admin is setAgentAdmin's
// job, because that is where the two invariants live: nobody may demote themselves,
// and the last active admin may never be demoted — either one locks the install out
// of its own admin screens with no way back in. This function used to accept an
// is_admin field and write it with a bare UPDATE, past both guards. Nothing ever
// passed it (PUT /api/admin/agents/:id splits the field off to setAgentAdmin for
// exactly this reason), so it was a trap rather than a bug: the next caller to pass
// the field the signature advertised would have silently bypassed both.
export async function updateAgentProfile(agentId, { name, email, phone } = {}) {
  const agent = await getAgent(agentId)
  if (!agent) {
    const err = new Error('Agent not found')
    err.code = 'NOT_FOUND'
    throw err
  }
  const updates = []
  const params = []
  if (name !== undefined) {
    const n = String(name || '').trim()
    if (!n) throw new Error('Name cannot be empty')
    params.push(n)
    updates.push(`name = $${params.length}`)
  }
  if (email !== undefined) {
    const e = String(email || '').trim().toLowerCase() || null
    if (e && !/^\S+@\S+\.\S+$/.test(e)) throw new Error('Enter a valid email address')
    if (e) {
      const clash = (await q('SELECT id FROM agents WHERE lower(email) = $1 AND id != $2', [e, agentId])).rows[0]
      if (clash) {
        const err = new Error('Another agent already uses this email')
        err.code = 'EMAIL_TAKEN'
        throw err
      }
    }
    params.push(e)
    updates.push(`email = $${params.length}`)
  }
  if (phone !== undefined) {
    const pn = normalizePhone(phone)
    if (pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid phone number')
    const clash = (await q('SELECT id FROM agents WHERE phone = $1 AND id != $2', [pn, agentId])).rows[0]
    if (clash) {
      const err = new Error('Another agent already uses this phone number')
      err.code = 'PHONE_TAKEN'
      throw err
    }
    params.push(pn)
    updates.push(`phone = $${params.length}`)
  }
  if (!updates.length) return agent
  params.push(agentId)
  try {
    await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
  } catch (e) {
    // The clash checks above are a read, so two edits can still race into the
    // constraint. Report it as the same conflict rather than a 500.
    if (e.code !== '23505') throw e
    const err = new Error(
      e.constraint === 'idx_agents_email_unique'
        ? 'Another agent already uses this email'
        : 'Another agent already uses this phone number',
    )
    err.code = e.constraint === 'idx_agents_email_unique' ? 'EMAIL_TAKEN' : 'PHONE_TAKEN'
    throw err
  }
  return getAgent(agentId)
}

// Self-service change of an agent's own login number. Stricter than updateAgentProfile:
// the personal number is the login identity, so it must be a real Indian mobile and
// cannot collide with another agent or with this agent's own WA Business line.
export async function updateAgentPhone(agentId, rawPhone) {
  const phone = normalizeIndianMobile(rawPhone)
  if (!phone) {
    const err = new Error('Enter a valid Indian mobile number, e.g. +91 98765 43210')
    err.code = 'INVALID_PHONE'
    throw err
  }
  const agent = await getAgent(agentId)
  if (!agent) {
    const err = new Error('Agent not found')
    err.code = 'NOT_FOUND'
    throw err
  }
  if (agent.phone === phone) return agent // no-op, stay idempotent
  // The login number and the WhatsApp Business number are allowed to be the same, so
  // there is no clash check against wa_phone_number here.
  const clash = (await q('SELECT id FROM agents WHERE phone = $1 AND id != $2', [phone, agentId])).rows[0]
  if (clash) {
    const err = new Error('Another agent already uses this WhatsApp number')
    err.code = 'PHONE_TAKEN'
    throw err
  }
  try {
    await q('UPDATE agents SET phone = $1 WHERE id = $2', [phone, agentId])
  } catch (err) {
    // Lost a race with a concurrent signup/change against the UNIQUE index on agents.phone.
    if (err.code === '23505') {
      const taken = new Error('Another agent already uses this WhatsApp number')
      taken.code = 'PHONE_TAKEN'
      throw taken
    }
    throw err
  }
  return getAgent(agentId)
}

// Make an agent an admin (or revoke). Unguarded — for tests and bootstrapping.
// Admin-facing changes go through setAgentAdmin(), which keeps one admin alive.
export async function setAdmin(agentId, isAdmin) {
  await q('UPDATE agents SET is_admin = $1 WHERE id = $2', [isAdmin ? 1 : 0, agentId])
  return getAgent(agentId)
}

// --- Agent self-service profile, preferences and password ---

const fail = (message, code = 'INVALID') => {
  const err = new Error(message)
  err.code = code
  throw err
}

// Languages HomeNex ships UI copy and AI prompts for.
export const LANGUAGES = ['en', 'hi', 'mr', 'ta', 'te', 'kn', 'gu', 'bn', 'pa', 'ml', 'or']

// A timezone is valid if the ICU database the runtime ships knows it.
export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// A profile photo is either an https URL or an inline data: image the browser
// produced by downscaling the file the agent picked. The cap keeps a base64
// payload roughly under 220 KB of source image, which is ample for a 256px avatar.
const AVATAR_MAX_CHARS = 300_000
export function normalizeAvatar(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (v.length > AVATAR_MAX_CHARS) fail('Profile photo is too large — pick an image under 200 KB')
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v
  if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return v
  fail('Profile photo must be an https URL or an uploaded PNG, JPEG or WebP image')
}

// Free-text profile fields: trimmed, length-capped, and stored as NULL when blank.
const PROFILE_TEXT = {
  business_name: { max: 120, label: 'Business name' },
  city: { max: 80, label: 'City' },
  bio: { max: 500, label: 'About you' },
  rera_id: { max: 64, label: 'RERA registration ID' },
  rera_state: { max: 64, label: 'RERA state' },
}

// RERA registration expiry, an ISO date (YYYY-MM-DD). Stored NULL when blank.
export function normalizeReraExpiry(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('RERA expiry must be a date (YYYY-MM-DD)')
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    fail('RERA expiry is not a valid date')
  }
  return v
}

// The agent edits their own profile. The phone number is deliberately absent —
// it is the login identity and changes through updateAgentPhone() with a password.
export async function updateAgentProfileSelf(agentId, fields = {}) {
  const agent = await getAgent(agentId)
  if (!agent) fail('Agent not found', 'NOT_FOUND')

  const updates = []
  const params = []
  const set = (col, value) => {
    params.push(value)
    updates.push(`${col} = $${params.length}`)
  }

  if (fields.name !== undefined) {
    const name = String(fields.name ?? '').trim()
    if (!name) fail('Name cannot be empty')
    if (name.length > 80) fail('Name is too long (max 80 characters)')
    set('name', name)
  }

  if (fields.email !== undefined) {
    const email = String(fields.email ?? '').trim().toLowerCase() || null
    if (email && !/^\S+@\S+\.\S+$/.test(email)) fail('Enter a valid email address')
    if (email) {
      const clash = (await q('SELECT id FROM agents WHERE lower(email) = $1 AND id != $2', [email, agentId])).rows[0]
      if (clash) fail('Another agent already uses this email', 'EMAIL_TAKEN')
    }
    set('email', email)
  }

  for (const [col, { max, label }] of Object.entries(PROFILE_TEXT)) {
    if (fields[col] === undefined) continue
    const value = String(fields[col] ?? '').trim() || null
    if (value && value.length > max) fail(`${label} is too long (max ${max} characters)`)
    set(col, value)
  }

  if (fields.avatar_url !== undefined) set('avatar_url', normalizeAvatar(fields.avatar_url))

  if (fields.rera_expiry !== undefined) set('rera_expiry', normalizeReraExpiry(fields.rera_expiry))

  if (!updates.length) return agent
  params.push(agentId)
  try {
    await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
  } catch (e) {
    // The clash check above is a read; two profile saves can still race into the
    // unique index. Same conflict, not a 500.
    if (e.code !== '23505') throw e
    fail('Another agent already uses this email', 'EMAIL_TAKEN')
  }
  return getAgent(agentId)
}

const NOTIFY_FLAGS = ['notify_new_lead', 'notify_followup_due', 'notify_daily_digest']

// Locale and notification preferences. Quiet hours are a pair: both ends move
// together, so a caller that sends only one end is merged against what is stored.
export async function updateAgentPreferences(agentId, fields = {}) {
  const agent = await getAgent(agentId)
  if (!agent) fail('Agent not found', 'NOT_FOUND')

  const updates = []
  const params = []
  const set = (col, value) => {
    params.push(value)
    updates.push(`${col} = $${params.length}`)
  }

  if (fields.timezone !== undefined) {
    const tz = String(fields.timezone ?? '').trim()
    if (!tz || !isValidTimezone(tz)) fail('Unknown timezone')
    set('timezone', tz)
  }

  if (fields.language !== undefined) {
    const lang = String(fields.language ?? '').trim().toLowerCase()
    if (!LANGUAGES.includes(lang)) fail(`Unsupported language: ${fields.language}`)
    set('language', lang)
  }

  for (const flag of NOTIFY_FLAGS) {
    if (fields[flag] === undefined) continue
    set(flag, fields[flag] ? 1 : 0)
  }

  if (fields.quiet_hours_start !== undefined || fields.quiet_hours_end !== undefined) {
    const hour = (value, label) => {
      if (value === null || value === undefined || value === '') return null
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 23) fail(`${label} must be a whole hour between 0 and 23`)
      return n
    }
    const start = fields.quiet_hours_start !== undefined
      ? hour(fields.quiet_hours_start, 'Quiet hours start')
      : agent.quiet_hours_start
    const end = fields.quiet_hours_end !== undefined
      ? hour(fields.quiet_hours_end, 'Quiet hours end')
      : agent.quiet_hours_end

    if ((start === null) !== (end === null)) fail('Set both a start and an end for quiet hours')
    if (start !== null && start === end) fail('Quiet hours cannot start and end at the same hour')
    set('quiet_hours_start', start)
    set('quiet_hours_end', end)
  }

  if (!updates.length) return agent
  params.push(agentId)
  await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
  return getAgent(agentId)
}

// The password and the token version move together, in one statement: a change that
// set the new password but left the old sessions signed would be the exact window an
// agent changing their password is trying to close.
export async function updateAgentPassword(agentId, passwordHash) {
  const { rowCount } = await q(
    'UPDATE agents SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [passwordHash, agentId],
  )
  if (!rowCount) fail('Agent not found', 'NOT_FOUND')
  return getAgent(agentId)
}

// --- Admin: team management ---

// Admins who can still log in. Guards below use this to keep at least one.
export async function countActiveAdmins() {
  return (await q('SELECT COUNT(*) AS n FROM agents WHERE is_admin = 1 AND is_active = 1')).rows[0].n
}

// Grant or revoke admin. An admin cannot revoke their own access (ask another
// admin) and the last remaining admin can never be revoked — either would leave
// the install with no way back into the admin screens.
export async function setAgentAdmin(actorId, targetId, isAdmin) {
  const target = await getAgent(targetId)
  if (!target) fail('Agent not found', 'NOT_FOUND')
  const next = isAdmin ? 1 : 0
  if (target.is_admin === next) return target
  if (!next) {
    if (Number(actorId) === Number(targetId))
      fail('You cannot remove your own admin access — ask another admin to do it', 'SELF_DEMOTE')
    // Only an *active* admin counts toward the invariant, so demoting an already
    // deactivated admin is always safe.
    if (target.is_active === 1 && (await countActiveAdmins()) <= 1)
      fail('At least one admin must remain', 'LAST_ADMIN')
  }
  if (next && target.is_active === 0)
    fail('Reactivate this agent before making them an admin', 'AGENT_INACTIVE')
  await q('UPDATE agents SET is_admin = $1 WHERE id = $2', [next, targetId])
  return getAgent(targetId)
}

// Suspend or restore an agent. Deactivation revokes their sessions (verifyToken
// rejects them) and blocks login, but keeps every lead, contact and message.
export async function setAgentActive(actorId, targetId, isActive) {
  const target = await getAgent(targetId)
  if (!target) fail('Agent not found', 'NOT_FOUND')
  const next = isActive ? 1 : 0
  if (target.is_active === next) return target
  if (!next) {
    if (Number(actorId) === Number(targetId))
      fail('You cannot deactivate your own account', 'SELF_DEACTIVATE')
    if (target.is_admin === 1 && (await countActiveAdmins()) <= 1)
      fail('At least one active admin must remain', 'LAST_ADMIN')
  }
  await q(
    `UPDATE agents SET is_active = $1, deactivated_at = ${next ? 'NULL' : 'now()'} WHERE id = $2`,
    [next, targetId],
  )
  return getAgent(targetId)
}

// Platform-wide audit trail for the admin screens (per-agent view is listAuditLogs).
export async function listAllAuditLogs(limit = 100) {
  const size = Math.min(Math.max(1, Number(limit) || 100), 500)
  return (
    await q(
      `SELECT al.*, a.name AS agent_name
       FROM audit_logs al LEFT JOIN agents a ON a.id = al.agent_id
       ORDER BY al.id DESC LIMIT $1`,
      [size],
    )
  ).rows
}

// Day boundaries ("new today", "due today") follow the agent's own timezone
// preference, defaulting to Asia/Kolkata — HomeNex targets Indian agents.
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata'

export async function agentTimezone(agentId) {
  const tz = (await q('SELECT timezone FROM agents WHERE id = $1', [agentId])).rows[0]?.timezone
  return tz && isValidTimezone(tz) ? tz : TZ
}

// --- Dashboard stats cache -------------------------------------------------
// /api/stats is the most-polled read in the app: the Home dashboard asks every 10s
// and the Insights screen every 8s. The numbers behind it are counters over the
// agent's whole history, so re-deriving them on every poll is pure waste — an agent
// leaving the dashboard open all day issues the same eleven aggregates ~5,000 times.
//
// The TTL is read per call, not at import, so a test can turn it on and off. It
// defaults off under NODE_ENV=test: a suite that writes a lead and immediately reads
// the counters should see the write, not a 1ms-old cache entry.
const statsCache = new Map() // agentId -> { at, value }

// The TTL has to be comfortably LONGER than the fastest poll that reads it, or the
// cache cannot hit at all: at 8000ms against Insights' 8000ms poll (InsightsTab.jsx)
// every request arrived just as its own entry expired, so /api/stats recomputed all
// four aggregates on every single poll and the cache was pure overhead. 30s serves
// three of every four Insights polls and two of every three dashboard polls (10s).
//
// Staleness is bounded by invalidateStats() on the write paths, not by this number.
function statsCacheMs() {
  const raw = process.env.STATS_CACHE_MS
  if (raw != null && raw !== '') return Math.max(0, Number(raw) || 0)
  return process.env.NODE_ENV === 'test' ? 0 : 30_000
}

// Drop an agent's cached counters. Called from the write paths an agent watches for
// a reaction — a new lead, a new message — so those land immediately instead of
// waiting out the TTL. Anything not hooked here is simply stale for a few seconds,
// which is the same staleness the poll interval already imposes.
export function invalidateStats(agentId) {
  statsCache.delete(Number(agentId))
}

// Exposed for tests and for a clean shutdown; nothing in the app needs it.
export function clearStatsCache() {
  statsCache.clear()
}

export async function stats(agentId) {
  const ttl = statsCacheMs()
  const key = Number(agentId)
  if (ttl > 0) {
    const hit = statsCache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.value
  }
  const value = await computeStats(agentId)
  if (ttl > 0) {
    // One entry per agent is small, but nothing ever removes them, so sweep the
    // expired ones once the map is bigger than any real brokerage.
    if (statsCache.size > 500) {
      const cutoff = Date.now() - ttl
      for (const [id, entry] of statsCache) if (entry.at < cutoff) statsCache.delete(id)
    }
    statsCache.set(key, { at: Date.now(), value })
  }
  return value
}

async function computeStats(agentId) {
  const TZ = await agentTimezone(agentId)
  // Seven of these used to be seven separate `SELECT COUNT(*) FROM leads WHERE
  // agent_id = $1 AND ...` — seven scans of the same rows, in seven round-trips, to
  // answer one screen. FILTER folds them into a single pass.
  //
  // The day boundary is expressed in the agent's own timezone, so "new today" means
  // their today (see agentTimezone).
  const dayStart = `date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`
  const [leadAgg, msgAgg, sourcesRes, dailyRes] = await Promise.all([
    q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= ${dayStart})::int AS new_today,
              -- Decayed/rule-hybrid temperature, not the AI's one-time categorical
              -- guess: a lead scored Hot at extraction time but silent for a week
              -- must not still count as "hot now" (scoring.js decay + hybridScore).
              COUNT(*) FILTER (WHERE COALESCE(effective_temp, temp) = 'Hot')::int AS hot_now,
              COALESCE(SUM((budget_min_l + budget_max_l) / 2.0)
                       FILTER (WHERE temp != 'Cold' AND budget_max_l IS NOT NULL), 0) AS pipeline_l,
              AVG(first_response_s) AS avg_first_response_s,
              COUNT(*) FILTER (WHERE locality IS NOT NULL AND timeline IS NOT NULL
                                 AND config IS NOT NULL AND budget_max_l IS NOT NULL)::int AS qualified,
              COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE $2) >= 21
                                  OR EXTRACT(HOUR FROM created_at AT TIME ZONE $2) < 9)::int AS after_hours
         FROM leads WHERE agent_id = $1`,
      [agentId, TZ],
    ),
    // Both message counters look back at most one day, and the agent's local day
    // start is never more than 24h ago — so this one bounded scan covers both, and
    // the whole message history stays untouched.
    q(
      `SELECT COUNT(DISTINCT lead_id)::int AS active_24h,
              COUNT(*) FILTER (WHERE created_at >= ${dayStart})::int AS msgs_today
         FROM messages
        WHERE lead_id IN (SELECT id FROM leads WHERE agent_id = $1)
          AND created_at >= now() - interval '1 day'`,
      [agentId, TZ],
    ),
    q(
      'SELECT source AS name, COUNT(*) AS count FROM leads WHERE agent_id = $1 GROUP BY source ORDER BY count DESC',
      [agentId],
    ),
    q(
      `SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
              AVG(first_response_s) AS avg_s, COUNT(*) AS leads
       FROM leads WHERE agent_id = $1 AND created_at >= now() - interval '7 days'
       GROUP BY day ORDER BY day`,
      [agentId, TZ],
    ),
  ])
  const lead = leadAgg.rows[0]
  const msg = msgAgg.rows[0]
  const pipelineL = lead.pipeline_l || 0
  return {
    total: lead.total,
    newToday: lead.new_today,
    hotNow: lead.hot_now,
    active24h: msg.active_24h,
    pipelineCr: pipelineL / 100,
    avgFirstResponseS: lead.avg_first_response_s,
    qualifiedPct: lead.total ? Math.round((lead.qualified / lead.total) * 100) : 0,
    afterHours: lead.after_hours,
    sources: sourcesRes.rows,
    daily: dailyRes.rows,
    msgsToday: msg.msgs_today,
  }
}

// --- CRM: lead pipeline fields ---

const LEAD_CRM_FIELDS = {
  contact_id: 'int',
  pipeline_type: 'text',
  stage: 'text',
  budget_min: 'bigint',
  budget_max: 'bigint',
  bhk: 'text',
  property_type: 'text',
  preferred_localities: 'jsonb',
  timeline: 'text',
  financing: 'text',
  ai_score: 'text',
  ai_score_reason: 'text',
  lost_reason: 'text',
  notes: 'text',
  closed_at: 'timestamptz',
}

// Rename a lead (e.g. replace a bare phone number with the buyer's real name).
export async function updateLeadName(leadId, name) {
  await q('UPDATE leads SET name = $2, updated_at = now() WHERE id = $1', [leadId, name])
}

// Update the CRM/pipeline fields of a lead the agent owns.
export async function updateLeadCrm(leadId, agentId, fields) {
  const { sets, params } = buildSet(LEAD_CRM_FIELDS, fields)
  if (!sets.length) return getLeadForAgent(leadId, agentId)
  const { rows } = await q(
    `UPDATE leads SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, leadId, agentId],
  )
  return rows[0]
}

// Fields the agent may accept from an AI auto-fill suggestion. Kept deliberately
// tight: only lead-qualification data, never pipeline/stage/ownership columns.
const AUTOFILL_APPLY_FIELDS = new Set([
  'name', 'intent', 'bhk', 'preferred_localities', 'budget_min', 'budget_max', 'timeline', 'financing',
])

// Apply an agent-accepted subset of AI auto-fill suggestions to a lead. `accepted`
// is a { field: value } map; only whitelisted fields are written, and `name`/`intent`
// (outside the generic CRM allowlist) are handled explicitly. Returns the updated lead
// or null if the lead isn't the agent's.
export async function applyAutofill(leadId, agentId, accepted = {}) {
  const lead = await getLeadForAgent(leadId, agentId)
  if (!lead) return null
  const entries = Object.entries(accepted).filter(([k, v]) => AUTOFILL_APPLY_FIELDS.has(k) && v != null)
  const crmFields = {}
  for (const [k, v] of entries) {
    if (k === 'name') await updateLeadName(leadId, String(v || '').trim() || null)
    else if (k === 'intent') await q('UPDATE leads SET intent = $2, updated_at = now() WHERE id = $1 AND agent_id = $3', [leadId, v, agentId])
    else crmFields[k] = v
  }
  if (Object.keys(crmFields).length) return updateLeadCrm(leadId, agentId, crmFields)
  return getLeadForAgent(leadId, agentId)
}

// Stages that end a lead's journey — moving into one stamps closed_at.
const TERMINAL_STAGES = new Set(['Registered/Closed', 'Closed', 'Lost'])

// Move a lead to another pipeline stage. Validates the stage against the lead's
// pipeline type (defaulting a pre-CRM lead to buy_primary) and requires a lost
// reason when moving to Lost. Returns the updated lead.
export async function setLeadStage(leadId, agentId, { stage, lost_reason } = {}) {
  const lead = await getLeadForAgent(leadId, agentId)
  if (!lead) return null
  const pipelineType = lead.pipeline_type || 'buy_primary'
  const stages = await listPipelineStages(pipelineType)
  if (!stages.some((s) => s.stage_name === stage)) {
    const err = new Error(`"${stage}" is not a stage of the ${pipelineType} pipeline`)
    err.code = 'BAD_STAGE'
    throw err
  }
  if (stage === 'Lost' && !(lost_reason && String(lost_reason).trim())) {
    const err = new Error('A lost reason is required when moving a lead to Lost')
    err.code = 'LOST_REASON_REQUIRED'
    throw err
  }
  // A lead's stage column is NULL until its first move; null reads as "New"
  // everywhere, so the first transition is recorded as leaving New (capturing the
  // time it sat there since creation).
  const fromStage = lead.stage || 'New'
  const { rows } = await q(
    `UPDATE leads SET
       pipeline_type = COALESCE(pipeline_type, $3),
       stage = $4,
       lost_reason = CASE WHEN $4 = 'Lost' THEN $5 ELSE NULL END,
       closed_at = CASE WHEN $6 THEN COALESCE(closed_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 AND agent_id = $2 RETURNING *`,
    [leadId, agentId, pipelineType, stage, lost_reason ? String(lost_reason).trim() : null, TERMINAL_STAGES.has(stage)],
  )
  // Append-only transition log (feeds pipeline analytics). Skip genuine no-ops so
  // re-saving the same stage doesn't manufacture zero-length dwell rows.
  if (rows[0] && fromStage !== stage) {
    await recordStageEvent(rows[0], fromStage)
    // Auto-labels follow the lifecycle: moving to Lost tags the thread Lost; booking
    // a visit tags it Site Visit Scheduled (also fired from createSiteVisit).
    if (stage === 'Lost') await applyAutoLabel(leadId, agentId, 'lost')
    if (stage === 'Site Visit Scheduled') await applyAutoLabel(leadId, agentId, 'site_visit_scheduled')
    // §5.4: reaching the booking stage captures a deal (idempotent). Best-effort —
    // a capture hiccup must never block the stage move itself.
    if (BOOKING_STAGES.has(stage)) {
      await captureDealForLead(rows[0]).catch((e) => console.error('deal capture failed', e.message))
    }
  }
  return rows[0]
}

// Log one stage transition, computing how long the lead sat in from_stage from the
// timestamp of its previous transition (falling back to the lead's creation time).
async function recordStageEvent(lead, fromStage) {
  // Dwell in from_stage = time since the lead's previous transition (or, for the
  // first move, since the lead was created).
  const { rows: dwellRows } = await q(
    `SELECT EXTRACT(EPOCH FROM (now() - COALESCE(
       (SELECT created_at FROM lead_stage_events WHERE lead_id = $1 ORDER BY id DESC LIMIT 1),
       (SELECT created_at FROM leads WHERE id = $1)
     )))::bigint AS secs`,
    [lead.id],
  )
  const secondsInFrom = dwellRows[0]?.secs ?? null
  await q(
    `INSERT INTO lead_stage_events
       (lead_id, agent_id, pipeline_type, from_stage, to_stage, lost_reason, seconds_in_from_stage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [lead.id, lead.agent_id, lead.pipeline_type || 'buy_primary', fromStage, lead.stage, lead.lost_reason ?? null, secondsInFrom],
  )
}

// --- CRM: pipeline stages ---

export async function listPipelineStages(pipelineType = null) {
  if (pipelineType) {
    return (
      await q('SELECT * FROM pipeline_stages WHERE pipeline_type = $1 ORDER BY stage_order', [pipelineType])
    ).rows
  }
  return (await q('SELECT * FROM pipeline_stages ORDER BY pipeline_type, stage_order')).rows
}

// --- CRM: pipeline analytics (funnel counts, avg time-in-stage, lost reasons) ---
//
// Built from lead_stage_events (transition history) plus the live stage distribution.
// Time-in-stage averages only completed dwells (a lead that has moved on); the
// current stage of a still-open lead has no end yet, so it isn't averaged.
export async function pipelineAnalytics(agentId, pipelineType = 'buy_primary') {
  const stages = await listPipelineStages(pipelineType)

  // Count leads per stage — the funnel snapshot. Terminal stages (Lost, Closed)
  // carry closed_at, so they're included here on purpose; the "open total" below
  // excludes them. Otherwise won/lost would always read zero.
  const dist = (
    await q(
      `SELECT COALESCE(stage, 'New') AS stage, COUNT(*)::int AS n
       FROM leads
       WHERE agent_id = $1 AND COALESCE(pipeline_type, 'buy_primary') = $2
       GROUP BY COALESCE(stage, 'New')`,
      [agentId, pipelineType],
    )
  ).rows
  const liveByStage = Object.fromEntries(dist.map((r) => [r.stage, r.n]))

  // Average completed dwell time per stage, in seconds.
  const dwell = (
    await q(
      `SELECT from_stage AS stage, ROUND(AVG(seconds_in_from_stage))::bigint AS avg_secs, COUNT(*)::int AS moves
       FROM lead_stage_events
       WHERE agent_id = $1 AND pipeline_type = $2 AND from_stage IS NOT NULL AND seconds_in_from_stage IS NOT NULL
       GROUP BY from_stage`,
      [agentId, pipelineType],
    )
  ).rows
  const dwellByStage = Object.fromEntries(dwell.map((r) => [r.stage, { avg_seconds: Number(r.avg_secs), moves: r.moves }]))

  // Lost-reason breakdown across all of this pipeline's leads.
  const lostReasons = (
    await q(
      `SELECT COALESCE(lost_reason, 'Unspecified') AS reason, COUNT(*)::int AS n
       FROM leads
       WHERE agent_id = $1 AND COALESCE(pipeline_type, 'buy_primary') = $2 AND stage = 'Lost'
       GROUP BY COALESCE(lost_reason, 'Unspecified') ORDER BY n DESC`,
      [agentId, pipelineType],
    )
  ).rows

  const funnel = stages.map((s) => ({
    stage: s.stage_name,
    order: s.stage_order,
    open: liveByStage[s.stage_name] || 0,
    avg_seconds_in_stage: dwellByStage[s.stage_name]?.avg_seconds ?? null,
    transitions_out: dwellByStage[s.stage_name]?.moves ?? 0,
  }))

  const terminal = new Set(['Registered/Closed', 'Closed', 'Lost'])
  const won = funnel
    .filter((f) => f.stage === 'Registered/Closed' || f.stage === 'Closed')
    .reduce((a, f) => a + f.open, 0)
  const lost = funnel.filter((f) => f.stage === 'Lost').reduce((a, f) => a + f.open, 0)
  const openTotal = funnel.filter((f) => !terminal.has(f.stage)).reduce((a, f) => a + f.open, 0)

  return { pipeline_type: pipelineType, funnel, lost_reasons: lostReasons, totals: { open: openTotal, won, lost } }
}

// Recent stage-transition history for one lead (timeline in the detail panel).
export async function leadStageHistory(leadId, agentId) {
  return (
    await q(
      `SELECT from_stage, to_stage, lost_reason, seconds_in_from_stage, created_at
       FROM lead_stage_events WHERE lead_id = $1 AND agent_id = $2 ORDER BY id`,
      [leadId, agentId],
    )
  ).rows
}

// --- Quick match: inventory that fits a lead's budget / BHK / locality ---
//
// Candidate fetch is SQL (available, agent-scoped); scoring, filtering and the
// explainable match_reasons are the pure/tested matching.js module — see there
// for the exact rules.
export async function propertyMatchesForLead(leadId, agentId) {
  const lead = await getLeadForAgent(leadId, agentId)
  if (!lead) return null
  const { rows: properties } = await q(
    `SELECT * FROM properties WHERE agent_id = $1 AND status = 'available'`,
    [agentId],
  )
  return rankPropertyMatches(lead, properties)
}

// --- CRM: properties (agent inventory) ---

const PROPERTY_FIELDS = {
  title: 'text',
  property_type: 'text',
  bhk: 'text',
  size_sqft: 'float',
  size_unit: 'text',
  price_paise: 'bigint',
  locality: 'text',
  city: 'text',
  status: 'text',
  rera_project_number: 'text',
  builder_name: 'text',
  owner_name: 'text',
  facing: 'text',
  floor: 'int',
  total_floors: 'int',
  amenities: 'jsonb',
  photos: 'jsonb',
  brochure_url: 'text',
  video_url: 'text',
  notes: 'text',
  micro_page_slug: 'text',
}

// URL slug for a property micro-page: slugified title + short random suffix.
function makePropertySlug(title) {
  const base = String(title || 'property')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'property'
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

export async function createProperty(agentId, p) {
  if (!p.title || !String(p.title).trim()) throw new Error('Property title is required')
  // Every property gets a shareable public micro-page slug from birth.
  if (!p.micro_page_slug) p = { ...p, micro_page_slug: makePropertySlug(p.title) }
  const cols = ['agent_id']
  const params = [agentId]
  for (const [col, kind] of Object.entries(PROPERTY_FIELDS)) {
    if (!(col in p) || p[col] === undefined) continue
    cols.push(col)
    params.push(kind === 'jsonb' && p[col] !== null ? JSON.stringify(p[col]) : p[col])
  }
  const placeholders = params.map((_, i) => `$${i + 1}`)
  const { rows } = await q(
    `INSERT INTO properties (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    params,
  )
  return rows[0]
}

// The WHERE that listProperties and propertyCount must agree on, so the count can never
// describe a different set of rows than the page it heads.
function propertyFilter(agentId, f) {
  const where = ['agent_id = $1']
  const params = [agentId]
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replace('?', `$${params.length}`))
  }
  if (f.status) add('status = ?', f.status)
  if (f.propertyType) add('property_type = ?', f.propertyType)
  if (f.bhk) add('bhk = ?', f.bhk)
  if (f.locality) add('locality ILIKE ?', `%${f.locality}%`)
  if (f.city) add('city ILIKE ?', `%${f.city}%`)
  if (f.minPrice != null) add('price_paise >= ?', f.minPrice)
  if (f.maxPrice != null) add('price_paise <= ?', f.maxPrice)
  if (f.search) {
    params.push(`%${f.search}%`)
    const n = `$${params.length}`
    where.push(`(title ILIKE ${n} OR locality ILIKE ${n} OR builder_name ILIKE ${n})`)
  }
  return { where, params }
}

// Inventory listing with the dashboard's filter set. Prices are paise.
//
// Paged by default (see PAGE_DEFAULT), and this is the widest row of the three lists
// that are: a property carries two JSONB arrays (amenities, photos) plus free-text
// notes, and `SELECT *` returns all of it. The Properties screen polls this every 8
// seconds and the dashboard polled it every 30 purely to call .length on the result, so
// an agent with a large inventory was downloading their whole catalogue, twice over,
// while looking at a screen that shows six cards.
//
// Callers that want the true total ask propertyCount() rather than measuring the array.
export async function listProperties(
  agentId,
  { status = '', propertyType = '', bhk = '', locality = '', city = '', minPrice = null, maxPrice = null, search = '', limit, offset } = {},
) {
  const { where, params } = propertyFilter(agentId, { status, propertyType, bhk, locality, city, minPrice, maxPrice, search })
  params.push(pageLimit(limit))
  const limitParam = `$${params.length}`
  params.push(pageOffset(offset))
  const offsetParam = `$${params.length}`
  const { rows } = await q(
    // id breaks the tie, for the same reason it does in listContacts: updated_at is not
    // unique — saving a property and its photos stamps several rows inside one
    // transaction — and a non-deterministic sort makes OFFSET paging drop and duplicate
    // rows across pages.
    `SELECT * FROM properties WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  )
  return rows
}

// How many properties match, without shipping any of them. This is what lets the
// Properties header say "1,204 in your inventory" while the list below holds one page,
// and what the dashboard asks instead of downloading the catalogue to measure it.
export async function propertyCount(agentId, filters = {}) {
  const { where, params } = propertyFilter(agentId, filters)
  const { rows } = await q(
    `SELECT COUNT(*)::int AS total FROM properties WHERE ${where.join(' AND ')}`,
    params,
  )
  return { total: rows[0].total }
}

export async function getProperty(id, agentId) {
  return (await q('SELECT * FROM properties WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
}

export async function updateProperty(id, agentId, fields) {
  const { sets, params } = buildSet(PROPERTY_FIELDS, fields)
  if (!sets.length) return getProperty(id, agentId)
  const { rows } = await q(
    `UPDATE properties SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0]
}

export async function deleteProperty(id, agentId) {
  await q('DELETE FROM property_page_views WHERE property_id IN (SELECT id FROM properties WHERE id = $1 AND agent_id = $2)', [id, agentId])
  const res = await q('DELETE FROM properties WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
}

// --- Property micro-pages (public, no auth) ---

// Public lookup by slug, joined with the owning agent's contact details for the CTA.
export async function getPropertyBySlug(slug) {
  const { rows } = await q(
    `SELECT p.*, a.name AS agent_name, a.wa_phone_number AS agent_wa_number, a.phone AS agent_phone
     FROM properties p JOIN agents a ON a.id = p.agent_id
     WHERE p.micro_page_slug = $1`,
    [slug],
  )
  return rows[0]
}

// Backfill a slug for a property created before micro-pages existed.
export async function ensurePropertySlug(id, agentId) {
  const property = await getProperty(id, agentId)
  if (!property) return null
  if (property.micro_page_slug) return property
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await q(
        'UPDATE properties SET micro_page_slug = $3, updated_at = now() WHERE id = $1 AND agent_id = $2 RETURNING *',
        [id, agentId, makePropertySlug(property.title)],
      )
      return rows[0]
    } catch (err) {
      if (err.code !== '23505') throw err // retry only on slug collision
    }
  }
  throw new Error('Could not generate a unique micro-page slug')
}

// Record one public page view — the engagement signal agents see on the property card.
//
// The row and the denormalised counter are written by ONE statement, so they can never
// disagree. As two statements they were two implicit transactions: a crash, a dropped
// connection or a statement timeout between them left properties.page_views permanently
// short of the rows in property_page_views, and nothing ever recomputes it. It also made
// a reader that had just seen the Nth view row able to read a counter still on N-1 —
// which is exactly what made the micro-page view test flaky. One round trip instead of
// two is a bonus on an endpoint every WhatsApp recipient hits.
//
// A data-modifying CTE is guaranteed to run exactly once and to completion whether or
// not the primary query reads its output, so the INSERT happens even though the UPDATE
// ignores it.
export async function recordPropertyView(propertyId, referrer = null, leadId = null) {
  await q(
    `WITH view AS (
       INSERT INTO property_page_views (property_id, referrer, lead_id) VALUES ($1, $2, $3)
     )
     UPDATE properties SET page_views = page_views + 1 WHERE id = $1`,
    [propertyId, referrer ? String(referrer).slice(0, 500) : null, leadId],
  )
}

export async function propertyViewStats(propertyId) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE viewed_at >= now() - interval '7 days')::int AS last_7d
     FROM property_page_views WHERE property_id = $1`,
    [propertyId],
  )
  return rows[0]
}

// --- Festive greeting schedules ---

export async function createFestiveSchedule(agentId, { festival_key, message, send_at }) {
  const { rows } = await q(
    `INSERT INTO festive_schedules (agent_id, festival_key, message, send_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [agentId, festival_key, message, send_at],
  )
  return rows[0]
}

export async function listFestiveSchedules(agentId) {
  return (
    await q('SELECT * FROM festive_schedules WHERE agent_id = $1 ORDER BY send_at DESC LIMIT 100', [agentId])
  ).rows
}

export async function cancelFestiveSchedule(id, agentId) {
  const { rows } = await q(
    `UPDATE festive_schedules SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND agent_id = $2 AND status = 'scheduled' RETURNING *`,
    [id, agentId],
  )
  return rows[0]
}

// Claim due schedules for delivery (status flips to 'sent' up front so two
// server instances can't double-send; sent_count is stamped after delivery).
export async function claimDueFestiveSchedules() {
  return (
    await q(
      `UPDATE festive_schedules SET status = 'sent', updated_at = now()
       WHERE status = 'scheduled' AND send_at <= now() RETURNING *`,
    )
  ).rows
}

export async function finishFestiveSchedule(id, { sentCount, failed = false }) {
  await q(
    `UPDATE festive_schedules SET sent_count = $2, status = $3, updated_at = now() WHERE id = $1`,
    [id, sentCount, failed ? 'failed' : 'sent'],
  )
}

// Recipients for a festive blast: the agent's contacts who haven't opted out.
export async function festiveRecipients(agentId) {
  return (
    await q(
      `SELECT * FROM contacts WHERE agent_id = $1 AND opt_in_status != 'opted_out' ORDER BY id`,
      [agentId],
    )
  ).rows
}

// --- CRM: site visits ---

export async function createSiteVisit(agentId, v) {
  if (!v.lead_id || !v.scheduled_at) throw new Error('lead_id and scheduled_at are required')
  await assertOwned('properties', v.property_id, agentId, 'property')
  const { rows } = await q(
    `INSERT INTO site_visits (lead_id, property_id, agent_id, scheduled_at, pickup_required, pickup_location, builder_preregistered)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      v.lead_id,
      v.property_id ?? null,
      agentId,
      v.scheduled_at,
      Boolean(v.pickup_required),
      v.pickup_location ?? null,
      Boolean(v.builder_preregistered),
    ],
  )
  // Booking a site visit auto-labels the thread so it stands out in the inbox.
  await applyAutoLabel(v.lead_id, agentId, 'site_visit_scheduled')
  return rows[0]
}

export async function listSiteVisits(agentId, { leadId = null, status = '', today = false } = {}) {
  const where = ['v.agent_id = $1']
  const params = [agentId]
  if (leadId) {
    params.push(leadId)
    where.push(`v.lead_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    where.push(`v.status = $${params.length}`)
  }
  if (today) {
    params.push(await agentTimezone(agentId))
    where.push(`(v.scheduled_at AT TIME ZONE $${params.length})::date = (now() AT TIME ZONE $${params.length})::date`)
  }
  const { rows } = await q(
    `SELECT v.*, l.name AS lead_name, l.wa_id AS lead_wa_id, p.title AS property_title, p.locality AS property_locality
     FROM site_visits v
     JOIN leads l ON l.id = v.lead_id
     LEFT JOIN properties p ON p.id = v.property_id AND p.agent_id = v.agent_id
     WHERE ${where.join(' AND ')}
     ORDER BY v.scheduled_at`,
    params,
  )
  return rows
}

export async function updateSiteVisit(id, agentId, fields) {
  if ('property_id' in fields) await assertOwned('properties', fields.property_id, agentId, 'property')
  const { sets, params } = buildSet(
    {
      scheduled_at: 'timestamptz',
      pickup_required: 'bool',
      pickup_location: 'text',
      status: 'text',
      outcome_notes: 'text',
      builder_preregistered: 'bool',
      property_id: 'int',
    },
    fields,
  )
  if (!sets.length)
    return (await q('SELECT * FROM site_visits WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
  const { rows } = await q(
    `UPDATE site_visits SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  const visit = rows[0]
  // Outcome capture drives the pipeline: a completed visit advances the lead to the
  // "visit done" stage; a no-show / reschedule bounces it back to "visit scheduled".
  if (visit && 'status' in fields) await applyVisitOutcomeToPipeline(visit, agentId)
  return visit
}

// Stamp that the booking confirmation went out (so the scheduler's reminders,
// which check the sent-at columns, don't treat this as un-notified).
export async function stampSiteVisitConfirmation(id, agentId) {
  await q('UPDATE site_visits SET confirmation_sent_at = now() WHERE id = $1 AND agent_id = $2', [id, agentId])
}

// Map a site-visit outcome to the lead's next pipeline stage. No-op for statuses
// that aren't outcomes (scheduled/confirmed), for closed/terminal leads, and when
// the target stage isn't part of the lead's pipeline.
const VISIT_OUTCOME_STAGE = {
  buy: { completed: 'Site Visit Done', no_show: 'Site Visit Scheduled', rescheduled: 'Site Visit Scheduled' },
  rental: { completed: 'Visit', no_show: 'Visit', rescheduled: 'Visit' },
}
async function applyVisitOutcomeToPipeline(visit, agentId) {
  const lead = await getLeadForAgent(visit.lead_id, agentId)
  if (!lead || lead.closed_at || TERMINAL_STAGES.has(lead.stage)) return
  const family = (lead.pipeline_type || 'buy_primary') === 'rental' ? 'rental' : 'buy'
  const target = VISIT_OUTCOME_STAGE[family][visit.status]
  if (!target || target === lead.stage) return
  const stages = await listPipelineStages(lead.pipeline_type || 'buy_primary')
  if (!stages.some((s) => s.stage_name === target)) return
  await setLeadStage(lead.id, agentId, { stage: target })
}

// --- CRM: follow-ups ---

export async function createFollowup(agentId, f) {
  if (!f.lead_id || !f.due_at) throw new Error('lead_id and due_at are required')
  const { rows } = await q(
    `INSERT INTO followups (lead_id, agent_id, due_at, type, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [f.lead_id, agentId, f.due_at, f.type || 'manual', f.note ?? null],
  )
  return rows[0]
}

export async function listFollowups(
  agentId,
  { pendingOnly = false, leadId = null, today = false, overdueOnly = false, byHeat = false } = {},
) {
  const where = ['f.agent_id = $1']
  const params = [agentId]
  if (pendingOnly || overdueOnly) where.push('f.completed_at IS NULL')
  if (overdueOnly) where.push('f.due_at < now()')
  if (leadId) {
    params.push(leadId)
    where.push(`f.lead_id = $${params.length}`)
  }
  if (today) {
    // "Today" includes anything overdue — an agent must see slipped follow-ups too.
    params.push(await agentTimezone(agentId))
    where.push(`(f.due_at AT TIME ZONE $${params.length})::date <= (now() AT TIME ZONE $${params.length})::date`)
  }
  // The overdue queue is worked hottest-lead-first: a cold lead's slipped follow-up
  // matters less than a hot one's. Everywhere else, chronological order is right.
  const orderBy = byHeat
    ? `COALESCE(l.effective_score, l.score, 0) DESC, f.due_at`
    : `f.completed_at NULLS FIRST, f.due_at`
  const { rows } = await q(
    `SELECT f.*, l.name AS lead_name, l.wa_id AS lead_wa_id,
       l.temp AS lead_temp, l.effective_temp AS lead_effective_temp,
       COALESCE(l.effective_score, l.score, 0) AS lead_heat,
       (f.completed_at IS NULL AND f.due_at < now())::int AS overdue
     FROM followups f
     JOIN leads l ON l.id = f.lead_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}`,
    params,
  )
  return rows
}

// General edit: reschedule, change the note, or set/clear completion.
// fields.completed (boolean) maps to stamping/clearing completed_at.
export async function updateFollowup(id, agentId, fields) {
  if ('completed' in fields) {
    await q(
      `UPDATE followups SET completed_at = CASE WHEN $3 THEN COALESCE(completed_at, now()) ELSE NULL END
       WHERE id = $1 AND agent_id = $2`,
      [id, agentId, Boolean(fields.completed)],
    )
  }
  const { sets, params } = buildSet({ due_at: 'timestamptz', note: 'text', type: 'text' }, fields)
  if (sets.length) {
    await q(
      `UPDATE followups SET ${sets.join(', ')} WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2}`,
      [...params, id, agentId],
    )
  }
  return (await q('SELECT * FROM followups WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
}

export async function completeFollowup(id, agentId) {
  const { rows } = await q(
    'UPDATE followups SET completed_at = now() WHERE id = $1 AND agent_id = $2 RETURNING *',
    [id, agentId],
  )
  return rows[0]
}

// --- CRM: commissions ---

// The canonical rupee-value (in paise) of a commission: an explicit flat amount wins,
// otherwise it's deal_value × pct. Returns 0 when neither is known. Used for the
// receivables ledger and for the GST invoice subtotal so both agree on one number.
export function commissionAmountPaise(c) {
  if (c.commission_flat_paise != null) return Number(c.commission_flat_paise)
  if (c.deal_value_paise != null && c.commission_pct != null) {
    return Math.round((Number(c.deal_value_paise) * Number(c.commission_pct)) / 100)
  }
  return 0
}

const withAmount = (c) => (c ? { ...c, amount_paise: commissionAmountPaise(c) } : c)

export async function createCommission(agentId, c) {
  if (!c.lead_id) throw new Error('lead_id is required')
  await assertOwned('deals', c.deal_id, agentId, 'deal')
  const { rows } = await q(
    `INSERT INTO commissions (lead_id, agent_id, deal_id, deal_value_paise, commission_pct, commission_flat_paise,
                              payer_type, builder_name, expected_payout_date, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      c.lead_id,
      agentId,
      c.deal_id ?? null,
      c.deal_value_paise ?? null,
      c.commission_pct ?? null,
      c.commission_flat_paise ?? null,
      c.payer_type ?? null,
      c.builder_name ?? null,
      c.expected_payout_date ?? null,
      c.status || 'expected',
      c.notes ?? null,
    ],
  )
  return withAmount(rows[0])
}

export async function listCommissions(agentId, { status } = {}) {
  const rows = status
    ? (
        await q('SELECT * FROM commissions WHERE agent_id = $1 AND status = $2 ORDER BY created_at DESC', [
          agentId,
          status,
        ])
      ).rows
    : (await q('SELECT * FROM commissions WHERE agent_id = $1 ORDER BY created_at DESC', [agentId])).rows
  return rows.map(withAmount)
}

async function getCommission(id, agentId) {
  return withAmount((await q('SELECT * FROM commissions WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0])
}

export async function updateCommission(id, agentId, fields) {
  if ('deal_id' in fields) await assertOwned('deals', fields.deal_id, agentId, 'deal')
  const { sets, params } = buildSet(
    {
      deal_id: 'bigint',
      deal_value_paise: 'bigint',
      commission_pct: 'numeric',
      commission_flat_paise: 'bigint',
      payer_type: 'text',
      builder_name: 'text',
      expected_payout_date: 'date',
      actual_payout_date: 'date',
      status: 'text',
      notes: 'text',
    },
    fields,
  )
  if (!sets.length) return getCommission(id, agentId)
  const { rows } = await q(
    `UPDATE commissions SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return withAmount(rows[0])
}

// --- §5.4: deals, builder receivables ledger + aging, GST invoices ---

const BOOKING_STAGES = new Set(['Token/Booking', 'Deposit/Token'])

// One month's rent is the standard rental brokerage in India — the auto-suggested
// commission for a rental deal.
export function suggestRentalCommissionPaise(deal) {
  if (!deal || deal.deal_type !== 'rental') return null
  return deal.monthly_rent_paise != null ? Number(deal.monthly_rent_paise) : null
}

// Capture a deal when a lead first reaches its booking stage. Idempotent
// (UNIQUE(lead_id)); returns the new deal, or null if one already existed. For a
// rental deal it also auto-creates the expected 1-month-rent commission so the
// receivable lands in the ledger immediately.
async function captureDealForLead(lead) {
  const isRental = (lead.pipeline_type || 'buy_primary') === 'rental'
  const dealType = isRental ? 'rental' : 'sale'
  // Best guess at the deal's property: the most recent site visit this lead had.
  const prop =
    (
      await q(
        `SELECT p.* FROM properties p
           JOIN site_visits sv ON sv.property_id = p.id
          WHERE sv.lead_id = $1 AND sv.agent_id = $2
          ORDER BY sv.scheduled_at DESC LIMIT 1`,
        [lead.id, lead.agent_id],
      )
    ).rows[0] || null
  // Rental listings price in monthly rent; sale listings in flat value. Fall back to
  // the lead's own budget when no property is attached.
  const dealValue = isRental ? null : prop?.price_paise ?? lead.budget_max ?? null
  const monthlyRent = isRental ? prop?.price_paise ?? lead.budget_max ?? null : null
  const { rows } = await q(
    `INSERT INTO deals (agent_id, lead_id, property_id, deal_type, builder_name,
                        deal_value_paise, monthly_rent_paise, stage_captured, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
     ON CONFLICT (lead_id) DO NOTHING RETURNING *`,
    [lead.agent_id, lead.id, prop?.id ?? null, dealType, prop?.builder_name ?? null, dealValue, monthlyRent, lead.stage],
  )
  const deal = rows[0]
  if (!deal) return null // already captured on an earlier move
  const suggested = suggestRentalCommissionPaise(deal)
  if (suggested) {
    await createCommission(lead.agent_id, {
      lead_id: lead.id,
      deal_id: deal.id,
      deal_value_paise: suggested,
      commission_flat_paise: suggested,
      payer_type: 'buyer', // rental brokerage is paid by the tenant
      notes: 'Auto-suggested: 1 month rent',
    })
  }
  return deal
}

export async function createDeal(agentId, d) {
  if (!d.lead_id) throw new Error('lead_id is required')
  await assertOwned('properties', d.property_id, agentId, 'property')
  const { rows } = await q(
    `INSERT INTO deals (agent_id, lead_id, property_id, deal_type, builder_name,
                        deal_value_paise, monthly_rent_paise, stage_captured, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      agentId,
      d.lead_id,
      d.property_id ?? null,
      d.deal_type || 'sale',
      d.builder_name ?? null,
      d.deal_value_paise ?? null,
      d.monthly_rent_paise ?? null,
      d.stage_captured || 'manual',
      d.status || 'open',
      d.notes ?? null,
    ],
  )
  return rows[0]
}

export async function listDeals(agentId, { status = '', dealType = '' } = {}) {
  const clauses = ['d.agent_id = $1']
  const params = [agentId]
  if (status) {
    params.push(status)
    clauses.push(`d.status = $${params.length}`)
  }
  if (dealType) {
    params.push(dealType)
    clauses.push(`d.deal_type = $${params.length}`)
  }
  return (
    await q(
      `SELECT d.*, l.name AS lead_name, l.wa_id AS lead_wa_id, p.title AS property_title
       FROM deals d
       JOIN leads l ON l.id = d.lead_id
       LEFT JOIN properties p ON p.id = d.property_id AND p.agent_id = d.agent_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY d.created_at DESC`,
      params,
    )
  ).rows
}

export async function getDeal(id, agentId) {
  return (
    await q(
      `SELECT d.*, l.name AS lead_name, l.wa_id AS lead_wa_id, p.title AS property_title
       FROM deals d
       JOIN leads l ON l.id = d.lead_id
       LEFT JOIN properties p ON p.id = d.property_id AND p.agent_id = d.agent_id
       WHERE d.id = $1 AND d.agent_id = $2`,
      [id, agentId],
    )
  ).rows[0]
}

export async function updateDeal(id, agentId, fields) {
  if ('property_id' in fields) await assertOwned('properties', fields.property_id, agentId, 'property')
  const { sets, params } = buildSet(
    {
      property_id: 'bigint',
      deal_type: 'text',
      builder_name: 'text',
      deal_value_paise: 'bigint',
      monthly_rent_paise: 'bigint',
      status: 'text',
      notes: 'text',
    },
    fields,
  )
  if (!sets.length) return getDeal(id, agentId)
  const { rows } = await q(
    `UPDATE deals SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING id`,
    [...params, id, agentId],
  )
  return rows[0] ? getDeal(id, agentId) : undefined
}

// Builder receivables ledger with an aging report. Groups every outstanding
// builder-owed commission (expected / invoiced / overdue) by builder, and buckets
// each amount by how long it has been outstanding past its expected payout date
// (or, if none, since it was created): 0-30, 31-60, 61-90, 90+ days.
export async function builderReceivables(agentId) {
  const amountExpr = `COALESCE(c.commission_flat_paise, ROUND(c.deal_value_paise * c.commission_pct / 100.0), 0)::bigint`
  const daysExpr = `GREATEST(0, (CURRENT_DATE - COALESCE(c.expected_payout_date, c.created_at::date)))::int`
  const { rows } = await q(
    `WITH rec AS (
       SELECT COALESCE(NULLIF(c.builder_name, ''), NULLIF(d.builder_name, ''), 'Unknown') AS builder_name,
              ${amountExpr} AS amount,
              ${daysExpr} AS days
       FROM commissions c
       LEFT JOIN deals d ON d.id = c.deal_id AND d.agent_id = c.agent_id
       WHERE c.agent_id = $1 AND c.payer_type = 'builder' AND c.status IN ('expected','invoiced','overdue')
     )
     SELECT builder_name,
            COUNT(*)::int AS count,
            SUM(amount)::bigint AS total_paise,
            SUM(CASE WHEN days <= 30 THEN amount ELSE 0 END)::bigint AS b_0_30,
            SUM(CASE WHEN days BETWEEN 31 AND 60 THEN amount ELSE 0 END)::bigint AS b_31_60,
            SUM(CASE WHEN days BETWEEN 61 AND 90 THEN amount ELSE 0 END)::bigint AS b_61_90,
            SUM(CASE WHEN days > 90 THEN amount ELSE 0 END)::bigint AS b_90_plus
     FROM rec
     GROUP BY builder_name
     ORDER BY total_paise DESC`,
    [agentId],
  )
  const totals = { count: 0, total_paise: 0, b_0_30: 0, b_31_60: 0, b_61_90: 0, b_90_plus: 0 }
  for (const r of rows) {
    for (const k of Object.keys(totals)) totals[k] += Number(r[k]) || 0
  }
  const received_paise = Number(
    (
      await q(
        `SELECT COALESCE(SUM(COALESCE(commission_flat_paise, ROUND(deal_value_paise * commission_pct / 100.0), 0)), 0)::bigint AS s
         FROM commissions WHERE agent_id = $1 AND payer_type = 'builder' AND status = 'received'`,
        [agentId],
      )
    ).rows[0].s,
  )
  return { builders: rows, totals, received_paise }
}

// The next INV-<agent>-NNNN for this agent, derived from the highest sequence
// already issued rather than from a row count. Counting is wrong twice over: an
// agent who types their own number ("INV-7-0044") leaves the count behind the
// numbers on the books, and because a rejected INSERT never changes the count,
// the collision then repeats on every later invoice — auto-numbering jams for
// good. substring() yields NULL for a hand-typed number that doesn't fit the
// pattern, so MAX simply ignores those.
async function nextInvoiceNumber(agentId) {
  const { rows } = await q(
    `SELECT COALESCE(MAX(substring(invoice_number from $2)::int), 0) AS n
       FROM commission_invoices WHERE agent_id = $1`,
    [agentId, `^INV-${agentId}-(\\d+)$`],
  )
  return `INV-${agentId}-${String(rows[0].n + 1).padStart(4, '0')}`
}

// Raise a GST-aware invoice for a commission. The subtotal is the commission's
// canonical amount; GST (18% by default) is split in paise so subtotal + gst =
// total exactly. Marks the commission 'invoiced'. Idempotent-ish: throws if the
// commission has no amount to bill.
export async function createCommissionInvoice(agentId, commissionId, { gst_rate, invoice_number, notes } = {}) {
  const commission = await getCommission(commissionId, agentId)
  if (!commission) return null
  const subtotal = commissionAmountPaise(commission)
  if (subtotal <= 0) fail('This commission has no amount to invoice', 'NO_AMOUNT')
  // The rate reaches gstBreakdown as arithmetic, so it has to be a real percentage
  // before it gets there. Unvalidated, a bad one wasn't a 400 but a silently wrong
  // invoice on the books: gst_rate: -18 billed NEGATIVE tax (a ₹1,000 subtotal
  // totalling ₹820) and no one was told. Non-numeric input was worse only in being
  // noisy — NaN reached the INSERT and came back as a Postgres cast error rather
  // than a sentence an agent can act on.
  // Number() is not the check to make here: it answers 0 for [] and for '', so a
  // junk field would have quietly become a 0% invoice rather than a rejection.
  // Only a real number, or a string that is entirely a number, is a rate.
  const raw = gst_rate ?? GST_RATE
  const rate =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    fail('GST rate must be a percentage between 0 and 100', 'INVALID_GST_RATE')
  }
  const breakdown = gstBreakdown(subtotal, rate)
  // Reading the next number and inserting it is not atomic, so two invoices raised
  // at once pick the same one and the loser hits UNIQUE (agent_id, invoice_number).
  // Retry — the re-read now sees the winner's row. A number the caller supplied is
  // never retried: that collision is a real 409 for them to resolve.
  let rows
  for (let attempt = 0; ; attempt++) {
    const number = invoice_number || (await nextInvoiceNumber(agentId))
    try {
      ;({ rows } = await q(
        `INSERT INTO commission_invoices (agent_id, commission_id, invoice_number, subtotal_paise, gst_rate, gst_paise, total_paise, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [agentId, commissionId, number, breakdown.subtotal_paise, breakdown.gst_rate, breakdown.gst_paise, breakdown.total_paise, notes ?? null],
      ))
      break
    } catch (err) {
      if (err.code !== '23505' || invoice_number || attempt >= 4) throw err
    }
  }
  // Advance the commission to 'invoiced' (leave 'received'/'overdue' alone).
  await q(
    `UPDATE commissions SET status = 'invoiced', updated_at = now()
     WHERE id = $1 AND agent_id = $2 AND status = 'expected'`,
    [commissionId, agentId],
  )
  return rows[0]
}

export async function listCommissionInvoices(agentId, { commissionId = null, status = '' } = {}) {
  const clauses = ['ci.agent_id = $1']
  const params = [agentId]
  if (commissionId) {
    params.push(commissionId)
    clauses.push(`ci.commission_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    clauses.push(`ci.status = $${params.length}`)
  }
  return (
    await q(
      `SELECT ci.*, l.name AS lead_name, l.wa_id AS lead_wa_id
       FROM commission_invoices ci
       JOIN commissions c ON c.id = ci.commission_id
       JOIN leads l ON l.id = c.lead_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY ci.issued_at DESC`,
      params,
    )
  ).rows
}

export async function updateCommissionInvoice(id, agentId, fields) {
  const { sets, params } = buildSet({ status: 'text', notes: 'text' }, fields)
  if (!sets.length)
    return (await q('SELECT * FROM commission_invoices WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
  const { rows } = await q(
    `UPDATE commission_invoices SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  const invoice = rows[0]
  // Paying an invoice settles its commission.
  if (invoice && fields.status === 'paid') {
    await q(
      `UPDATE commissions SET status = 'received', actual_payout_date = COALESCE(actual_payout_date, CURRENT_DATE), updated_at = now()
       WHERE id = $1 AND agent_id = $2`,
      [invoice.commission_id, agentId],
    )
  }
  return invoice
}

// --- CRM: message templates ---

export async function createMessageTemplate(agentId, t) {
  if (!t.name || !t.body) throw new Error('name and body are required')
  const { rows } = await q(
    `INSERT INTO message_templates (agent_id, name, category, body, variables, meta_template_id, rera_auto_append)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      agentId,
      t.name,
      t.category || 'utility',
      t.body,
      JSON.stringify(t.variables || []),
      t.meta_template_id ?? null,
      Boolean(t.rera_auto_append),
    ],
  )
  return rows[0]
}

export async function listMessageTemplates(agentId) {
  return (await q('SELECT * FROM message_templates WHERE agent_id = $1 ORDER BY name', [agentId])).rows
}

export async function updateMessageTemplate(id, agentId, fields) {
  const { sets, params } = buildSet(
    {
      name: 'text',
      category: 'text',
      body: 'text',
      variables: 'jsonb',
      meta_template_id: 'text',
      meta_status: 'text',
      rera_auto_append: 'bool',
    },
    fields,
  )
  if (!sets.length)
    return (await q('SELECT * FROM message_templates WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
  const { rows } = await q(
    `UPDATE message_templates SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0]
}

// --- CRM: agent dashboard (the Home tab) ---

export async function dashboard(agentId) {
  // Six independent widget queries, issued together rather than in sequence.
  const [unansweredRes, hotLeadsRes, followupsToday, overdueFollowups, siteVisitsToday, activity] =
    await Promise.all([
      // Unanswered: open leads whose most recent message is from the buyer,
      // oldest wait first. The client renders the age timer from last_at.
      //
      // AWAITING_REPLY does the filtering from the lead row (see migration 025); the
      // LATERAL stays because the widget shows the message text, but it now runs once
      // per waiting lead instead of once per open lead — 400 lookups instead of 8,400
      // on a busy broker. `ON lm.role = 'buyer'` is kept as the authority on what
      // counts as unanswered, so the answer is identical either way.
      q(
        `SELECT l.id, l.name, l.wa_id, l.temp, l.score, l.stage, l.pipeline_type,
                lm.text AS last_msg, lm.created_at AS last_at
         FROM leads l
         JOIN LATERAL (
           SELECT role, text, created_at FROM messages m
           WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1
         ) lm ON lm.role = 'buyer'
         WHERE l.agent_id = $1 AND l.closed_at IS NULL AND ${AWAITING_REPLY}
         ORDER BY lm.created_at`,
        [agentId],
      ),
      // Decayed/rule-hybrid temperature (see stats()/scoring.js) — a lead the AI
      // called Hot at extraction time but that has gone quiet must fall off this
      // widget, and one the hard rule just promoted must appear even if its raw
      // AI temp was Warm.
      q(
        `SELECT id, name, wa_id, score, effective_score, stage, pipeline_type, ai_summary, next_step, updated_at
         FROM leads WHERE agent_id = $1 AND COALESCE(effective_temp, temp) = 'Hot' AND closed_at IS NULL
         ORDER BY COALESCE(effective_score, score) DESC NULLS LAST, updated_at DESC LIMIT 10`,
        [agentId],
      ),
      listFollowups(agentId, { pendingOnly: true, today: true }),
      // Slipped follow-ups, worked hottest-lead-first (the "overdue queue" widget).
      listFollowups(agentId, { overdueOnly: true, byHeat: true }),
      listSiteVisits(agentId, { today: true }),
      listActivity(agentId, 20),
    ])
  return {
    unanswered: unansweredRes.rows,
    followupsToday,
    overdueFollowups,
    siteVisitsToday,
    hotLeads: hotLeadsRes.rows,
    activity,
  }
}

// --- CRM: audit log ---

export async function logAudit(agentId, entityType, entityId, action, details = {}) {
  await q(
    'INSERT INTO audit_logs (agent_id, entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4, $5)',
    [agentId, entityType, entityId, action, JSON.stringify(details)],
  )
}

export async function listAuditLogs(agentId, limit = 100) {
  return (
    await q('SELECT * FROM audit_logs WHERE agent_id = $1 ORDER BY id DESC LIMIT $2', [agentId, limit])
  ).rows
}

// --- Lead score decay (recency + engagement velocity; see scoring.js) ---

// Raw engagement signals for one lead: last inbound, attributed micro-page views,
// and site-visit times. Feeds decayLead().
// Shape one signals row (from either the single or the batched query) into the
// object decayLead()/ruleSignals() expect. Kept separate so both paths agree.
function toSignals(r = {}) {
  return {
    lastBuyerAt: r.last_buyer_at,
    pageViews: r.page_views || [],
    siteVisits: r.site_visits || [],
    // Extra signals the rules+LLM hybrid needs: how many times the buyer replied,
    // and whether a site visit was ever agreed (any visit row counts).
    buyerReplies: Number(r.buyer_replies) || 0,
    visitAgreed: (Number(r.visit_count) || 0) > 0,
  }
}

// The correlated sub-selects that make up one signals row. `ref` is the lead-id
// expression to correlate against, so the same SQL serves the single-lead lookup
// ($1) and the batched one (l.id over an unnested id array).
const SIGNALS_SELECT = (ref) => `
       (SELECT MAX(created_at) FROM messages WHERE lead_id = ${ref} AND role = 'buyer') AS last_buyer_at,
       (SELECT COUNT(*) FROM messages WHERE lead_id = ${ref} AND role = 'buyer') AS buyer_replies,
       (SELECT COUNT(*) FROM site_visits WHERE lead_id = ${ref}) AS visit_count,
       ARRAY(SELECT viewed_at FROM property_page_views WHERE lead_id = ${ref} ORDER BY viewed_at DESC LIMIT 50) AS page_views,
       ARRAY(SELECT scheduled_at FROM site_visits WHERE lead_id = ${ref}) AS site_visits`

export async function leadEngagementSignals(leadId) {
  const { rows } = await q(`SELECT ${SIGNALS_SELECT('$1')}`, [leadId])
  return toSignals(rows[0])
}

// Signals for many leads in ONE round trip, returned as a Map keyed by lead id.
// Same sub-selects as the single-lead version, correlated against an unnested
// array of ids instead of a scalar parameter.
async function leadEngagementSignalsBatch(leadIds) {
  if (!leadIds.length) return new Map()
  const { rows } = await q(
    `SELECT l.id AS lead_id, ${SIGNALS_SELECT('l.id')}
     FROM unnest($1::int[]) AS l(id)`,
    [leadIds],
  )
  return new Map(rows.map((r) => [r.lead_id, toSignals(r)]))
}

// Rules + LLM hybrid temperature for a lead (see scoring.hybridScore). Does not
// persist — used by lead detail / briefing and after stage events for a fresh,
// explainable Hot/Warm/Cold + reason string.
export async function computeHybridScore(lead, now = Date.now()) {
  const sig = await leadEngagementSignals(lead.id)
  return hybridScore(lead, sig, now)
}

// Compute the decayed score for a lead without persisting (used by lead detail /
// briefing so those surfaces are always fresh).
export async function computeLeadDecay(lead, now = Date.now()) {
  const sig = await leadEngagementSignals(lead.id)
  return decayLead(lead, sig, now)
}

// Recompute and PERSIST a lead's engagement/effective score + temperature.
//
// Temperature is decay's, UNLESS the hard qualification rule has fired (budget
// stated + near-term timeline + 2+ replies + visit agreed) — that rule is a
// business-level "this buyer is qualified" signal and must not be lost just
// because engagement went quiet for a day (see scoring.hybridScore). We do NOT
// also pull in the LLM-band promotion hybridScore applies for live/detail views:
// that one is meant to keep a strong-but-quiet lead visible in the UI, not to
// stop decay from cooling a silent lead in the persisted field that drives
// notifications, dashboard counts and segment membership.
// The pure part: lead + signals -> the five persisted score columns. No I/O, so
// the single-lead and bulk paths cannot drift apart.
function scoreRow(lead, signals, now) {
  const d = decayLead(lead, signals, now)
  const rules = ruleSignals(lead, signals)
  const temperature = rules.hotRule ? 'Hot' : d.temperature
  return { decay: d, temperature, factors: { ...d.factors, rule_hot: rules.hotRule } }
}

export async function recomputeLeadScore(leadId, now = Date.now()) {
  const lead = await getLead(leadId)
  if (!lead) return null
  const signals = await leadEngagementSignals(leadId)
  const { decay: d, temperature, factors } = scoreRow(lead, signals, now)
  await q(
    `UPDATE leads SET engagement_score = $2, effective_score = $3, effective_temp = $4,
       score_factors = $5, last_decay_at = now() WHERE id = $1`,
    [leadId, d.engagementScore, d.effectiveScore, temperature, JSON.stringify(factors)],
  )
  return { ...d, temperature }
}

// Recompute every non-closed lead for an agent (the twice-daily decay job, and
// called on-demand when the worklist is opened so its ranking is honest).
//
// Set-based on purpose: this runs synchronously inside GET /api/worklist, and the
// old row-at-a-time loop cost three round trips per open lead (fetch, signals,
// update). An agent with a few hundred live leads paid for hundreds of sequential
// round trips before the page could render. Now it is three queries total,
// regardless of lead count.
export async function recomputeAgentScores(agentId, now = Date.now()) {
  const { rows: leads } = await q(
    'SELECT * FROM leads WHERE agent_id = $1 AND closed_at IS NULL',
    [agentId],
  )
  if (!leads.length) return 0

  const signalsById = await leadEngagementSignalsBatch(leads.map((l) => l.id))

  const ids = []
  const engagement = []
  const effective = []
  const temps = []
  const factors = []
  for (const lead of leads) {
    const s = scoreRow(lead, signalsById.get(lead.id) || toSignals(), now)
    ids.push(lead.id)
    engagement.push(s.decay.engagementScore)
    effective.push(s.decay.effectiveScore)
    temps.push(s.temperature)
    factors.push(JSON.stringify(s.factors))
  }

  // One UPDATE ... FROM over unnested column arrays — a single statement, so the
  // whole recompute lands atomically.
  await q(
    `UPDATE leads SET engagement_score = v.engagement_score, effective_score = v.effective_score,
       effective_temp = v.effective_temp, score_factors = v.score_factors, last_decay_at = now()
     FROM unnest($1::int[], $2::int[], $3::int[], $4::text[], $5::jsonb[])
       AS v(id, engagement_score, effective_score, effective_temp, score_factors)
     WHERE leads.id = v.id`,
    [ids, engagement, effective, temps, factors],
  )
  return leads.length
}

// --- Property view analytics (surfaces property_page_views, which was written by
// every micro-page hit and read by nothing) ---

export async function leadPageViews(leadId) {
  return (
    await q(
      'SELECT property_id, viewed_at, referrer FROM property_page_views WHERE lead_id = $1 ORDER BY viewed_at',
      [leadId],
    )
  ).rows
}

export async function propertyViewAnalytics(propertyId, agentId) {
  const owned = (await q('SELECT id, title FROM properties WHERE id = $1 AND agent_id = $2', [propertyId, agentId])).rows[0]
  if (!owned) return null
  const totals = (
    await q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE viewed_at >= now() - interval '24 hours')::int AS last_24h,
              COUNT(*) FILTER (WHERE viewed_at >= now() - interval '7 days')::int AS last_7d,
              COUNT(DISTINCT lead_id) FILTER (WHERE lead_id IS NOT NULL)::int AS distinct_leads
       FROM property_page_views WHERE property_id = $1`,
      [propertyId],
    )
  ).rows[0]
  const daily = (
    await q(
      `SELECT to_char(viewed_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS views
       FROM property_page_views WHERE property_id = $1 AND viewed_at >= now() - interval '30 days'
       GROUP BY day ORDER BY day`,
      [propertyId],
    )
  ).rows
  // Who's looking, and how often — a lead viewing 3+ times is the strongest signal.
  const viewers = (
    await q(
      `SELECT v.lead_id, l.name AS lead_name, l.wa_id, l.effective_temp,
              COUNT(*)::int AS views, MAX(v.viewed_at) AS last_viewed
       FROM property_page_views v
       JOIN leads l ON l.id = v.lead_id
       WHERE v.property_id = $1 AND l.agent_id = $2
       GROUP BY v.lead_id, l.name, l.wa_id, l.effective_temp
       ORDER BY views DESC, last_viewed DESC`,
      [propertyId, agentId],
    )
  ).rows
  return { property_id: propertyId, title: owned.title, ...totals, daily, viewers }
}

// --- Notification queue ---

export async function createNotification(agentId, { type, title, body = null, entity_type = null, entity_id = null, dedupe_key = null }) {
  const { rows } = await q(
    `INSERT INTO notifications (agent_id, type, title, body, entity_type, entity_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [agentId, type, title, body, entity_type, entity_id, dedupe_key],
  )
  return rows[0] || null // null = deduped (already notified for this reason)
}

export async function listNotifications(agentId, { unreadOnly = false, limit = 50 } = {}) {
  const where = ['agent_id = $1']
  if (unreadOnly) where.push('read_at IS NULL')
  return (
    await q(
      `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit],
    )
  ).rows
}

export async function unreadNotificationCount(agentId) {
  return (
    await q('SELECT COUNT(*)::int AS n FROM notifications WHERE agent_id = $1 AND read_at IS NULL', [agentId])
  ).rows[0].n
}

export async function markNotificationRead(id, agentId) {
  const { rows } = await q(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND agent_id = $2 AND read_at IS NULL RETURNING *',
    [id, agentId],
  )
  return rows[0] || null
}

export async function markAllNotificationsRead(agentId) {
  return (await q('UPDATE notifications SET read_at = now() WHERE agent_id = $1 AND read_at IS NULL', [agentId])).rowCount
}

// --- Send log + rate-limiter data (see sendLimiter.js) ---

export async function recordSend(agentId, { contact_id = null, phone, kind = 'marketing' }) {
  await q(
    'INSERT INTO message_sends (agent_id, contact_id, phone, kind) VALUES ($1, $2, $3, $4)',
    [agentId, contact_id, phone, kind],
  )
}

// Rolling 24h send count for the number (the daily-cap denominator).
export async function sendsToday(agentId) {
  return (
    await q(
      `SELECT COUNT(*)::int AS n FROM message_sends WHERE agent_id = $1 AND sent_at >= now() - interval '24 hours'`,
      [agentId],
    )
  ).rows[0].n
}

// Per-contact history: last send time and count this calendar month.
export async function contactSendStats(agentId, contactId, phone) {
  const { rows } = await q(
    `SELECT MAX(sent_at) AS last_sent_at,
            COUNT(*) FILTER (WHERE sent_at >= date_trunc('month', now()))::int AS month_count
     FROM message_sends
     WHERE agent_id = $1 AND ($2::int IS NOT NULL AND contact_id = $2 OR phone = $3)`,
    [agentId, contactId ?? null, phone],
  )
  return { lastSentAt: rows[0]?.last_sent_at || null, monthCount: rows[0]?.month_count || 0 }
}

// The same per-contact history for a whole recipient list, in ONE query.
// A bulk send used to call contactSendStats() per recipient — a festive blast to
// 500 contacts meant 500 round-trips before a single message went out. The list is
// unnested into a virtual table and LEFT JOINed against the send log, so the cost
// is one statement regardless of audience size.
//
// Returns a Map keyed by `sendStatsKey(contact)`; callers look up per recipient.
// Keeping the key derivation in one exported helper means the writer of the map
// and its readers cannot drift apart.
export function sendStatsKey(contact) {
  return contact?.id != null ? `c:${contact.id}` : `p:${contact?.phone ?? ''}`
}

export async function contactSendStatsBatch(agentId, recipients = []) {
  const out = new Map()
  if (!recipients.length) return out
  // De-duplicate first: the same contact twice in one list would otherwise unnest
  // into two identical rows (harmless, but pointless work).
  const byKey = new Map()
  for (const c of recipients) if (!byKey.has(sendStatsKey(c))) byKey.set(sendStatsKey(c), c)
  const keys = [...byKey.keys()]
  const ids = keys.map((k) => byKey.get(k).id ?? null)
  const phones = keys.map((k) => byKey.get(k).phone ?? null)

  const { rows } = await q(
    `SELECT r.key,
            MAX(s.sent_at) AS last_sent_at,
            COUNT(s.id) FILTER (WHERE s.sent_at >= date_trunc('month', now()))::int AS month_count
     FROM unnest($2::text[], $3::int[], $4::text[]) AS r(key, contact_id, phone)
     LEFT JOIN message_sends s
       ON s.agent_id = $1
      AND ((r.contact_id IS NOT NULL AND s.contact_id = r.contact_id) OR s.phone = r.phone)
     GROUP BY r.key`,
    [agentId, keys, ids, phones],
  )
  for (const r of rows) out.set(r.key, { lastSentAt: r.last_sent_at || null, monthCount: r.month_count || 0 })
  // Recipients with no send history at all still need an entry.
  for (const k of keys) if (!out.has(k)) out.set(k, { lastSentAt: null, monthCount: 0 })
  return out
}

// Stamp the warmup anchor the first time a number sends in bulk; return the agent.
export async function ensureBulkSendStarted(agentId) {
  const { rows } = await q(
    `UPDATE agents SET bulk_send_started_at = COALESCE(bulk_send_started_at, now())
     WHERE id = $1 RETURNING bulk_send_started_at`,
    [agentId],
  )
  return rows[0]?.bulk_send_started_at || null
}

// --- Prioritised daily worklist / next-best-action feed (see worklist.js) ---

export async function worklist(agentId, now = new Date()) {
  const items = []

  // The eight source queries below are independent of one another, so they go out
  // together rather than one-round-trip-at-a-time. /api/worklist is the screen an
  // agent opens first every morning; serialising eight round-trips made its latency
  // the sum of all eight instead of the slowest one.
  const [
    windowRows,
    visitRows,
    hotRows,
    followupRows,
    reopenRows,
    quietAfterVisitRows,
    commissionRows,
    staleRows,
  ] = (
    await Promise.all([
      q(
        `SELECT id, name, wa_id, last_inbound_at
         FROM leads WHERE agent_id = $1 AND closed_at IS NULL
           AND last_inbound_at IS NOT NULL
           AND last_inbound_at <= now() - interval '20 hours'
           AND last_inbound_at > now() - interval '24 hours'`,
        [agentId],
      ),
      q(
        `SELECT v.id, v.scheduled_at, l.id AS lead_id, l.name, l.wa_id, p.title
         FROM site_visits v JOIN leads l ON l.id = v.lead_id
         LEFT JOIN properties p ON p.id = v.property_id AND p.agent_id = v.agent_id
         WHERE v.agent_id = $1 AND v.status = 'scheduled'
           AND v.scheduled_at BETWEEN now() AND now() + interval '48 hours'`,
        [agentId],
      ),
      // A hot lead whose last word was theirs. The LATERAL this replaced ran once per
      // hot lead just to read the role of a row the lead already knows about.
      q(
        `SELECT l.id, l.name, l.wa_id, l.effective_score, l.last_inbound_at AS last_at
         FROM leads l
         WHERE l.agent_id = $1 AND l.closed_at IS NULL AND l.effective_temp = 'Hot'
           AND ${AWAITING_REPLY}`,
        [agentId],
      ),
      q(
        `SELECT f.id, f.due_at, f.note, l.id AS lead_id, l.name, l.wa_id
         FROM followups f JOIN leads l ON l.id = f.lead_id
         WHERE f.agent_id = $1 AND f.completed_at IS NULL AND f.due_at < now()`,
        [agentId],
      ),
      q(
        `SELECT l.id, l.name, l.wa_id, COUNT(*)::int AS views, MAX(v.viewed_at) AS last_viewed
         FROM property_page_views v JOIN leads l ON l.id = v.lead_id
         WHERE l.agent_id = $1 AND l.closed_at IS NULL AND v.viewed_at >= now() - interval '24 hours'
         GROUP BY l.id, l.name, l.wa_id HAVING COUNT(*) >= 2`,
        [agentId],
      ),
      // Visited, then dropped: a completed visit nobody followed up on. "Did we say
      // anything after the visit?" is last_outbound_at, so the NOT EXISTS that used
      // to scan the lead's messages per visit row is now a comparison of two
      // timestamps the lead already carries.
      q(
        `SELECT DISTINCT ON (l.id) l.id, l.name, l.wa_id, v.scheduled_at
         FROM site_visits v JOIN leads l ON l.id = v.lead_id
         WHERE v.agent_id = $1 AND v.status = 'completed' AND l.closed_at IS NULL
           AND v.scheduled_at < now() - interval '3 days'
           AND (l.last_outbound_at IS NULL OR l.last_outbound_at <= v.scheduled_at)
         ORDER BY l.id, v.scheduled_at DESC`,
        [agentId],
      ),
      q(
        `SELECT c.id, c.expected_payout_date, l.id AS lead_id, l.name, l.wa_id
         FROM commissions c JOIN leads l ON l.id = c.lead_id
         WHERE c.agent_id = $1 AND (c.status = 'overdue'
           OR (c.status = 'expected' AND c.expected_payout_date IS NOT NULL AND c.expected_payout_date < now()::date))`,
        [agentId],
      ),
      // Gone quiet: nothing said in either direction for a fortnight. This is the
      // query the migration's numbers came from — it read `messages` twice per
      // candidate (once for the MAX, once for the NOT EXISTS) to return ~22 rows.
      // A lead that has never exchanged a message has never been contacted, so it
      // is stale by this rule too — which is what NULL means here, and why the
      // NULL arm is spelled out rather than left to a comparison that would drop it.
      q(
        `SELECT l.id, l.name, l.wa_id, l.stage, ${LAST_CONTACT_AT} AS last_msg_at
         FROM leads l
         WHERE l.agent_id = $1 AND l.closed_at IS NULL
           AND COALESCE(l.stage, 'New') NOT IN ('Registered/Closed','Closed','Lost')
           AND COALESCE(l.effective_temp, l.temp) IS DISTINCT FROM 'Hot'
           AND (${LAST_CONTACT_AT} IS NULL OR ${LAST_CONTACT_AT} < now() - interval '14 days')`,
        [agentId],
      ),
    ])
  ).map((r) => r.rows)

  // 1. Service window closing within ~4h (highest priority; hard deadline).
  for (const l of windowRows) {
    const hoursLeft = 24 - (Date.now() - new Date(l.last_inbound_at).getTime()) / 3600_000
    items.push(worklistItem('service_window_closing', {
      lead_id: l.id,
      title: l.name || l.wa_id,
      reason: `Free-reply window closes in ~${Math.max(1, Math.round(hoursLeft))}h — reply now or send a template.`,
      recencyAt: l.last_inbound_at,
    }))
  }

  // 2. Site visit within 48h, not yet confirmed.
  for (const v of visitRows) {
    items.push(worklistItem('site_visit_soon', {
      lead_id: v.lead_id, entity_type: 'site_visit', entity_id: v.id,
      title: v.name || v.wa_id,
      reason: `Site visit ${v.title ? `for ${v.title} ` : ''}coming up — confirm attendance, no-shows kill deals.`,
      recencyAt: v.scheduled_at,
    }))
  }

  // 3. Hot lead (post-decay) whose last message is from the buyer — waiting on you.
  for (const l of hotRows) {
    items.push(worklistItem('hot_lead_waiting', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: `Hot lead (score ${l.effective_score}) is waiting on your reply.`,
      recencyAt: l.last_at,
    }))
  }

  // 4. Overdue follow-ups.
  for (const f of followupRows) {
    items.push(worklistItem('overdue_followup', {
      lead_id: f.lead_id, entity_type: 'followup', entity_id: f.id,
      title: f.name || f.wa_id,
      reason: f.note ? `Overdue follow-up: ${f.note}` : 'Follow-up is overdue.',
      recencyAt: f.due_at,
      priority: followupPriority(f.due_at),
    }))
  }

  // 5. Micro-page re-opened: 2+ attributed views in the last 24h.
  for (const l of reopenRows) {
    items.push(worklistItem('micro_page_reopened', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: `Re-opened a property page ${l.views}× in the last day — call while it's fresh.`,
      recencyAt: l.last_viewed,
    }))
  }

  // 6. Site visit completed 3+ days ago with no agent message since (deal dying).
  for (const l of quietAfterVisitRows) {
    items.push(worklistItem('site_visit_no_followup', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: 'Visited but you’ve gone quiet since — follow up before the deal cools.',
      recencyAt: l.scheduled_at,
    }))
  }

  // 7. Commission overdue.
  for (const c of commissionRows) {
    items.push(worklistItem('commission_overdue', {
      lead_id: c.lead_id, entity_type: 'commission', entity_id: c.id,
      title: c.name || c.wa_id,
      reason: 'Brokerage is overdue — chase the payout.',
      recencyAt: c.expected_payout_date,
    }))
  }

  // 8. Stale lead: active pipeline, no message either way in 14 days, not Hot.
  //
  // This used to filter out leads already raised as a closing service window or as a
  // hot lead waiting, so neither could be listed twice. Neither overlap is reachable
  // any more, and the rules say so themselves rather than a set doing it afterwards:
  // a closing window means an inbound message 20–24h ago, which is the very thing
  // "silent for a fortnight" measures, and the hot rule matches effective_temp =
  // 'Hot' where this one matches everything but.
  // Two different leads reach this rule and they need two different sentences. A lead
  // that has gone quiet needs resurfacing. A lead typed into Quick-add a minute ago
  // has a NULL last_msg_at, which the query above deliberately counts as stale — but
  // telling the agent "no contact in 2+ weeks" about a lead they created while making
  // tea is false on its face, and it names the wrong next move: there is nothing to
  // resurface, because the conversation has not started.
  for (const l of staleRows) {
    items.push(worklistItem('stale_lead', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: l.last_msg_at
        ? 'No contact in 2+ weeks — resurface with a new property or a check-in.'
        : 'Added by hand and never messaged — send a first hello to start the conversation.',
      recencyAt: l.last_msg_at,
    }))
  }

  const ranked = rankWorklist(items)
  return { items: ranked, counts: worklistCounts(ranked) }
}

// --- Contact groups / segments ---

// Dynamic-segment resolver: contacts of the agent whose linked leads match the
// criteria. Contacts join leads by phone (contacts.phone without '+' == leads.wa_id).
function segmentWhere(criteria = {}, params) {
  const conds = []
  // Localities are free text an agent types, so they're compared case- and
  // whitespace-insensitively. The preferred_localities arm searches for the name
  // inside the JSON array with strpos rather than ILIKE: a locality is agent-typed,
  // and under ILIKE a name holding '%' or '_' would stop being a name and start
  // being a pattern — a segment criterion of "%" matched every contact the agent had.
  const locality = String(criteria.locality ?? '').trim().toLowerCase()
  if (locality) {
    params.push(locality)
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id
      AND (lower(btrim(l.locality)) = $${params.length} OR strpos(lower(l.preferred_localities::text), $${params.length}) > 0))`)
  }
  if (criteria.intent) {
    params.push(criteria.intent)
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id AND l.intent = $${params.length})`)
  }
  if (criteria.temp) {
    params.push(criteria.temp)
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id AND COALESCE(l.effective_temp, l.temp) = $${params.length})`)
  }
  if (criteria.budget_min_paise != null) {
    params.push(criteria.budget_min_paise)
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id AND l.budget_max >= $${params.length})`)
  }
  if (criteria.budget_max_paise != null) {
    params.push(criteria.budget_max_paise)
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id AND l.budget_min <= $${params.length})`)
  }
  return conds
}

export async function resolveSegment(agentId, criteria = {}) {
  const params = [agentId]
  const conds = ['c.agent_id = $1', "c.opt_in_status != 'opted_out'", ...segmentWhere(criteria, params)]
  return (
    await q(`SELECT c.* FROM contacts c WHERE ${conds.join(' AND ')} ORDER BY c.name`, params)
  ).rows
}

export async function createGroup(agentId, { name, color = '#2563eb', kind = 'static', criteria = {} }) {
  if (!name || !String(name).trim()) throw new Error('name is required')
  const { rows } = await q(
    `INSERT INTO contact_groups (agent_id, name, color, kind, criteria)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [agentId, String(name).trim(), color, kind, JSON.stringify(criteria || {})],
  )
  return rows[0]
}

export async function listGroups(agentId) {
  return (
    await q(
      `SELECT g.*, (SELECT COUNT(*)::int FROM contact_group_members m WHERE m.group_id = g.id) AS member_count
       FROM contact_groups g WHERE g.agent_id = $1 ORDER BY g.name`,
      [agentId],
    )
  ).rows
}

export async function getGroup(id, agentId) {
  return (await q('SELECT * FROM contact_groups WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0] || null
}

export async function updateGroup(id, agentId, fields) {
  const { sets, params } = buildSet({ name: 'text', color: 'text', criteria: 'jsonb' }, fields)
  if (!sets.length) return getGroup(id, agentId)
  const { rows } = await q(
    `UPDATE contact_groups SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0] || null
}

export async function deleteGroup(id, agentId) {
  return (await q('DELETE FROM contact_groups WHERE id = $1 AND agent_id = $2', [id, agentId])).rowCount > 0
}

// Resolve a group's members: explicit rows for static groups, the live segment for
// dynamic ones (so a query-backed group never goes stale).
export async function groupMembers(id, agentId) {
  const group = await getGroup(id, agentId)
  if (!group) return null
  if (group.kind === 'dynamic') return resolveSegment(agentId, group.criteria)
  return (
    await q(
      `SELECT c.* FROM contact_group_members m JOIN contacts c ON c.id = m.contact_id
       WHERE m.group_id = $1 AND c.agent_id = $2 ORDER BY c.name`,
      [id, agentId],
    )
  ).rows
}

export async function addGroupMembers(id, agentId, contactIds) {
  const group = await getGroup(id, agentId)
  if (!group || group.kind !== 'static') return null
  if (!contactIds?.length) return 0
  // One INSERT ... SELECT for the whole batch. The join against contacts is what
  // enforces ownership (ids belonging to another agent simply don't match), and
  // selecting from contacts also collapses any duplicate ids in the input.
  // autoGroupContacts calls this once per distinct value, so the old per-contact
  // loop made the cost of auto-grouping quadratic in a big address book.
  const r = await q(
    `INSERT INTO contact_group_members (group_id, contact_id)
     SELECT $1, c.id FROM contacts c WHERE c.id = ANY($2::int[]) AND c.agent_id = $3
     ON CONFLICT DO NOTHING`,
    [id, contactIds, agentId],
  )
  return r.rowCount
}

export async function removeGroupMember(id, agentId, contactId) {
  const group = await getGroup(id, agentId)
  if (!group) return false
  return (
    await q('DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2', [id, contactId])
  ).rowCount > 0
}

// The three auto-grouping dimensions. `match` is the same rule segmentWhere
// applies for that criterion, rewritten to compare against a value column so the
// whole dimension can be resolved in one pass instead of one query per value.
// Null-prototype: `by` comes straight off the request body, and a plain object
// would answer to "constructor"/"toString" with something truthy that has no
// .values, turning a bad dimension into a 500 instead of the 400 it is.
const AUTO_GROUP_DIMENSIONS = Object.assign(Object.create(null), {
  // "Andheri", "andheri", "ANDHERI" and "Andheri " are one locality that four
  // agents typed four ways, not four localities. A plain DISTINCT saw four values
  // and built four groups holding the same contacts — while the match rule compared
  // case-insensitively, so three of them claimed each other's members and the
  // trailing-space one matched nobody but itself. DISTINCT ON the folded form
  // collapses them to one group; ORDER BY picks the same representative spelling on
  // every re-run, which is what keeps the top-up idempotent.
  locality: {
    label: 'Locality',
    values: `SELECT DISTINCT ON (lower(btrim(l.locality))) btrim(l.locality) AS v
               FROM leads l WHERE l.agent_id = $1 AND btrim(l.locality) <> ''
              ORDER BY lower(btrim(l.locality)), btrim(l.locality)`,
    match: `(lower(btrim(l.locality)) = lower(vals.v) OR strpos(lower(l.preferred_localities::text), lower(vals.v)) > 0)`,
  },
  intent: {
    label: 'Intent',
    values: `SELECT DISTINCT l.intent AS v FROM leads l WHERE l.agent_id = $1 AND l.intent IS NOT NULL`,
    match: `l.intent = vals.v`,
  },
  temp: {
    label: 'Temp',
    values: `SELECT DISTINCT COALESCE(l.effective_temp, l.temp) AS v FROM leads l WHERE l.agent_id = $1 AND COALESCE(l.effective_temp, l.temp) IS NOT NULL`,
    match: `COALESCE(l.effective_temp, l.temp) = vals.v`,
  },
})

// One-click auto-grouping: scan the agent's leads, create a static group per
// distinct value (locality / intent / temperature), and populate it with the
// matching contacts. Idempotent — re-running tops up membership, never duplicates.
//
// Four statements total, whatever the number of distinct values. The old shape
// ran a group lookup, a segment resolve and a membership insert per value, so an
// agent working forty localities paid ~160 round trips for one button press.
export async function autoGroupContacts(agentId, by) {
  const dim = AUTO_GROUP_DIMENSIONS[by]
  if (!dim) throw new Error('unknown grouping dimension')
  const values = (await q(dim.values, [agentId])).rows.map((r) => r.v).filter(Boolean)
  if (!values.length) return []
  const prefix = `${dim.label}: `
  const names = values.map((v) => prefix + v)

  // Create the missing groups in one statement — UNIQUE (agent_id, name) is what
  // makes re-running a top-up rather than a duplicate — then read them all back,
  // both the ones just created and the ones that were already there.
  await q(
    `INSERT INTO contact_groups (agent_id, name) SELECT $1, n FROM unnest($2::text[]) AS n
     ON CONFLICT (agent_id, name) DO NOTHING`,
    [agentId, names],
  )
  const byName = new Map(
    (
      await q('SELECT * FROM contact_groups WHERE agent_id = $1 AND name = ANY($2::text[])', [agentId, names])
    ).rows.map((g) => [g.name, g]),
  )

  // One statement resolves every value's segment, tops up all the memberships and
  // reports the segment sizes: `ins` is a data-modifying CTE, so it runs even
  // though the outer SELECT only reads `pairs`. Membership is gated on
  // kind = 'static' for the same reason addGroupMembers is — a dynamic group of
  // the same name resolves its members live and must not gain explicit rows.
  const counts = new Map(
    (
      await q(
        `WITH vals AS (${dim.values}),
              pairs AS (
                SELECT DISTINCT vals.v AS v, c.id AS contact_id
                  FROM vals
                  JOIN contacts c ON c.agent_id = $1 AND c.opt_in_status <> 'opted_out'
                  JOIN leads l ON l.wa_id = replace(c.phone, '+', '') AND l.agent_id = c.agent_id
                 WHERE ${dim.match}
              ),
              ins AS (
                INSERT INTO contact_group_members (group_id, contact_id)
                SELECT g.id, p.contact_id FROM pairs p
                  JOIN contact_groups g
                    ON g.agent_id = $1 AND g.name = $2::text || p.v AND g.kind = 'static'
                ON CONFLICT DO NOTHING
              )
         SELECT v, COUNT(*)::int AS member_count FROM pairs GROUP BY v`,
        [agentId, prefix],
      )
    ).rows.map((r) => [r.v, r.member_count]),
  )

  return values.map((v) => ({ ...byName.get(prefix + v), member_count: counts.get(v) || 0 }))
}

// ===========================================================================
// Lead Source Integrations (migration 010): portal email ingest, Meta Lead Ads,
// click-to-WhatsApp attribution, walk-in/phone quick-add, portal API + syndication.
// db.js holds the storage primitives; the orchestration lives in leadSources.js.
// ===========================================================================

// The workspace's inbound-email address that portals send lead notifications to.
export async function findAgentByIngestToken(token) {
  if (!token) return null
  const { rows } = await q('SELECT * FROM agents WHERE ingest_token = $1', [token])
  return rows[0] || null
}

// Rotate an agent's ingest token (invalidates the old address). Returns the new token.
export async function regenerateIngestToken(agentId) {
  const { rows } = await q(
    `UPDATE agents SET ingest_token = substr(md5(random()::text || clock_timestamp()::text), 1, 12)
     WHERE id = $1 RETURNING ingest_token`,
    [agentId],
  )
  return rows[0]?.ingest_token || null
}

// Find an agent-owned lead by its canonical WhatsApp id (digits, no '+'). Used for
// dedupe when a portal/ad/walk-in lead arrives for a number we already track.
export async function getLeadByAgentWaId(agentId, waId) {
  const { rows } = await q('SELECT * FROM leads WHERE agent_id = $1 AND wa_id = $2', [agentId, waId])
  return rows[0] || null
}

// Stamp structured provenance on a lead. Channel/portal are only set when still empty
// (a portal touch on an existing WhatsApp lead is a merge, not a rewrite), but the raw
// metadata is always merged in and the free-entry / CTWA anchors updated when provided.
export async function setLeadSourceProvenance(leadId, prov = {}) {
  await q(
    `UPDATE leads SET
       source = COALESCE($2, source),
       source_channel = COALESCE(source_channel, $3),
       source_portal = COALESCE(source_portal, $4),
       source_ref = COALESCE($5, source_ref),
       source_meta = source_meta || $6::jsonb,
       ctwa_clid = COALESCE($7, ctwa_clid),
       free_entry_at = COALESCE($8, free_entry_at),
       updated_at = now()
     WHERE id = $1`,
    [
      leadId,
      prov.source ?? null,
      prov.source_channel ?? null,
      prov.source_portal ?? null,
      prov.source_ref ?? null,
      JSON.stringify(prov.source_meta || {}),
      prov.ctwa_clid ?? null,
      prov.free_entry_at ?? null,
    ],
  )
  return getLead(leadId)
}

// Click-to-WhatsApp referral: the buyer DID open a WhatsApp chat (via an ad), so unlike
// setLeadSourceProvenance this always (re)starts the 72h free-entry window and merges the
// referral metadata. Channel is only stamped if the lead had no structured source yet.
export async function recordCtwaReferral(leadId, referral = {}) {
  await q(
    `UPDATE leads SET
       source = 'ctwa',
       source_channel = COALESCE(source_channel, 'ctwa'),
       source_meta = source_meta || $2::jsonb,
       ctwa_clid = COALESCE($3, ctwa_clid),
       free_entry_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [leadId, JSON.stringify({ ctwa: referral }), referral.ctwa_clid ?? null],
  )
  return getLead(leadId)
}

// Log an ingestion attempt. Dedupes on (agent_id, channel, external_id): a second event
// for the same portal lead id returns { event, duplicate:true } without inserting.
export async function createLeadSourceEvent(e) {
  if (e.external_id != null && e.agent_id != null) {
    const { rows } = await q(
      `INSERT INTO lead_source_events
         (agent_id, lead_id, channel, portal, external_id, status, contact_phone, contact_name, auto_reply_status, raw, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (agent_id, channel, external_id) WHERE external_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [e.agent_id, e.lead_id ?? null, e.channel, e.portal ?? null, e.external_id,
       e.status ?? 'received', e.contact_phone ?? null, e.contact_name ?? null,
       e.auto_reply_status ?? null, JSON.stringify(e.raw || {}), e.error ?? null],
    )
    if (rows[0]) return { event: rows[0], duplicate: false }
    const existing = (
      await q('SELECT * FROM lead_source_events WHERE agent_id = $1 AND channel = $2 AND external_id = $3',
        [e.agent_id, e.channel, e.external_id])
    ).rows[0]
    return { event: existing, duplicate: true }
  }
  const { rows } = await q(
    `INSERT INTO lead_source_events
       (agent_id, lead_id, channel, portal, external_id, status, contact_phone, contact_name, auto_reply_status, raw, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,
    [e.agent_id ?? null, e.lead_id ?? null, e.channel, e.portal ?? null, e.external_id ?? null,
     e.status ?? 'received', e.contact_phone ?? null, e.contact_name ?? null,
     e.auto_reply_status ?? null, JSON.stringify(e.raw || {}), e.error ?? null],
  )
  return { event: rows[0], duplicate: false }
}

export async function updateLeadSourceEvent(id, fields = {}) {
  const { sets, params } = buildSet(
    { lead_id: 'int', status: 'text', auto_reply_status: 'text', error: 'text' },
    fields,
  )
  if (!sets.length) return null
  const { rows } = await q(
    `UPDATE lead_source_events SET ${sets.join(', ')} WHERE id = $${params.length + 1} RETURNING *`,
    [...params, id],
  )
  return rows[0]
}

// Recent ingestion feed for the "Lead sources" screen.
export async function listLeadSourceEvents(agentId, { channel = '', limit = 50 } = {}) {
  const where = ['e.agent_id = $1']
  const params = [agentId]
  if (channel) {
    params.push(channel)
    where.push(`e.channel = $${params.length}`)
  }
  params.push(Math.min(Number(limit) || 50, 200))
  const { rows } = await q(
    `SELECT e.*, l.name AS lead_name
       FROM lead_source_events e
       LEFT JOIN leads l ON l.id = e.lead_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC LIMIT $${params.length}`,
    params,
  )
  return rows
}

// Per-channel ingestion counts for the dashboard header.
export async function leadSourceStats(agentId) {
  const { rows } = await q(
    `SELECT source_channel AS channel, COUNT(*)::int AS n
       FROM leads WHERE agent_id = $1 AND source_channel IS NOT NULL
       GROUP BY source_channel`,
    [agentId],
  )
  return rows
}

// --- Direct portal API integrations (99acres / MagicBricks / Housing / NoBroker) ---

const PORTAL_INT_FIELDS = { enabled: 'bool', api_key: 'text', api_secret: 'text', config: 'jsonb', last_sync_at: 'text', last_status: 'text' }

// Secrets are never returned to the client; expose only whether they're set.
function maskPortalIntegration(row) {
  if (!row) return row
  const { api_key, api_secret, ...rest } = row
  return { ...rest, has_api_key: Boolean(api_key), has_api_secret: Boolean(api_secret) }
}

export async function listPortalIntegrations(agentId) {
  const { rows } = await q(
    'SELECT * FROM portal_integrations WHERE agent_id = $1 ORDER BY portal',
    [agentId],
  )
  return rows.map(maskPortalIntegration)
}

// Raw row incl. secrets — module-private on purpose: everything that leaves db.js
// goes through maskPortalIntegration, so the api_key/api_secret can't be handed to a
// route by accident.
async function getPortalIntegrationRaw(agentId, portal) {
  const { rows } = await q(
    'SELECT * FROM portal_integrations WHERE agent_id = $1 AND portal = $2',
    [agentId, portal],
  )
  return rows[0] || null
}

export async function upsertPortalIntegration(agentId, portal, fields = {}) {
  const existing = await getPortalIntegrationRaw(agentId, portal)
  if (!existing) {
    await q('INSERT INTO portal_integrations (agent_id, portal) VALUES ($1, $2)', [agentId, portal])
  }
  const { sets, params } = buildSet(PORTAL_INT_FIELDS, fields)
  if (sets.length) {
    await q(
      `UPDATE portal_integrations SET ${sets.join(', ')}, updated_at = now()
       WHERE agent_id = $${params.length + 1} AND portal = $${params.length + 2}`,
      [...params, agentId, portal],
    )
  }
  return maskPortalIntegration(await getPortalIntegrationRaw(agentId, portal))
}

// --- Listing syndication (compose once, export portal-formatted) ---

export async function upsertSyndication(propertyId, agentId, portal, fields = {}) {
  const existing = (
    await q('SELECT id FROM property_syndications WHERE property_id = $1 AND portal = $2', [propertyId, portal])
  ).rows[0]
  if (!existing) {
    await q(
      'INSERT INTO property_syndications (property_id, agent_id, portal) VALUES ($1, $2, $3)',
      [propertyId, agentId, portal],
    )
  }
  const { sets, params } = buildSet(
    { status: 'text', formatted: 'jsonb', external_listing_id: 'text', exported_at: 'text' },
    fields,
  )
  if (sets.length) {
    await q(
      `UPDATE property_syndications SET ${sets.join(', ')}, updated_at = now()
       WHERE property_id = $${params.length + 1} AND portal = $${params.length + 2}`,
      [...params, propertyId, portal],
    )
  }
  const { rows } = await q(
    'SELECT * FROM property_syndications WHERE property_id = $1 AND portal = $2', [propertyId, portal],
  )
  return rows[0]
}

export async function listSyndications(agentId, propertyId = null) {
  const where = ['agent_id = $1']
  const params = [agentId]
  if (propertyId != null) {
    params.push(propertyId)
    where.push(`property_id = $${params.length}`)
  }
  const { rows } = await q(
    `SELECT * FROM property_syndications WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
    params,
  )
  return rows
}

// ===========================================================================
// Unified WhatsApp Inbox + Template Messages (migration 012)
// ===========================================================================

// Seed the six system labels, default quick replies and curated template pack for
// one agent. Idempotent (ON CONFLICT DO NOTHING) so it is safe on every signup and
// after the migration has already seeded existing agents.
export async function seedWorkspaceDefaults(agentId) {
  await q(
    `INSERT INTO labels (agent_id, name, color, auto_key, is_system, sort) VALUES
       ($1,'New','#3b82f6','new',true,0),
       ($1,'Hot','#ef4444','hot',true,1),
       ($1,'Site Visit Scheduled','#8b5cf6','site_visit_scheduled',true,2),
       ($1,'Token Paid','#10b981','token_paid',true,3),
       ($1,'Lost','#6b7280','lost',true,4),
       ($1,'Broker','#f59e0b','broker',true,5)
     ON CONFLICT (agent_id, name) DO NOTHING`,
    [agentId],
  )
  await q(
    `INSERT INTO quick_replies (agent_id, title, body, is_system) VALUES
       ($1,'Greeting','Hi {{name}}, thanks for reaching out! How can I help with your property search today?',true),
       ($1,'Share brochure','Hi {{name}}, sharing the details for {{property}}. Let me know what you think!',true),
       ($1,'Visit confirm','Great, {{name}}! Your site visit for {{property}} is confirmed for {{visit_time}}. See you there.',true),
       ($1,'Ask budget','To shortlist the best options for you, may I know your budget range and preferred locality?',true),
       ($1,'Follow up','Hi {{name}}, just following up on your property enquiry. Are you still looking? Happy to help.',true)
     ON CONFLICT (agent_id, title) DO NOTHING`,
    [agentId],
  )
  await q(
    `INSERT INTO message_templates
       (agent_id, name, category, body, variables, rera_auto_append, is_system, is_locked, meta_status, language) VALUES
       ($1,'welcome','utility','Hi {{name}}, thanks for connecting with us. How can we help you find your next home today?','["name"]',false,true,true,'approved','en'),
       ($1,'site_visit_reminder','utility','Hi {{name}}, a reminder for your site visit at {{property}} on {{visit_time}}. Reply here if you need to reschedule.','["name","property","visit_time"]',false,true,true,'approved','en'),
       ($1,'new_listing','marketing','Hi {{name}}, a new property matching your requirement just came up: {{property}}. Would you like the details?','["name","property"]',true,true,true,'approved','en'),
       ($1,'price_update','marketing','Hi {{name}}, there is a price update on {{property}}. Reply YES to get the latest pricing and availability.','["name","property"]',true,true,true,'approved','en'),
       ($1,'festival_greeting','marketing','Hi {{name}}, wishing you and your family a joyful festive season from all of us!','["name"]',true,true,true,'approved','en')
     ON CONFLICT (agent_id, name) DO NOTHING`,
    [agentId],
  )
}

// --- Team inbox: unread + assignment ---------------------------------------

// Mark a thread read by stamping last_read_at. Only affects the agent's own or
// unassigned-pool leads (getAssignableLead guards ownership). Returns the lead.
export async function markLeadRead(leadId, agentId) {
  const lead = await getAssignableLead(leadId, agentId)
  if (!lead) return null
  await q('UPDATE leads SET last_read_at = now() WHERE id = $1', [leadId])
  return getLead(leadId)
}

// Reassign a thread to another agent (or back to the owner with assigneeId=null).
// Only the current owner may reassign. Returns the updated lead, or null if the
// caller doesn't own it.
export async function assignLeadTo(leadId, agentId, assigneeId) {
  const lead = await getLeadForAgent(leadId, agentId)
  if (!lead) return null
  await q('UPDATE leads SET assigned_agent_id = $2, updated_at = now() WHERE id = $1', [leadId, assigneeId ?? null])
  return getLead(leadId)
}

// --- Internal notes ---------------------------------------------------------

export async function listLeadNotes(leadId) {
  const { rows } = await q(
    `SELECT n.*, a.name AS agent_name
       FROM lead_notes n JOIN agents a ON a.id = n.agent_id
       WHERE n.lead_id = $1 ORDER BY n.id`,
    [leadId],
  )
  return rows
}

export async function addLeadNote(leadId, agentId, body) {
  const text = String(body || '').trim()
  if (!text) throw new Error('note body is required')
  const { rows } = await q(
    'INSERT INTO lead_notes (lead_id, agent_id, body) VALUES ($1, $2, $3) RETURNING *',
    [leadId, agentId, text],
  )
  return rows[0]
}

// A note is deletable only by its author.
export async function deleteLeadNote(id, agentId) {
  const res = await q('DELETE FROM lead_notes WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
}

// --- Quick replies ----------------------------------------------------------

export async function listQuickReplies(agentId) {
  return (await q('SELECT * FROM quick_replies WHERE agent_id = $1 ORDER BY title', [agentId])).rows
}

export async function createQuickReply(agentId, { title, body }) {
  if (!title || !body) throw new Error('title and body are required')
  const { rows } = await q(
    'INSERT INTO quick_replies (agent_id, title, body) VALUES ($1, $2, $3) RETURNING *',
    [agentId, String(title).trim(), String(body)],
  )
  return rows[0]
}

export async function updateQuickReply(id, agentId, fields) {
  const { sets, params } = buildSet({ title: 'text', body: 'text' }, fields)
  if (!sets.length)
    return (await q('SELECT * FROM quick_replies WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
  const { rows } = await q(
    `UPDATE quick_replies SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0]
}

export async function deleteQuickReply(id, agentId) {
  const res = await q('DELETE FROM quick_replies WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
}

// --- Media library ----------------------------------------------------------

// Assets plus how many distinct contacts each has been sent to (for the library UI).
export async function listMediaAssets(agentId) {
  const { rows } = await q(
    `SELECT m.*,
       (SELECT count(DISTINCT lead_id) FROM media_sends s WHERE s.media_id = m.id)::int AS sent_count
     FROM media_assets m WHERE m.agent_id = $1 ORDER BY m.created_at DESC`,
    [agentId],
  )
  return rows
}

export async function getMediaAsset(id, agentId) {
  return (await q('SELECT * FROM media_assets WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
}

export async function createMediaAsset(agentId, a) {
  if (!a.title || !a.url) throw new Error('title and url are required')
  const { rows } = await q(
    `INSERT INTO media_assets (agent_id, title, kind, storage, url, filename, mime, size_bytes, caption)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      agentId,
      String(a.title).trim(),
      a.kind || 'document',
      a.storage || 'url',
      a.url,
      a.filename ?? null,
      a.mime ?? null,
      a.size_bytes ?? null,
      a.caption ?? null,
    ],
  )
  return rows[0]
}

export async function deleteMediaAsset(id, agentId) {
  const res = await q('DELETE FROM media_assets WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
}

// Record that an asset was sent to a lead (drives the "already sent" marker).
export async function recordMediaSend(mediaId, leadId, agentId, waMessageId = null) {
  const { rows } = await q(
    'INSERT INTO media_sends (media_id, lead_id, agent_id, wa_message_id) VALUES ($1,$2,$3,$4) RETURNING *',
    [mediaId, leadId, agentId, waMessageId],
  )
  return rows[0]
}

// The set of media ids already sent to a given lead (for the attach picker).
export async function mediaIdsSentToLead(leadId) {
  const { rows } = await q('SELECT DISTINCT media_id FROM media_sends WHERE lead_id = $1', [leadId])
  return rows.map((r) => r.media_id)
}

// --- Labels -----------------------------------------------------------------

export async function listLabels(agentId) {
  return (await q('SELECT * FROM labels WHERE agent_id = $1 ORDER BY sort, id', [agentId])).rows
}

export async function createLabel(agentId, { name, color }) {
  if (!name || !String(name).trim()) throw new Error('label name is required')
  const { rows } = await q(
    `INSERT INTO labels (agent_id, name, color, is_system, sort)
     VALUES ($1, $2, $3, false, (SELECT COALESCE(max(sort), 0) + 1 FROM labels WHERE agent_id = $1))
     RETURNING *`,
    [agentId, String(name).trim(), color || '#64748b'],
  )
  return rows[0]
}

// System labels are part of the lifecycle vocabulary and can't be deleted.
// Returns 'deleted' | 'system' | 'missing' rather than a bare boolean, so the route
// can tell "you may not delete this" apart from "there is nothing here". A single
// false conflated the two and made a stale id look like a permissions problem.
export async function deleteLabel(id, agentId) {
  const res = await q('DELETE FROM labels WHERE id = $1 AND agent_id = $2 AND is_system = false', [id, agentId])
  if (res.rowCount > 0) return 'deleted'
  const { rows } = await q('SELECT is_system FROM labels WHERE id = $1 AND agent_id = $2', [id, agentId])
  return rows[0]?.is_system ? 'system' : 'missing'
}

export async function leadLabels(leadId) {
  const { rows } = await q(
    `SELECT lb.id, lb.name, lb.color, lb.is_system, ll.applied_by
       FROM lead_labels ll JOIN labels lb ON lb.id = ll.label_id
       WHERE ll.lead_id = $1 ORDER BY lb.sort, lb.id`,
    [leadId],
  )
  return rows
}

// Add or remove a label on a lead. The label must belong to the same agent as the
// lead (validated by the caller passing agentId). applied_by defaults to 'manual'.
export async function setLeadLabel(leadId, labelId, agentId, on, appliedBy = 'manual') {
  const label = (await q('SELECT id FROM labels WHERE id = $1 AND agent_id = $2', [labelId, agentId])).rows[0]
  if (!label) return null
  if (on) {
    await q(
      `INSERT INTO lead_labels (lead_id, label_id, applied_by) VALUES ($1, $2, $3)
       ON CONFLICT (lead_id, label_id) DO NOTHING`,
      [leadId, labelId, appliedBy],
    )
  } else {
    await q('DELETE FROM lead_labels WHERE lead_id = $1 AND label_id = $2', [leadId, labelId])
  }
  return leadLabels(leadId)
}

// Apply a system label to a lead by its auto_key (e.g. 'hot', 'lost'). No-op when
// the lead has no owner (unassigned pool) or the label isn't seeded for the agent.
export async function applyAutoLabel(leadId, agentId, autoKey) {
  if (!leadId || !agentId || !autoKey) return
  const label = (
    await q('SELECT id FROM labels WHERE agent_id = $1 AND auto_key = $2', [agentId, autoKey])
  ).rows[0]
  if (!label) return
  await q(
    `INSERT INTO lead_labels (lead_id, label_id, applied_by) VALUES ($1, $2, 'auto')
     ON CONFLICT (lead_id, label_id) DO NOTHING`,
    [leadId, label.id],
  )
}

// --- Templates: single fetch + delete (list/create/update already exist) -----

export async function getMessageTemplate(id, agentId) {
  return (await q('SELECT * FROM message_templates WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
}

// System templates are part of the curated pack and can't be deleted by the agent.
export async function deleteMessageTemplate(id, agentId) {
  const res = await q(
    'DELETE FROM message_templates WHERE id = $1 AND agent_id = $2 AND is_system = false',
    [id, agentId],
  )
  return res.rowCount > 0
}

// ===========================================================================
// Team Management (§5.3, migration 011): teams, roles, lead assignment, privacy.
//
// An agent belongs to at most one team (team_members.agent_id is UNIQUE). Lead
// ownership stays agent_id; team_id is a denormalized tag that lets managers see
// the whole team. The privacy wall is enforced in the API — agents reach only
// their own leads via /api/leads; /api/team/* is gated to managers and owners.
// ===========================================================================

// The team id an agent belongs to, or null. Cheap single-column lookup used on
// the inbound hot path, so it stays a bare SELECT rather than a join.
async function agentTeamId(agentId) {
  return (await q('SELECT team_id FROM team_members WHERE agent_id = $1', [agentId])).rows[0]?.team_id ?? null
}

// The agent's team plus their membership (role/localities). null for a solo agent.
export async function getAgentTeam(agentId) {
  const { rows } = await q(
    `SELECT t.*, tm.role, tm.id AS member_id, tm.localities, tm.accepts_leads
     FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.agent_id = $1`,
    [agentId],
  )
  return rows[0] ? { ...rows[0], is_owner: rows[0].role === 'owner' } : null
}

async function getTeamById(teamId) {
  return (await q('SELECT * FROM teams WHERE id = $1', [teamId])).rows[0] || null
}

// Create a team; the creator becomes its owner member. An agent can be in one team.
export async function createTeam(ownerAgentId, name) {
  const nm = String(name ?? '').trim()
  if (!nm) fail('Team name is required')
  if (nm.length > 120) fail('Team name is too long (max 120 characters)')
  if (await agentTeamId(ownerAgentId)) fail('You are already in a team', 'ALREADY_IN_TEAM')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'INSERT INTO teams (name, owner_agent_id) VALUES ($1, $2) RETURNING *',
      [nm, ownerAgentId],
    )
    await client.query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [
      rows[0].id,
      ownerAgentId,
      'owner',
    ])
    await client.query('COMMIT')
    return rows[0]
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.code === '23505') fail('You are already in a team', 'ALREADY_IN_TEAM')
    throw e
  } finally {
    client.release()
  }
}

export async function updateTeam(teamId, fields = {}) {
  if (fields.name !== undefined && !String(fields.name).trim()) fail('Team name cannot be empty')
  const { sets, params } = buildSet(
    { name: 'text', assignment_strategy: 'text', shared_wa_phone_number_id: 'text' },
    fields,
  )
  if (!sets.length) return getTeamById(teamId)
  const { rows } = await q(
    `UPDATE teams SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length + 1} RETURNING *`,
    [...params, teamId],
  )
  return rows[0]
}

// Owner disbands the team: leads return to their agents (team scope dropped),
// members and invites fall away via ON DELETE CASCADE.
export async function deleteTeam(teamId) {
  await q('UPDATE leads SET team_id = NULL WHERE team_id = $1', [teamId])
  await q('DELETE FROM teams WHERE id = $1', [teamId])
  return true
}

// Members with their agent identity and this-team lead counts, owner first.
export async function listTeamMembers(teamId) {
  return (
    await q(
      `SELECT tm.id AS member_id, tm.agent_id, tm.role, tm.localities, tm.accepts_leads, tm.joined_at,
              a.name, a.phone, a.email, a.avatar_url, a.wa_phone_number, a.is_active,
              (SELECT COUNT(*) FROM leads l WHERE l.agent_id = tm.agent_id AND l.team_id = $1)::int AS lead_count
       FROM team_members tm JOIN agents a ON a.id = tm.agent_id
       WHERE tm.team_id = $1
       ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, a.name`,
      [teamId],
    )
  ).rows
}

async function isTeamMember(teamId, agentId) {
  return Boolean(
    (await q('SELECT 1 FROM team_members WHERE team_id = $1 AND agent_id = $2', [teamId, agentId])).rows[0],
  )
}

// --- Invitations: invite by login number, the invitee accepts ---

export async function inviteToTeam(teamId, invitedBy, { phone, role = 'agent' } = {}) {
  const p = normalizePhone(phone)
  if (p.replace(/\D/g, '').length < 10) fail('Enter a valid WhatsApp number for the invite', 'INVALID_PHONE')
  if (!['manager', 'agent'].includes(role)) fail('Role must be manager or agent')
  const onTeam = (
    await q(
      'SELECT 1 FROM team_members tm JOIN agents a ON a.id = tm.agent_id WHERE tm.team_id = $1 AND a.phone = $2',
      [teamId, p],
    )
  ).rows[0]
  if (onTeam) fail('That number is already on your team', 'ALREADY_MEMBER')
  const elsewhere = (
    await q('SELECT 1 FROM team_members tm JOIN agents a ON a.id = tm.agent_id WHERE a.phone = $1', [p])
  ).rows[0]
  if (elsewhere) fail('That agent already belongs to another team', 'IN_OTHER_TEAM')
  try {
    const { rows } = await q(
      'INSERT INTO team_invites (team_id, phone, role, invited_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [teamId, p, role, invitedBy],
    )
    return rows[0]
  } catch (e) {
    if (e.code === '23505') fail('There is already a pending invite for that number', 'DUP_INVITE')
    throw e
  }
}

export async function listTeamInvites(teamId) {
  return (
    await q(
      `SELECT ti.*, a.name AS invited_by_name FROM team_invites ti
       LEFT JOIN agents a ON a.id = ti.invited_by
       WHERE ti.team_id = $1 AND ti.status = 'pending' ORDER BY ti.created_at DESC`,
      [teamId],
    )
  ).rows
}

// Pending invites addressed to an agent's login number (shown to the invitee).
export async function listIncomingInvites(phone) {
  return (
    await q(
      `SELECT ti.id, ti.team_id, ti.role, ti.created_at, t.name AS team_name, a.name AS invited_by_name
       FROM team_invites ti JOIN teams t ON t.id = ti.team_id
       LEFT JOIN agents a ON a.id = ti.invited_by
       WHERE ti.phone = $1 AND ti.status = 'pending' ORDER BY ti.created_at DESC`,
      [normalizePhone(phone)],
    )
  ).rows
}

export async function respondToInvite(inviteId, agent, accept) {
  const invite = (await q('SELECT * FROM team_invites WHERE id = $1', [inviteId])).rows[0]
  if (!invite || invite.status !== 'pending') fail('Invite not found or already handled', 'NOT_FOUND')
  if (normalizePhone(agent.phone) !== invite.phone) fail('This invite is for a different number', 'WRONG_INVITEE')
  if (!accept) {
    await q("UPDATE team_invites SET status = 'declined', responded_at = now() WHERE id = $1", [inviteId])
    return { declined: true }
  }
  if (await agentTeamId(agent.id)) fail('You are already in a team', 'ALREADY_IN_TEAM')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO team_members (team_id, agent_id, role) VALUES ($1, $2, $3)', [
      invite.team_id,
      agent.id,
      invite.role,
    ])
    await client.query("UPDATE team_invites SET status = 'accepted', responded_at = now() WHERE id = $1", [inviteId])
    // Any other pending invites to this number are now moot.
    await client.query(
      "UPDATE team_invites SET status = 'revoked', responded_at = now() WHERE phone = $1 AND status = 'pending' AND id <> $2",
      [invite.phone, inviteId],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    if (e.code === '23505') fail('You are already in a team', 'ALREADY_IN_TEAM')
    throw e
  } finally {
    client.release()
  }
  return { accepted: true, team_id: invite.team_id, role: invite.role }
}

export async function revokeInvite(inviteId, teamId) {
  return (
    await q(
      "UPDATE team_invites SET status = 'revoked', responded_at = now() WHERE id = $1 AND team_id = $2 AND status = 'pending'",
      [inviteId, teamId],
    )
  ).rowCount > 0
}

// --- Roles & membership ---

export async function setMemberRole(teamId, targetAgentId, role) {
  if (!['manager', 'agent'].includes(role)) fail('Role must be manager or agent')
  const team = await getTeamById(teamId)
  if (!team) fail('Team not found', 'NOT_FOUND')
  if (Number(team.owner_agent_id) === Number(targetAgentId)) fail("The owner's role cannot be changed", 'OWNER_ROLE')
  const { rows } = await q(
    'UPDATE team_members SET role = $1 WHERE team_id = $2 AND agent_id = $3 RETURNING *',
    [role, teamId, targetAgentId],
  )
  if (!rows[0]) fail('That agent is not on this team', 'NOT_MEMBER')
  return rows[0]
}

export async function updateMember(teamId, targetAgentId, fields = {}) {
  const sets = []
  const params = []
  if (fields.localities !== undefined) {
    params.push(JSON.stringify(Array.isArray(fields.localities) ? fields.localities : []))
    sets.push(`localities = $${params.length}`)
  }
  if (fields.accepts_leads !== undefined) {
    params.push(fields.accepts_leads ? 1 : 0)
    sets.push(`accepts_leads = $${params.length}`)
  }
  if (!sets.length) {
    return (await q('SELECT * FROM team_members WHERE team_id = $1 AND agent_id = $2', [teamId, targetAgentId])).rows[0]
  }
  params.push(teamId, targetAgentId)
  const { rows } = await q(
    `UPDATE team_members SET ${sets.join(', ')} WHERE team_id = $${params.length - 1} AND agent_id = $${params.length} RETURNING *`,
    params,
  )
  if (!rows[0]) fail('That agent is not on this team', 'NOT_MEMBER')
  return rows[0]
}

export async function removeMember(teamId, targetAgentId) {
  const team = await getTeamById(teamId)
  if (!team) fail('Team not found', 'NOT_FOUND')
  if (Number(team.owner_agent_id) === Number(targetAgentId)) {
    fail('The team owner cannot be removed — transfer ownership or delete the team', 'OWNER_REMOVE')
  }
  const { rowCount } = await q('DELETE FROM team_members WHERE team_id = $1 AND agent_id = $2', [teamId, targetAgentId])
  if (!rowCount) fail('That agent is not on this team', 'NOT_MEMBER')
  // Their leads leave the team scope but stay assigned to them.
  await q('UPDATE leads SET team_id = NULL WHERE team_id = $1 AND agent_id = $2', [teamId, targetAgentId])
  return true
}

// --- Lead assignment ---

// Members who accept leads, in stable order (round-robin / locality candidates).
async function assignableMembers(teamId) {
  return (
    await q('SELECT agent_id, localities FROM team_members WHERE team_id = $1 AND accepts_leads = 1 ORDER BY id', [
      teamId,
    ])
  ).rows
}

// Next member by round-robin. Advances the team cursor atomically so concurrent
// inbound messages don't hand the same member two leads in a row.
export async function pickRoundRobin(teamId) {
  const members = await assignableMembers(teamId)
  if (!members.length) return null
  const { rows } = await q(
    'UPDATE teams SET rr_cursor = rr_cursor + 1, updated_at = now() WHERE id = $1 RETURNING rr_cursor',
    [teamId],
  )
  return members[(rows[0].rr_cursor - 1) % members.length].agent_id
}

// Member whose localities overlap the lead's locality; falls back to round-robin.
async function pickByLocality(teamId, locality) {
  if (!locality) return pickRoundRobin(teamId)
  const loc = String(locality).toLowerCase().trim()
  const members = await assignableMembers(teamId)
  const match = members.find((m) =>
    (m.localities || []).some((x) => {
      const s = String(x).toLowerCase().trim()
      return s && (s.includes(loc) || loc.includes(s))
    }),
  )
  return match ? match.agent_id : pickRoundRobin(teamId)
}

// Assign (or reassign) a team lead to a member. Guards against cross-team leaks:
// only leads already tagged to this team can be moved.
export async function assignTeamLead(teamId, leadId, targetAgentId) {
  if (!(await isTeamMember(teamId, targetAgentId))) fail('That agent is not on this team', 'NOT_MEMBER')
  const { rows } = await q(
    `UPDATE leads SET agent_id = $1, team_id = $2, assigned_at = now(), updated_at = now()
     WHERE id = $3 AND team_id = $2 RETURNING *`,
    [targetAgentId, teamId, leadId],
  )
  return rows[0] || null
}

// Apply the team's configured strategy to route one lead. Returns the updated lead,
// or null for manual/pool strategies (which leave the lead for a human to place).
export async function autoAssignTeamLead(teamId, leadId, { locality = null } = {}) {
  const team = await getTeamById(teamId)
  if (!team) return null
  let target = null
  if (team.assignment_strategy === 'round_robin') target = await pickRoundRobin(teamId)
  else if (team.assignment_strategy === 'locality') target = await pickByLocality(teamId, locality)
  else return null
  return target ? assignTeamLead(teamId, leadId, target) : null
}

// Distribute every unclaimed lead in the team pool by the team's strategy. Returns
// how many were placed. For manual/pool strategies nothing is auto-placed.
// Previously this looped autoAssignTeamLead() per lead, which re-read the team, the
// member list and the membership check on every iteration — five queries per lead.
// The team and its members are the same for the whole batch, so they are read once;
// the round-robin cursor is advanced by the exact number of rotations needed in a
// single UPDATE; and the placements land in one UPDATE ... FROM unnest.
export async function distributeTeamPool(teamId) {
  const team = await getTeamById(teamId)
  if (!team || !['round_robin', 'locality'].includes(team.assignment_strategy)) return { assigned: 0 }
  const leads = (await q('SELECT id, locality FROM leads WHERE team_id = $1 AND agent_id IS NULL', [teamId])).rows
  if (!leads.length) return { assigned: 0 }

  const members = await assignableMembers(teamId)
  if (!members.length) return { assigned: 0 }

  // Pass 1: locality matches (locality strategy only). Everything unmatched falls
  // through to round-robin, exactly as pickByLocality() does per lead.
  const byLocality = (locality) => {
    if (!locality) return null
    const loc = String(locality).toLowerCase().trim()
    const match = members.find((m) =>
      (m.localities || []).some((x) => {
        const s = String(x).toLowerCase().trim()
        return s && (s.includes(loc) || loc.includes(s))
      }),
    )
    return match ? match.agent_id : null
  }

  const targets = new Map() // lead id -> agent id
  const rotate = [] // leads that need the round-robin cursor
  for (const lead of leads) {
    const direct = team.assignment_strategy === 'locality' ? byLocality(lead.locality) : null
    if (direct) targets.set(lead.id, direct)
    else rotate.push(lead)
  }

  // Advance the shared cursor once, by however many rotations this batch consumes,
  // so concurrent inbound routing can't be handed the same member we just used.
  if (rotate.length) {
    const { rows } = await q(
      'UPDATE teams SET rr_cursor = rr_cursor + $2, updated_at = now() WHERE id = $1 RETURNING rr_cursor',
      [teamId, rotate.length],
    )
    // The reserved block ends at the returned cursor, so the first lead in this
    // batch takes the same slot a per-lead loop would have given it.
    const end = rows[0].rr_cursor
    const start = end - rotate.length
    rotate.forEach((lead, i) => {
      targets.set(lead.id, members[(start + i) % members.length].agent_id)
    })
  }

  const ids = [...targets.keys()]
  const agents = ids.map((id) => targets.get(id))
  const { rowCount } = await q(
    `UPDATE leads SET agent_id = v.agent_id, team_id = $1, assigned_at = now(), updated_at = now()
     FROM unnest($2::int[], $3::int[]) AS v(id, agent_id)
     WHERE leads.id = v.id AND leads.team_id = $1`,
    [teamId, ids, agents],
  )
  return { assigned: rowCount }
}

// A member claims an unassigned lead from the shared team inbox.
export async function claimTeamLead(teamId, agentId, leadId) {
  if (!(await isTeamMember(teamId, agentId))) fail('You are not on this team', 'NOT_MEMBER')
  const { rows } = await q(
    `UPDATE leads SET agent_id = $1, assigned_at = now(), updated_at = now()
     WHERE id = $2 AND team_id = $3 AND agent_id IS NULL RETURNING *`,
    [agentId, leadId, teamId],
  )
  return rows[0] || null
}

// Which team member already owns a lead from this sender? Inbound routing uses
// this so a returning buyer stays with their agent instead of being re-shuffled
// by round-robin on every message.
// Ownership is resolved through team_members, not the denormalized leads.team_id:
// stampLeadTeam runs several awaits after the lead row is inserted, so a second
// message arriving inside that window would see team_id still NULL, miss the owner,
// and let round-robin hand the same sender to another member — creating a duplicate
// lead, because the UNIQUE key on leads is (agent_id, wa_id).
export async function teamLeadOwnerForWaId(teamId, waId) {
  return (
    await q(
      `SELECT l.agent_id FROM leads l
       JOIN team_members tm ON tm.agent_id = l.agent_id
       WHERE tm.team_id = $1 AND l.wa_id = $2
       ORDER BY l.id LIMIT 1`,
      [teamId, waId],
    )
  ).rows[0]?.agent_id ?? null
}

// Denormalize team_id onto a lead its agent owns. Called from the inbound path so
// a team member's new leads immediately show up in the team's manager views.
export async function stampLeadTeam(leadId, agentId) {
  const teamId = await agentTeamId(agentId)
  if (!teamId) return
  await q('UPDATE leads SET team_id = $1 WHERE id = $2 AND team_id IS DISTINCT FROM $1', [teamId, leadId])
}

// --- Manager views (privacy wall: these are gated to managers/owners in routes) ---

// Shared team inbox: every lead in the team, optionally filtered to one member,
// to the unassigned pool, or by stage/pipeline.
export async function teamLeads(
  teamId,
  { memberId = null, stage = '', pipelineType = '', unassigned = false, limit, offset } = {},
) {
  const where = ['l.team_id = $1']
  const params = [teamId]
  if (unassigned) where.push('l.agent_id IS NULL')
  else if (memberId) {
    params.push(memberId)
    where.push(`l.agent_id = $${params.length}`)
  }
  if (pipelineType) {
    params.push(pipelineType)
    where.push(`COALESCE(l.pipeline_type, 'buy_primary') = $${params.length}`)
  }
  if (stage) {
    params.push(stage)
    where.push(`COALESCE(l.stage, 'New') = $${params.length}`)
  }
  // Paged for the same reason the agent's own list is: a manager's view spans every
  // member of the team, so it is the larger of the two, not the smaller.
  params.push(pageLimit(limit))
  const limitParam = `$${params.length}`
  params.push(pageOffset(offset))
  const offsetParam = `$${params.length}`
  return (
    await q(
      `SELECT l.*, a.name AS agent_name, (l.agent_id IS NULL)::int AS unassigned,
              -- One lateral fetch of the last message, not two correlated subqueries
              -- reading two columns of the same row (same fix as listLeads).
              last.text AS last_msg,
              last.created_at AS last_at
       FROM leads l LEFT JOIN agents a ON a.id = l.agent_id
       LEFT JOIN LATERAL (
         SELECT m.text, m.created_at FROM messages m
          WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1
       ) last ON true
       WHERE ${where.join(' AND ')}
       ORDER BY l.updated_at DESC, l.id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    )
  ).rows
}

// Team pipeline: stage funnel across all members, plus each member's stage split
// and the size of the unassigned pool.
export async function teamPipeline(teamId, pipelineType = 'buy_primary') {
  const stages = await listPipelineStages(pipelineType)
  const dist = (
    await q(
      `SELECT COALESCE(stage, 'New') AS stage, COUNT(*)::int AS n
       FROM leads WHERE team_id = $1 AND COALESCE(pipeline_type, 'buy_primary') = $2
       GROUP BY COALESCE(stage, 'New')`,
      [teamId, pipelineType],
    )
  ).rows
  const byStage = Object.fromEntries(dist.map((r) => [r.stage, r.n]))
  const byMember = (
    await q(
      `SELECT l.agent_id, a.name, COALESCE(l.stage, 'New') AS stage, COUNT(*)::int AS n
       FROM leads l JOIN agents a ON a.id = l.agent_id
       WHERE l.team_id = $1 AND COALESCE(l.pipeline_type, 'buy_primary') = $2 AND l.agent_id IS NOT NULL
       GROUP BY l.agent_id, a.name, COALESCE(l.stage, 'New')`,
      [teamId, pipelineType],
    )
  ).rows
  const pooled = (await q('SELECT COUNT(*)::int AS n FROM leads WHERE team_id = $1 AND agent_id IS NULL', [teamId]))
    .rows[0].n
  return {
    pipeline_type: pipelineType,
    stages: stages.map((s) => ({ stage: s.stage_name, count: byStage[s.stage_name] || 0 })),
    by_member: byMember,
    pooled,
  }
}

// Response-time leaderboard: per member, first-response speed and lead outcomes.
// Ordered fastest-first; a member with no measured responses sorts last.
export async function teamLeaderboard(teamId) {
  return (
    await q(
      `SELECT tm.agent_id, a.name, tm.role,
              COUNT(l.id)::int AS total_leads,
              COUNT(l.id) FILTER (WHERE COALESCE(l.effective_temp, l.temp) = 'Hot')::int AS hot_leads,
              COUNT(l.id) FILTER (WHERE l.closed_at IS NOT NULL AND COALESCE(l.stage, '') <> 'Lost')::int AS won_leads,
              COUNT(l.id) FILTER (WHERE l.updated_at < now() - interval '3 days' AND l.closed_at IS NULL)::int AS stale_leads,
              AVG(l.first_response_s) FILTER (WHERE l.first_response_s IS NOT NULL) AS avg_first_response_s
       FROM team_members tm JOIN agents a ON a.id = tm.agent_id
       LEFT JOIN leads l ON l.agent_id = tm.agent_id AND l.team_id = $1
       WHERE tm.team_id = $1
       GROUP BY tm.agent_id, a.name, tm.role
       ORDER BY avg_first_response_s ASC NULLS LAST`,
      [teamId],
    )
  ).rows
}

// Stale leads across the team (idle longer than `days`, still open) for a manager
// to reassign. Ordered most-neglected first.
export async function teamStaleLeads(teamId, days = 3) {
  const d = Math.max(1, Number(days) || 3)
  return (
    await q(
      `SELECT l.*, a.name AS agent_name,
              EXTRACT(EPOCH FROM (now() - l.updated_at))::bigint AS idle_s
       FROM leads l LEFT JOIN agents a ON a.id = l.agent_id
       WHERE l.team_id = $1 AND l.closed_at IS NULL AND l.updated_at < now() - ($2::int * interval '1 day')
       ORDER BY l.updated_at ASC`,
      [teamId, d],
    )
  ).rows
}

export { pool, q as query }
export default pool
