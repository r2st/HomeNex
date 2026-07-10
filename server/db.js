import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// COUNT()/BIGINT (paise) come back as JS numbers, not strings. Safe: 2^53 paise
// is ~90 trillion rupees. NUMERIC (commission_pct) likewise parses to a number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)))

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

// Digits only, for loose comparison against Meta's display_phone_number (which has no "+").
const phoneDigits = (raw) => String(raw || '').replace(/\D/g, '')

const AGENT_COLS =
  'id, name, phone, email, wa_phone_number_id, wa_phone_number, waba_status, waba_registered_at, meta_waba_id, is_admin, created_at'

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
export async function findAgentByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null
  // First try active WABA agents (the main production path).
  const active = (
    await q(`SELECT * FROM agents WHERE wa_phone_number_id = $1 AND waba_status = 'active'`, [phoneNumberId])
  ).rows[0]
  if (active) return active
  // Fallback: agents who manually configured phone_number_id (pre-WABA flow, backward compat).
  return (await q('SELECT * FROM agents WHERE wa_phone_number_id = $1', [phoneNumberId])).rows[0] || null
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
export async function listContacts(agentId) {
  const { rows } = await q(
    `SELECT c.*,
       (SELECT COUNT(*) FROM messages m
          JOIN leads l ON l.id = m.lead_id
          WHERE l.wa_id = replace(c.phone, '+', '') AND m.role = 'buyer') AS msg_count,
       (SELECT MAX(l.updated_at) FROM leads l
          WHERE l.wa_id = replace(c.phone, '+', '')) AS last_at
     FROM contacts c
     WHERE c.agent_id = $1
     ORDER BY c.created_at DESC`,
    [agentId],
  )
  return rows
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
  await q('UPDATE leads SET updated_at = now() WHERE id = $1', [leadId])
  return rows[0]
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
  await q(
    `UPDATE leads SET
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
export async function listLeads(agentId) {
  const { rows } = await q(
    `SELECT l.*,
       (l.agent_id IS NULL)::int AS unassigned,
       (SELECT c.name FROM contacts c
          WHERE c.agent_id = $1 AND replace(c.phone, '+', '') = l.wa_id LIMIT 1) AS contact_name,
       (SELECT text FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
       (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_role,
       (SELECT created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_at
     FROM leads l
     WHERE l.agent_id = $1 OR l.agent_id IS NULL
     ORDER BY l.updated_at DESC`,
    [agentId],
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

// Auto-promote the first agent to admin if no admins exist (lazy, on first admin-route hit).
export async function ensureAdminExists() {
  const hasAdmin = (await q('SELECT 1 FROM agents WHERE is_admin = 1 LIMIT 1')).rows[0]
  if (!hasAdmin) {
    const first = (await q('SELECT id FROM agents ORDER BY id LIMIT 1')).rows[0]
    if (first) {
      await q('UPDATE agents SET is_admin = 1 WHERE id = $1', [first.id])
      console.log(`Auto-promoted agent #${first.id} to admin (first agent)`)
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
export async function listAgentsAdmin({ search = '', status = '', page = 1, pageSize = 20 } = {}) {
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
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = (await q(`SELECT COUNT(*) AS n FROM agents a ${whereSql}`, params)).rows[0].n
  const size = Math.min(Math.max(1, Number(pageSize) || 20), 100)
  const p = Math.max(1, Number(page) || 1)
  const { rows: agents } = await q(
    `SELECT a.id, a.name, a.phone, a.email, a.wa_phone_number, a.wa_phone_number_id,
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

// Make an agent an admin (or revoke).
export async function setAdmin(agentId, isAdmin) {
  await q('UPDATE agents SET is_admin = $1 WHERE id = $2', [isAdmin ? 1 : 0, agentId])
  return getAgent(agentId)
}

// Dashboard stats. Day boundaries use Asia/Kolkata — HomeNex targets Indian agents.
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata'

export async function stats(agentId) {
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

export async function createProperty(agentId, p) {
  if (!p.title || !String(p.title).trim()) throw new Error('Property title is required')
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

export async function listProperties(agentId, { status } = {}) {
  if (status) {
    return (
      await q('SELECT * FROM properties WHERE agent_id = $1 AND status = $2 ORDER BY updated_at DESC', [
        agentId,
        status,
      ])
    ).rows
  }
  return (await q('SELECT * FROM properties WHERE agent_id = $1 ORDER BY updated_at DESC', [agentId])).rows
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
  const res = await q('DELETE FROM properties WHERE id = $1 AND agent_id = $2', [id, agentId])
  return res.rowCount > 0
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

export async function listSiteVisits(agentId, { leadId } = {}) {
  if (leadId) {
    return (
      await q('SELECT * FROM site_visits WHERE agent_id = $1 AND lead_id = $2 ORDER BY scheduled_at', [
        agentId,
        leadId,
      ])
    ).rows
  }
  return (await q('SELECT * FROM site_visits WHERE agent_id = $1 ORDER BY scheduled_at', [agentId])).rows
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

export async function listFollowups(agentId, { pendingOnly = false } = {}) {
  const where = pendingOnly ? 'AND completed_at IS NULL' : ''
  return (await q(`SELECT * FROM followups WHERE agent_id = $1 ${where} ORDER BY due_at`, [agentId])).rows
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

export { pool, q as query }
export default pool
