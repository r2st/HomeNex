import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decayLead } from './scoring.js'
import { worklistItem, rankWorklist, worklistCounts } from './worklist.js'

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

// Canonical storage form for a WhatsApp number: leading "+" and digits only.
// A bare 10-digit Indian number is assumed to be +91.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '')
  if (d.startsWith('+')) d = '+' + d.slice(1).replace(/\D/g, '')
  else {
    d = d.replace(/\D/g, '')
    if (d.length === 10) d = '91' + d // default Indian country code
    d = '+' + d
  }
  return d
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
  'wa_phone_number_id, wa_phone_number, waba_status, waba_registered_at, meta_waba_id, is_admin, created_at'

export async function createAgent(name, phone, email, passwordHash, waPhoneNumber = null) {
  const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
  if (pn && pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid WhatsApp Business number')
  const { rows } = await q(
    `INSERT INTO agents (name, phone, email, password_hash, wa_phone_number, waba_status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, normalizePhone(phone), email ? email.toLowerCase() : null, passwordHash, pn, pn ? 'pending' : 'none'],
  )
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

export async function findAgentByEmail(email) {
  if (!email) return null
  const { rows } = await q('SELECT * FROM agents WHERE email = $1', [email.toLowerCase()])
  return rows[0] || null
}

// getAgent() deliberately omits password_hash; fetch it explicitly when re-authenticating.
export async function getAgentPasswordHash(agentId) {
  const { rows } = await q('SELECT password_hash FROM agents WHERE id = $1', [agentId])
  return rows[0]?.password_hash || null
}

export async function countAgents() {
  return (await q('SELECT COUNT(*) AS n FROM agents')).rows[0].n
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
// Matches on full digits, then on a 10-digit suffix as a fallback.
export async function findContactByWaId(waId) {
  const digits = phoneDigits(waId)
  if (!digits) return null
  const { rows: contacts } = await q('SELECT * FROM contacts')
  const exact = contacts.find((c) => phoneDigits(c.phone) === digits)
  if (exact) return exact
  const suffix = digits.slice(-10)
  return contacts.find((c) => phoneDigits(c.phone).slice(-10) === suffix) || null
}

// Look up a client row by phone (across all agents), used to decide whose list a number is in.
export async function getContactByPhone(phone) {
  const { rows } = await q('SELECT * FROM contacts WHERE phone = $1', [normalizePhone(phone)])
  return rows[0]
}

// List an agent's clients, annotated with whether that number has ever messaged.
// q searches name/phone (substring); source filters on how the contact was captured.
export async function listContacts(agentId, { search = '', source = '' } = {}) {
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
  const { rows } = await q(
    `SELECT c.*,
       (SELECT COUNT(*) FROM messages m
          JOIN leads l ON l.id = m.lead_id
          WHERE l.wa_id = replace(c.phone, '+', '') AND m.role = 'buyer') AS msg_count,
       (SELECT MAX(l.updated_at) FROM leads l
          WHERE l.wa_id = replace(c.phone, '+', '')) AS last_at
     FROM contacts c
     WHERE ${where.join(' AND ')}
     ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`,
    params,
  )
  return rows
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

// Bulk add. Returns { added, skipped: [{phone, reason}] }; never throws on a bad row.
export async function bulkAddContacts(agentId, rows) {
  const added = []
  const skipped = []
  for (const row of rows || []) {
    try {
      added.push(await addContact(agentId, row.phone, row.name, row.notes))
    } catch (err) {
      skipped.push({ phone: row.phone, name: row.name, reason: err.message })
    }
  }
  return { added, skipped }
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
  // A buyer message (re)opens the WhatsApp 24-hour service window.
  if (role === 'buyer') {
    await q('UPDATE leads SET last_inbound_at = now(), updated_at = now() WHERE id = $1', [leadId])
  } else {
    await q('UPDATE leads SET updated_at = now() WHERE id = $1', [leadId])
  }
  return rows[0]
}

// WhatsApp 24h service window state for a lead. The window opens on the last
// inbound (buyer) message; after 24h only template messages may be sent.
export function serviceWindow(lead) {
  if (!lead?.last_inbound_at) return { open: false, expires_at: null }
  const expires = new Date(new Date(lead.last_inbound_at).getTime() + 24 * 3600_000)
  return { open: expires.getTime() > Date.now(), expires_at: expires.toISOString() }
}

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
  await q(
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
     WHERE id = $16`,
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
}

export async function logActivity(agentId, leadId, kind, text) {
  await q('INSERT INTO activity (agent_id, lead_id, kind, text) VALUES ($1, $2, $3, $4)', [
    agentId,
    leadId,
    kind,
    text,
  ])
}

// The agent's own leads plus the shared unassigned pool. `unassigned` flags pool rows;
// `contact_name` is the client name from the agent's contacts, when the sender is known.
export async function listLeads(agentId, { pipelineType = '', stage = '' } = {}) {
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
  const { rows } = await q(
    `SELECT l.*,
       (l.agent_id IS NULL)::int AS unassigned,
       (SELECT c.name FROM contacts c
          WHERE c.agent_id = $1 AND replace(c.phone, '+', '') = l.wa_id LIMIT 1) AS contact_name,
       (SELECT text FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
       (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_role,
       (SELECT created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_at
     FROM leads l
     WHERE ${where.join(' AND ')}
     ORDER BY l.updated_at DESC`,
    params,
  )
  return rows
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
export async function updateAgentProfile(agentId, { name, email, phone, is_admin } = {}) {
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
      const clash = (await q('SELECT id FROM agents WHERE email = $1 AND id != $2', [e, agentId])).rows[0]
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
  if (is_admin !== undefined) {
    params.push(is_admin ? 1 : 0)
    updates.push(`is_admin = $${params.length}`)
  }
  if (!updates.length) return agent
  params.push(agentId)
  await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
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
  if (agent.wa_phone_number === phone) {
    const err = new Error('This is already your WhatsApp Business number — use a different personal number')
    err.code = 'WA_PHONE_CLASH'
    throw err
  }
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
      const clash = (await q('SELECT id FROM agents WHERE email = $1 AND id != $2', [email, agentId])).rows[0]
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
  await q(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${params.length}`, params)
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

export async function updateAgentPassword(agentId, passwordHash) {
  const { rowCount } = await q('UPDATE agents SET password_hash = $1 WHERE id = $2', [passwordHash, agentId])
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

export async function stats(agentId) {
  const TZ = await agentTimezone(agentId)
  const one = async (sql, params) => Object.values((await q(sql, params)).rows[0])[0]
  // Messages are scoped to the agent's leads.
  const myMessages = 'lead_id IN (SELECT id FROM leads WHERE agent_id = $1)'
  const total = await one('SELECT COUNT(*) FROM leads WHERE agent_id = $1', [agentId])
  const newToday = await one(
    `SELECT COUNT(*) FROM leads WHERE agent_id = $1
       AND created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
    [agentId, TZ],
  )
  const hotNow = await one(`SELECT COUNT(*) FROM leads WHERE agent_id = $1 AND temp = 'Hot'`, [agentId])
  const active24h = await one(
    `SELECT COUNT(DISTINCT lead_id) FROM messages WHERE ${myMessages} AND created_at >= now() - interval '1 day'`,
    [agentId],
  )
  const pipelineL =
    (await one(
      `SELECT COALESCE(SUM((budget_min_l + budget_max_l) / 2.0), 0) FROM leads
       WHERE agent_id = $1 AND temp != 'Cold' AND budget_max_l IS NOT NULL`,
      [agentId],
    )) || 0
  const avgFirstResponseS = await one('SELECT AVG(first_response_s) FROM leads WHERE agent_id = $1', [
    agentId,
  ])
  const qualified = await one(
    `SELECT COUNT(*) FROM leads WHERE agent_id = $1 AND locality IS NOT NULL
       AND timeline IS NOT NULL AND config IS NOT NULL AND budget_max_l IS NOT NULL`,
    [agentId],
  )
  const afterHours = await one(
    `SELECT COUNT(*) FROM leads
     WHERE agent_id = $1 AND (EXTRACT(HOUR FROM created_at AT TIME ZONE $2) >= 21
        OR EXTRACT(HOUR FROM created_at AT TIME ZONE $2) < 9)`,
    [agentId, TZ],
  )
  const sources = (
    await q(
      'SELECT source AS name, COUNT(*) AS count FROM leads WHERE agent_id = $1 GROUP BY source ORDER BY count DESC',
      [agentId],
    )
  ).rows
  const daily = (
    await q(
      `SELECT to_char((created_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
              AVG(first_response_s) AS avg_s, COUNT(*) AS leads
       FROM leads WHERE agent_id = $1 AND created_at >= now() - interval '7 days'
       GROUP BY day ORDER BY day`,
      [agentId, TZ],
    )
  ).rows
  const msgsToday = await one(
    `SELECT COUNT(*) FROM messages WHERE ${myMessages}
       AND created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`,
    [agentId, TZ],
  )
  return {
    total,
    newToday,
    hotNow,
    active24h,
    pipelineCr: pipelineL / 100,
    avgFirstResponseS,
    qualifiedPct: total ? Math.round((qualified / total) * 100) : 0,
    afterHours,
    sources,
    daily,
    msgsToday,
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
  return rows[0]
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

// Inventory listing with the dashboard's filter set. Prices are paise.
export async function listProperties(
  agentId,
  { status = '', propertyType = '', bhk = '', locality = '', city = '', minPrice = null, maxPrice = null, search = '' } = {},
) {
  const where = ['agent_id = $1']
  const params = [agentId]
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replace('?', `$${params.length}`))
  }
  if (status) add('status = ?', status)
  if (propertyType) add('property_type = ?', propertyType)
  if (bhk) add('bhk = ?', bhk)
  if (locality) add('locality ILIKE ?', `%${locality}%`)
  if (city) add('city ILIKE ?', `%${city}%`)
  if (minPrice != null) add('price_paise >= ?', minPrice)
  if (maxPrice != null) add('price_paise <= ?', maxPrice)
  if (search) {
    params.push(`%${search}%`)
    const n = `$${params.length}`
    where.push(`(title ILIKE ${n} OR locality ILIKE ${n} OR builder_name ILIKE ${n})`)
  }
  const { rows } = await q(
    `SELECT * FROM properties WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
    params,
  )
  return rows
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
export async function recordPropertyView(propertyId, referrer = null, leadId = null) {
  await q(
    'INSERT INTO property_page_views (property_id, referrer, lead_id) VALUES ($1, $2, $3)',
    [propertyId, referrer ? String(referrer).slice(0, 500) : null, leadId],
  )
  await q('UPDATE properties SET page_views = page_views + 1 WHERE id = $1', [propertyId])
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
     LEFT JOIN properties p ON p.id = v.property_id
     WHERE ${where.join(' AND ')}
     ORDER BY v.scheduled_at`,
    params,
  )
  return rows
}

export async function updateSiteVisit(id, agentId, fields) {
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
  return rows[0]
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

export async function listFollowups(agentId, { pendingOnly = false, leadId = null, today = false } = {}) {
  const where = ['f.agent_id = $1']
  const params = [agentId]
  if (pendingOnly) where.push('f.completed_at IS NULL')
  if (leadId) {
    params.push(leadId)
    where.push(`f.lead_id = $${params.length}`)
  }
  if (today) {
    // "Today" includes anything overdue — an agent must see slipped follow-ups too.
    params.push(await agentTimezone(agentId))
    where.push(`(f.due_at AT TIME ZONE $${params.length})::date <= (now() AT TIME ZONE $${params.length})::date`)
  }
  const { rows } = await q(
    `SELECT f.*, l.name AS lead_name, l.wa_id AS lead_wa_id,
       (f.completed_at IS NULL AND f.due_at < now())::int AS overdue
     FROM followups f
     JOIN leads l ON l.id = f.lead_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.completed_at NULLS FIRST, f.due_at`,
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

export async function createCommission(agentId, c) {
  if (!c.lead_id) throw new Error('lead_id is required')
  const { rows } = await q(
    `INSERT INTO commissions (lead_id, agent_id, deal_value_paise, commission_pct, commission_flat_paise,
                              payer_type, expected_payout_date, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      c.lead_id,
      agentId,
      c.deal_value_paise ?? null,
      c.commission_pct ?? null,
      c.commission_flat_paise ?? null,
      c.payer_type ?? null,
      c.expected_payout_date ?? null,
      c.status || 'expected',
      c.notes ?? null,
    ],
  )
  return rows[0]
}

export async function listCommissions(agentId, { status } = {}) {
  if (status) {
    return (
      await q('SELECT * FROM commissions WHERE agent_id = $1 AND status = $2 ORDER BY created_at DESC', [
        agentId,
        status,
      ])
    ).rows
  }
  return (await q('SELECT * FROM commissions WHERE agent_id = $1 ORDER BY created_at DESC', [agentId])).rows
}

export async function updateCommission(id, agentId, fields) {
  const { sets, params } = buildSet(
    {
      deal_value_paise: 'bigint',
      commission_pct: 'numeric',
      commission_flat_paise: 'bigint',
      payer_type: 'text',
      expected_payout_date: 'date',
      actual_payout_date: 'date',
      status: 'text',
      notes: 'text',
    },
    fields,
  )
  if (!sets.length)
    return (await q('SELECT * FROM commissions WHERE id = $1 AND agent_id = $2', [id, agentId])).rows[0]
  const { rows } = await q(
    `UPDATE commissions SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${params.length + 1} AND agent_id = $${params.length + 2} RETURNING *`,
    [...params, id, agentId],
  )
  return rows[0]
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
  // Unanswered: open leads whose most recent message is from the buyer,
  // oldest wait first. The client renders the age timer from last_at.
  const unanswered = (
    await q(
      `SELECT l.id, l.name, l.wa_id, l.temp, l.score, l.stage, l.pipeline_type,
              lm.text AS last_msg, lm.created_at AS last_at
       FROM leads l
       JOIN LATERAL (
         SELECT role, text, created_at FROM messages m
         WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1
       ) lm ON lm.role = 'buyer'
       WHERE l.agent_id = $1 AND l.closed_at IS NULL
       ORDER BY lm.created_at`,
      [agentId],
    )
  ).rows
  const hotLeads = (
    await q(
      `SELECT id, name, wa_id, score, stage, pipeline_type, ai_summary, next_step, updated_at
       FROM leads WHERE agent_id = $1 AND temp = 'Hot' AND closed_at IS NULL
       ORDER BY score DESC NULLS LAST, updated_at DESC LIMIT 10`,
      [agentId],
    )
  ).rows
  return {
    unanswered,
    followupsToday: await listFollowups(agentId, { pendingOnly: true, today: true }),
    siteVisitsToday: await listSiteVisits(agentId, { today: true }),
    hotLeads,
    activity: await listActivity(agentId, 20),
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
export async function leadEngagementSignals(leadId) {
  const { rows } = await q(
    `SELECT
       (SELECT MAX(created_at) FROM messages WHERE lead_id = $1 AND role = 'buyer') AS last_buyer_at,
       ARRAY(SELECT viewed_at FROM property_page_views WHERE lead_id = $1 ORDER BY viewed_at DESC LIMIT 50) AS page_views,
       ARRAY(SELECT scheduled_at FROM site_visits WHERE lead_id = $1) AS site_visits`,
    [leadId],
  )
  const r = rows[0] || {}
  return { lastBuyerAt: r.last_buyer_at, pageViews: r.page_views || [], siteVisits: r.site_visits || [] }
}

// Compute the decayed score for a lead without persisting (used by lead detail /
// briefing so those surfaces are always fresh).
export async function computeLeadDecay(lead, now = Date.now()) {
  const sig = await leadEngagementSignals(lead.id)
  return decayLead(lead, sig, now)
}

// Recompute and PERSIST a lead's engagement/effective score + temperature.
export async function recomputeLeadScore(leadId, now = Date.now()) {
  const lead = await getLead(leadId)
  if (!lead) return null
  const d = decayLead(lead, await leadEngagementSignals(leadId), now)
  await q(
    `UPDATE leads SET engagement_score = $2, effective_score = $3, effective_temp = $4,
       score_factors = $5, last_decay_at = now() WHERE id = $1`,
    [leadId, d.engagementScore, d.effectiveScore, d.temperature, JSON.stringify(d.factors)],
  )
  return d
}

// Recompute every non-closed lead for an agent (the twice-daily decay job, and
// called on-demand when the worklist is opened so its ranking is honest).
export async function recomputeAgentScores(agentId, now = Date.now()) {
  const { rows } = await q(
    'SELECT id FROM leads WHERE agent_id = $1 AND closed_at IS NULL',
    [agentId],
  )
  for (const { id } of rows) await recomputeLeadScore(id, now)
  return rows.length
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

  // 1. Service window closing within ~4h (highest priority; hard deadline).
  for (const l of (
    await q(
      `SELECT id, name, wa_id, last_inbound_at
       FROM leads WHERE agent_id = $1 AND closed_at IS NULL
         AND last_inbound_at IS NOT NULL
         AND last_inbound_at <= now() - interval '20 hours'
         AND last_inbound_at > now() - interval '24 hours'`,
      [agentId],
    )
  ).rows) {
    const hoursLeft = 24 - (Date.now() - new Date(l.last_inbound_at).getTime()) / 3600_000
    items.push(worklistItem('service_window_closing', {
      lead_id: l.id,
      title: l.name || l.wa_id,
      reason: `Free-reply window closes in ~${Math.max(1, Math.round(hoursLeft))}h — reply now or send a template.`,
      recencyAt: l.last_inbound_at,
    }))
  }

  // 2. Site visit within 48h, not yet confirmed.
  for (const v of (
    await q(
      `SELECT v.id, v.scheduled_at, l.id AS lead_id, l.name, l.wa_id, p.title
       FROM site_visits v JOIN leads l ON l.id = v.lead_id
       LEFT JOIN properties p ON p.id = v.property_id
       WHERE v.agent_id = $1 AND v.status = 'scheduled'
         AND v.scheduled_at BETWEEN now() AND now() + interval '48 hours'`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('site_visit_soon', {
      lead_id: v.lead_id, entity_type: 'site_visit', entity_id: v.id,
      title: v.name || v.wa_id,
      reason: `Site visit ${v.title ? `for ${v.title} ` : ''}coming up — confirm attendance, no-shows kill deals.`,
      recencyAt: v.scheduled_at,
    }))
  }

  // 3. Hot lead (post-decay) whose last message is from the buyer — waiting on you.
  for (const l of (
    await q(
      `SELECT l.id, l.name, l.wa_id, l.effective_score, lm.created_at AS last_at
       FROM leads l
       JOIN LATERAL (SELECT role, created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) lm ON lm.role = 'buyer'
       WHERE l.agent_id = $1 AND l.closed_at IS NULL AND l.effective_temp = 'Hot'`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('hot_lead_waiting', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: `Hot lead (score ${l.effective_score}) is waiting on your reply.`,
      recencyAt: l.last_at,
    }))
  }

  // 4. Overdue follow-ups.
  for (const f of (
    await q(
      `SELECT f.id, f.due_at, f.note, l.id AS lead_id, l.name, l.wa_id
       FROM followups f JOIN leads l ON l.id = f.lead_id
       WHERE f.agent_id = $1 AND f.completed_at IS NULL AND f.due_at < now()`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('overdue_followup', {
      lead_id: f.lead_id, entity_type: 'followup', entity_id: f.id,
      title: f.name || f.wa_id,
      reason: f.note ? `Overdue follow-up: ${f.note}` : 'Follow-up is overdue.',
      recencyAt: f.due_at,
    }))
  }

  // 5. Micro-page re-opened: 2+ attributed views in the last 24h.
  for (const l of (
    await q(
      `SELECT l.id, l.name, l.wa_id, COUNT(*)::int AS views, MAX(v.viewed_at) AS last_viewed
       FROM property_page_views v JOIN leads l ON l.id = v.lead_id
       WHERE l.agent_id = $1 AND l.closed_at IS NULL AND v.viewed_at >= now() - interval '24 hours'
       GROUP BY l.id, l.name, l.wa_id HAVING COUNT(*) >= 2`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('micro_page_reopened', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: `Re-opened a property page ${l.views}× in the last day — call while it's fresh.`,
      recencyAt: l.last_viewed,
    }))
  }

  // 6. Site visit completed 3+ days ago with no agent message since (deal dying).
  for (const l of (
    await q(
      `SELECT DISTINCT ON (l.id) l.id, l.name, l.wa_id, v.scheduled_at
       FROM site_visits v JOIN leads l ON l.id = v.lead_id
       WHERE v.agent_id = $1 AND v.status = 'completed' AND l.closed_at IS NULL
         AND v.scheduled_at < now() - interval '3 days'
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.role IN ('agent','ai')
             AND m.created_at > v.scheduled_at)
       ORDER BY l.id, v.scheduled_at DESC`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('site_visit_no_followup', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: 'Visited but you’ve gone quiet since — follow up before the deal cools.',
      recencyAt: l.scheduled_at,
    }))
  }

  // 7. Commission overdue.
  for (const c of (
    await q(
      `SELECT c.id, c.expected_payout_date, l.id AS lead_id, l.name, l.wa_id
       FROM commissions c JOIN leads l ON l.id = c.lead_id
       WHERE c.agent_id = $1 AND (c.status = 'overdue'
         OR (c.status = 'expected' AND c.expected_payout_date IS NOT NULL AND c.expected_payout_date < now()::date))`,
      [agentId],
    )
  ).rows) {
    items.push(worklistItem('commission_overdue', {
      lead_id: c.lead_id, entity_type: 'commission', entity_id: c.id,
      title: c.name || c.wa_id,
      reason: 'Brokerage is overdue — chase the payout.',
      recencyAt: c.expected_payout_date,
    }))
  }

  // 8. Stale lead: active pipeline, no message either way in 14 days, not Hot.
  const staleExclude = new Set(items.filter((i) => i.type === 'service_window_closing' || i.type === 'hot_lead_waiting').map((i) => i.lead_id))
  for (const l of (
    await q(
      `SELECT l.id, l.name, l.wa_id, l.stage,
              (SELECT MAX(created_at) FROM messages m WHERE m.lead_id = l.id) AS last_msg_at
       FROM leads l
       WHERE l.agent_id = $1 AND l.closed_at IS NULL
         AND COALESCE(l.stage, 'New') NOT IN ('Registered/Closed','Closed','Lost')
         AND COALESCE(l.effective_temp, l.temp) IS DISTINCT FROM 'Hot'
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.created_at >= now() - interval '14 days')`,
      [agentId],
    )
  ).rows) {
    if (staleExclude.has(l.id)) continue
    items.push(worklistItem('stale_lead', {
      lead_id: l.id, title: l.name || l.wa_id,
      reason: 'No contact in 2+ weeks — resurface with a new property or a check-in.',
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
  if (criteria.locality) {
    params.push(criteria.locality.toLowerCase())
    conds.push(`EXISTS (SELECT 1 FROM leads l WHERE replace(c.phone,'+','') = l.wa_id AND l.agent_id = c.agent_id
      AND (lower(l.locality) = $${params.length} OR l.preferred_localities::text ILIKE '%'||$${params.length}||'%'))`)
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
  let added = 0
  for (const cid of contactIds) {
    // Only insert contacts the agent actually owns; ignore duplicates.
    const r = await q(
      `INSERT INTO contact_group_members (group_id, contact_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM contacts WHERE id = $2 AND agent_id = $3)
       ON CONFLICT DO NOTHING`,
      [id, cid, agentId],
    )
    added += r.rowCount
  }
  return added
}

export async function removeGroupMember(id, agentId, contactId) {
  const group = await getGroup(id, agentId)
  if (!group) return false
  return (
    await q('DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2', [id, contactId])
  ).rowCount > 0
}

// One-click auto-grouping: scan the agent's leads, create a static group per
// distinct value (locality / intent / temperature), and populate it with the
// matching contacts. Idempotent — re-running tops up membership, never duplicates.
export async function autoGroupContacts(agentId, by) {
  const dimensions = {
    locality: { label: 'Locality', values: `SELECT DISTINCT l.locality AS v FROM leads l WHERE l.agent_id = $1 AND l.locality IS NOT NULL AND l.locality <> ''` },
    intent: { label: 'Intent', values: `SELECT DISTINCT l.intent AS v FROM leads l WHERE l.agent_id = $1 AND l.intent IS NOT NULL` },
    temp: { label: 'Temp', values: `SELECT DISTINCT COALESCE(l.effective_temp, l.temp) AS v FROM leads l WHERE l.agent_id = $1 AND COALESCE(l.effective_temp, l.temp) IS NOT NULL` },
  }
  const dim = dimensions[by]
  if (!dim) throw new Error('unknown grouping dimension')
  const values = (await q(dim.values, [agentId])).rows.map((r) => r.v).filter(Boolean)
  const groups = []
  for (const value of values) {
    const name = `${dim.label}: ${value}`
    let group = (await q('SELECT * FROM contact_groups WHERE agent_id = $1 AND name = $2', [agentId, name])).rows[0]
    if (!group) group = await createGroup(agentId, { name })
    const criteria = by === 'locality' ? { locality: value } : by === 'intent' ? { intent: value } : { temp: value }
    const contacts = await resolveSegment(agentId, criteria)
    if (contacts.length) await addGroupMembers(group.id, agentId, contacts.map((c) => c.id))
    groups.push({ ...group, member_count: contacts.length })
  }
  return groups
}

export { pool, q as query }
export default pool
