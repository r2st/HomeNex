import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbFile = process.env.DB_FILE || 'homenex.db'
const db = new DatabaseSync(path.isAbsolute(dbFile) ? dbFile : path.join(__dirname, dbFile))
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER REFERENCES agents(id),   -- NULL = unassigned pool (unknown sender on the shared number)
  wa_id TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  source TEXT DEFAULT 'WhatsApp',
  temp TEXT DEFAULT 'Cold',
  score INTEGER DEFAULT 0,
  config TEXT,
  config_note TEXT,
  locality TEXT,
  location_note TEXT,
  budget_min_l REAL,
  budget_max_l REAL,
  budget_note TEXT,
  timeline TEXT,
  timeline_note TEXT,
  ai_summary TEXT,
  next_step TEXT,
  score_breakdown TEXT,
  ai_enabled INTEGER DEFAULT 1,
  first_response_s REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(agent_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL CHECK (role IN ('buyer','ai','agent')),
  text TEXT NOT NULL,
  wa_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  lead_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id, id);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,        -- WhatsApp number, canonical E.164 e.g. +919812345678
  email TEXT,                        -- optional
  password_hash TEXT NOT NULL,
  wa_phone_number_id TEXT,           -- Meta phone_number_id for the agent's own WhatsApp Business line
  wa_phone_number TEXT,              -- display phone number for the agent's WA Business line, E.164
  waba_status TEXT DEFAULT 'none',   -- none | pending | registered | active
  waba_registered_at TEXT,           -- datetime when WABA registration completed
  meta_waba_id TEXT,                 -- Meta WABA (WhatsApp Business Account) ID
  is_admin INTEGER DEFAULT 0,        -- 1 = admin user
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Clients an agent owns on the shared WhatsApp Business number. When one of these
-- numbers messages the shared line, the inbound is routed to this agent.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  phone TEXT NOT NULL UNIQUE,        -- client's WhatsApp number, canonical E.164 e.g. +919812345678
  name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent_id, created_at);

CREATE TABLE IF NOT EXISTS network_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('INVENTORY','REQUIREMENT')),
  broker TEXT NOT NULL,
  firm TEXT,
  text TEXT NOT NULL,
  config TEXT,
  locality TEXT,
  budget_min_l REAL,
  budget_max_l REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
`)

// Migration: older DBs created leads.agent_id as NOT NULL. The shared-number model
// needs it nullable so unknown senders can land in an unassigned pool. Rebuild the
// table in place (same columns/order) if the NOT NULL constraint is still present.
//
// legacy_alter_table = ON is essential: without it, renaming/dropping `leads` makes
// SQLite rewrite the foreign-key reference in `messages` to point at the temp table,
// which then breaks every INSERT into messages. We also repair any DB already damaged
// that way by rebuilding messages with a correct FK.
{
  const tableSql = (name) =>
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql || ''
  const agentCol = db.prepare('PRAGMA table_info(leads)').all().find((c) => c.name === 'agent_id')
  const leadsNeedsRebuild = agentCol && agentCol.notnull === 1
  const messagesBroken = /leads_old/.test(tableSql('messages'))

  if (leadsNeedsRebuild || messagesBroken) {
    // FK enforcement (on by default in node:sqlite) and reference-rewriting must both be
    // off while we swap tables; must be set outside the transaction to take effect.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('PRAGMA legacy_alter_table = ON')
    db.exec('BEGIN')
    try {
      if (leadsNeedsRebuild) {
        db.exec(`
          CREATE TABLE leads_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER REFERENCES agents(id),
            wa_id TEXT NOT NULL,
            name TEXT,
            phone TEXT,
            source TEXT DEFAULT 'WhatsApp',
            temp TEXT DEFAULT 'Cold',
            score INTEGER DEFAULT 0,
            config TEXT,
            config_note TEXT,
            locality TEXT,
            location_note TEXT,
            budget_min_l REAL,
            budget_max_l REAL,
            budget_note TEXT,
            timeline TEXT,
            timeline_note TEXT,
            ai_summary TEXT,
            next_step TEXT,
            score_breakdown TEXT,
            ai_enabled INTEGER DEFAULT 1,
            first_response_s REAL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(agent_id, wa_id)
          )`)
        db.exec('INSERT INTO leads_new SELECT * FROM leads')
        db.exec('DROP TABLE leads')
        db.exec('ALTER TABLE leads_new RENAME TO leads')
        db.exec('CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(agent_id, updated_at)')
      }
      if (messagesBroken) {
        db.exec(`
          CREATE TABLE messages_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER NOT NULL REFERENCES leads(id),
            role TEXT NOT NULL CHECK (role IN ('buyer','ai','agent')),
            text TEXT NOT NULL,
            wa_message_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )`)
        db.exec('INSERT INTO messages_new SELECT * FROM messages')
        db.exec('DROP TABLE messages')
        db.exec('ALTER TABLE messages_new RENAME TO messages')
        db.exec('CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id)')
      }
      db.exec('COMMIT')
      console.log('migrated schema for shared-number model (leads nullable / messages FK repaired)')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    } finally {
      db.exec('PRAGMA legacy_alter_table = OFF')
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
}

// Migration: add wa_phone_number column to agents for per-agent WhatsApp Business numbers.
{
  const cols = db.prepare('PRAGMA table_info(agents)').all()
  if (!cols.some((c) => c.name === 'wa_phone_number')) {
    db.exec('ALTER TABLE agents ADD COLUMN wa_phone_number TEXT')
    console.log('migrated agents: added wa_phone_number column')
  }
}

// Migration: add WABA registration fields to agents.
{
  const cols = db.prepare('PRAGMA table_info(agents)').all()
  const colNames = cols.map((c) => c.name)
  if (!colNames.includes('waba_status')) {
    db.exec("ALTER TABLE agents ADD COLUMN waba_status TEXT DEFAULT 'none'")
    console.log('migrated agents: added waba_status column')
  }
  if (!colNames.includes('waba_registered_at')) {
    db.exec('ALTER TABLE agents ADD COLUMN waba_registered_at TEXT')
    console.log('migrated agents: added waba_registered_at column')
  }
  if (!colNames.includes('meta_waba_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN meta_waba_id TEXT')
    console.log('migrated agents: added meta_waba_id column')
  }
  if (!colNames.includes('is_admin')) {
    db.exec('ALTER TABLE agents ADD COLUMN is_admin INTEGER DEFAULT 0')
    console.log('migrated agents: added is_admin column')
  }
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

export function createAgent(name, phone, email, passwordHash, waPhoneNumber = null) {
  const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
  if (pn && pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid WhatsApp Business number')
  const info = db
    .prepare('INSERT INTO agents (name, phone, email, password_hash, wa_phone_number, waba_status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, normalizePhone(phone), email ? email.toLowerCase() : null, passwordHash, pn, pn ? 'pending' : 'none')
  return getAgent(info.lastInsertRowid)
}

export function getAgent(id) {
  return db
    .prepare('SELECT id, name, phone, email, wa_phone_number_id, wa_phone_number, waba_status, waba_registered_at, meta_waba_id, is_admin, created_at FROM agents WHERE id = ?')
    .get(id)
}

export function findAgentByPhone(phone) {
  return db.prepare('SELECT * FROM agents WHERE phone = ?').get(normalizePhone(phone))
}

export function findAgentByEmail(email) {
  if (!email) return null
  return db.prepare('SELECT * FROM agents WHERE email = ?').get(email.toLowerCase())
}

export function countAgents() {
  return db.prepare('SELECT COUNT(*) AS n FROM agents').get().n
}

// Update an agent's per-agent WhatsApp Business number configuration.
// waPhoneNumber is the display number (E.164), waPhoneNumberId is the Meta API phone_number_id.
// Either or both can be null to clear the configuration.
export function updateAgentPhoneConfig(agentId, waPhoneNumber, waPhoneNumberId) {
  const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
  if (pn && pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid WhatsApp Business number')
  // Ensure wa_phone_number_id is unique across agents (two agents can't share the same line).
  if (waPhoneNumberId) {
    const existing = db
      .prepare('SELECT id FROM agents WHERE wa_phone_number_id = ? AND id != ?')
      .get(waPhoneNumberId, agentId)
    if (existing) {
      const err = new Error('This WhatsApp Business number ID is already assigned to another agent')
      err.code = 'PHONE_ID_TAKEN'
      throw err
    }
  }
  db.prepare('UPDATE agents SET wa_phone_number = ?, wa_phone_number_id = ? WHERE id = ?')
    .run(pn, waPhoneNumberId || null, agentId)
  return getAgent(agentId)
}

// Find the agent who owns a specific Meta phone_number_id. Used for inbound webhook routing:
// when a message arrives on a specific WhatsApp Business line, route it to the agent who owns it.
// Only returns agents whose WABA status is 'active' — pending/registered numbers aren't live yet.
export function findAgentByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null
  // First try active WABA agents (the main production path).
  const active = db.prepare("SELECT * FROM agents WHERE wa_phone_number_id = ? AND waba_status = 'active'").get(phoneNumberId)
  if (active) return active
  // Fallback: agents who manually configured phone_number_id (pre-WABA flow, backward compat).
  return db.prepare('SELECT * FROM agents WHERE wa_phone_number_id = ?').get(phoneNumberId) || null
}

// --- Contacts: the agent's known clients on the shared WhatsApp number ---

// Shared number routing: find which agent owns an inbound sender's number.
// Matches on full digits, then on a 10-digit suffix as a fallback.
export function findContactByWaId(waId) {
  const digits = phoneDigits(waId)
  if (!digits) return null
  const contacts = db.prepare('SELECT * FROM contacts').all()
  const exact = contacts.find((c) => phoneDigits(c.phone) === digits)
  if (exact) return exact
  const suffix = digits.slice(-10)
  return contacts.find((c) => phoneDigits(c.phone).slice(-10) === suffix) || null
}

// Look up a client row by phone (across all agents), used to decide whose list a number is in.
export function getContactByPhone(phone) {
  return db.prepare('SELECT * FROM contacts WHERE phone = ?').get(normalizePhone(phone))
}

// List an agent's clients, annotated with whether that number has ever messaged.
export function listContacts(agentId) {
  return db
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM messages m
            JOIN leads l ON l.id = m.lead_id
            WHERE l.wa_id = replace(c.phone, '+', '') AND m.role = 'buyer') AS msg_count,
         (SELECT MAX(l.updated_at) FROM leads l
            WHERE l.wa_id = replace(c.phone, '+', '')) AS last_at
       FROM contacts c
       WHERE c.agent_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(agentId)
}

// Add one client. Throws on a phone already claimed (by any agent — UNIQUE(phone)).
export function addContact(agentId, phone, name, notes = null) {
  const p = normalizePhone(phone)
  if (p.replace(/\D/g, '').length < 10) throw new Error('Enter a valid phone number')
  if (!name || !String(name).trim()) throw new Error('Client name is required')
  const existing = db.prepare('SELECT agent_id FROM contacts WHERE phone = ?').get(p)
  if (existing) {
    const err = new Error(
      existing.agent_id === agentId
        ? 'This client is already in your list'
        : 'This number is already claimed by another agent',
    )
    err.code = 'CONTACT_EXISTS'
    throw err
  }
  const info = db
    .prepare('INSERT INTO contacts (agent_id, phone, name, notes) VALUES (?, ?, ?, ?)')
    .run(agentId, p, String(name).trim(), notes ? String(notes).trim() : null)
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid)
}

// Bulk add. Returns { added, skipped: [{phone, reason}] }; never throws on a bad row.
export function bulkAddContacts(agentId, rows) {
  const added = []
  const skipped = []
  for (const row of rows || []) {
    try {
      added.push(addContact(agentId, row.phone, row.name, row.notes))
    } catch (err) {
      skipped.push({ phone: row.phone, name: row.name, reason: err.message })
    }
  }
  return { added, skipped }
}

export function deleteContact(id, agentId) {
  return db.prepare('DELETE FROM contacts WHERE id = ? AND agent_id = ?').run(id, agentId).changes > 0
}

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
}

export function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function upsertLead(agentId, waId, name) {
  db.prepare(
    `INSERT INTO leads (agent_id, wa_id, name, phone) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, wa_id) DO UPDATE SET
       name = COALESCE(excluded.name, leads.name),
       updated_at = datetime('now')`,
  ).run(agentId, waId, name || null, waId)
  return db.prepare('SELECT * FROM leads WHERE agent_id = ? AND wa_id = ?').get(agentId, waId)
}

// Unassigned pool: a message from an unknown sender on the shared number. Deduped by
// wa_id among the NULL-agent rows (UNIQUE(agent_id,wa_id) does not cover NULLs in SQLite).
export function upsertUnassignedLead(waId, name) {
  const existing = db.prepare('SELECT * FROM leads WHERE agent_id IS NULL AND wa_id = ?').get(waId)
  if (existing) {
    db.prepare(
      "UPDATE leads SET name = COALESCE(?, name), updated_at = datetime('now') WHERE id = ?",
    ).run(name || null, existing.id)
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(existing.id)
  }
  const info = db
    .prepare("INSERT INTO leads (agent_id, wa_id, name, phone, source) VALUES (NULL, ?, ?, ?, 'WhatsApp')")
    .run(waId, name || null, waId)
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid)
}

// Claim an unassigned lead. Only succeeds while the lead is still in the pool.
export function assignLead(leadId, agentId) {
  const changed = db
    .prepare('UPDATE leads SET agent_id = ? WHERE id = ? AND agent_id IS NULL').run(agentId, leadId).changes
  return changed > 0 ? getLead(leadId) : null
}

export function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
}

// Ownership-checked lookup for dashboard routes: only returns the lead if it belongs to the agent.
export function getLeadForAgent(id, agentId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND agent_id = ?').get(id, agentId)
}

// Like getLeadForAgent, but also returns unassigned-pool leads so any agent can inspect/claim them.
export function getAssignableLead(id, agentId) {
  return db
    .prepare('SELECT * FROM leads WHERE id = ? AND (agent_id = ? OR agent_id IS NULL)')
    .get(id, agentId)
}

export function addMessage(leadId, role, text, waMessageId = null) {
  const info = db
    .prepare('INSERT INTO messages (lead_id, role, text, wa_message_id) VALUES (?, ?, ?, ?)')
    .run(leadId, role, text, waMessageId)
  db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(leadId)
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
}

export function getMessages(leadId, limit = 200) {
  return db
    .prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id LIMIT ?')
    .all(leadId, limit)
}

export function recordFirstResponse(leadId) {
  const lead = getLead(leadId)
  if (!lead || lead.first_response_s != null) return
  const row = db
    .prepare(
      `SELECT
         (SELECT MIN(created_at) FROM messages WHERE lead_id = ? AND role = 'buyer') AS first_in,
         (SELECT MIN(created_at) FROM messages WHERE lead_id = ? AND role IN ('ai','agent')) AS first_out`,
    )
    .get(leadId, leadId)
  if (!row.first_in || !row.first_out) return
  const s =
    (new Date(row.first_out + 'Z').getTime() - new Date(row.first_in + 'Z').getTime()) / 1000
  db.prepare('UPDATE leads SET first_response_s = ? WHERE id = ?').run(Math.max(s, 0), leadId)
}

export function applyExtraction(leadId, x) {
  db.prepare(
    `UPDATE leads SET
       name = COALESCE(?, name),
       temp = COALESCE(?, temp),
       score = COALESCE(?, score),
       config = COALESCE(?, config),
       config_note = COALESCE(?, config_note),
       locality = COALESCE(?, locality),
       location_note = COALESCE(?, location_note),
       budget_min_l = COALESCE(?, budget_min_l),
       budget_max_l = COALESCE(?, budget_max_l),
       budget_note = COALESCE(?, budget_note),
       timeline = COALESCE(?, timeline),
       timeline_note = COALESCE(?, timeline_note),
       ai_summary = COALESCE(?, ai_summary),
       next_step = COALESCE(?, next_step),
       score_breakdown = COALESCE(?, score_breakdown),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
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
  )
}

export function logActivity(agentId, leadId, kind, text) {
  db.prepare('INSERT INTO activity (agent_id, lead_id, kind, text) VALUES (?, ?, ?, ?)').run(
    agentId,
    leadId,
    kind,
    text,
  )
}

// The agent's own leads plus the shared unassigned pool. `unassigned` flags pool rows;
// `contact_name` is the client name from the agent's contacts, when the sender is known.
export function listLeads(agentId) {
  return db
    .prepare(
      `SELECT l.*,
         (l.agent_id IS NULL) AS unassigned,
         (SELECT c.name FROM contacts c
            WHERE c.agent_id = ? AND replace(c.phone, '+', '') = l.wa_id LIMIT 1) AS contact_name,
         (SELECT text FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
         (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_role,
         (SELECT created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM leads l
       WHERE l.agent_id = ? OR l.agent_id IS NULL
       ORDER BY l.updated_at DESC`,
    )
    .all(agentId, agentId)
}

export function listActivity(agentId, limit = 30) {
  return db
    .prepare('SELECT * FROM activity WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
    .all(agentId, limit)
}

export function setAiEnabled(leadId, enabled) {
  db.prepare('UPDATE leads SET ai_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, leadId)
}

export function listNetworkPosts() {
  return db.prepare('SELECT * FROM network_posts ORDER BY id DESC LIMIT 50').all()
}

export function addNetworkPost(p) {
  const info = db
    .prepare(
      `INSERT INTO network_posts (type, broker, firm, text, config, locality, budget_min_l, budget_max_l)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.type,
      p.broker,
      p.firm ?? null,
      p.text,
      p.config ?? null,
      p.locality ?? null,
      p.budget_min_l ?? null,
      p.budget_max_l ?? null,
    )
  return db.prepare('SELECT * FROM network_posts WHERE id = ?').get(info.lastInsertRowid)
}

// Real matching: your qualified buyers x posted inventory, on locality + config + budget overlap.
export function computeMatches(agentId) {
  const leads = db
    .prepare("SELECT * FROM leads WHERE agent_id = ? AND locality IS NOT NULL AND temp != 'Cold'")
    .all(agentId)
  const inventory = db.prepare("SELECT * FROM network_posts WHERE type = 'INVENTORY'").all()
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
export function listAllAgents() {
  return db
    .prepare(
      `SELECT id, name, phone, email, wa_phone_number, wa_phone_number_id,
              waba_status, waba_registered_at, meta_waba_id, is_admin, created_at
       FROM agents ORDER BY created_at DESC`,
    )
    .all()
}

// Update an agent's WABA registration status (admin action).
// status must be one of: none, pending, registered, active.
export function updateWabaStatus(agentId, { status, metaWabaId, waPhoneNumberId, waPhoneNumber }) {
  const valid = ['none', 'pending', 'registered', 'active']
  if (!valid.includes(status)) throw new Error(`Invalid WABA status: ${status}`)

  const agent = getAgent(agentId)
  if (!agent) throw new Error('Agent not found')

  const updates = ['waba_status = ?']
  const params = [status]

  // Set registered_at when transitioning to 'registered' or 'active'
  if ((status === 'registered' || status === 'active') && !agent.waba_registered_at) {
    updates.push("waba_registered_at = datetime('now')")
  }
  // Clear registered_at when going back to 'none' or 'pending'
  if (status === 'none' || status === 'pending') {
    updates.push('waba_registered_at = NULL')
  }

  if (metaWabaId !== undefined) {
    updates.push('meta_waba_id = ?')
    params.push(metaWabaId || null)
  }
  if (waPhoneNumberId !== undefined) {
    updates.push('wa_phone_number_id = ?')
    params.push(waPhoneNumberId || null)
  }
  if (waPhoneNumber !== undefined) {
    const pn = waPhoneNumber ? normalizePhone(waPhoneNumber) : null
    updates.push('wa_phone_number = ?')
    params.push(pn)
  }

  params.push(agentId)
  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return getAgent(agentId)
}

// Admin dashboard stats.
export function adminStats() {
  const one = (sql) => Object.values(db.prepare(sql).get())[0]
  return {
    totalAgents: one('SELECT COUNT(*) FROM agents'),
    newAgents7d: one("SELECT COUNT(*) FROM agents WHERE created_at >= datetime('now', '-7 days')"),
    newAgents30d: one("SELECT COUNT(*) FROM agents WHERE created_at >= datetime('now', '-30 days')"),
    noneWaba: one("SELECT COUNT(*) FROM agents WHERE waba_status = 'none' OR waba_status IS NULL"),
    pendingWaba: one("SELECT COUNT(*) FROM agents WHERE waba_status = 'pending'"),
    registeredWaba: one("SELECT COUNT(*) FROM agents WHERE waba_status = 'registered'"),
    activeWaba: one("SELECT COUNT(*) FROM agents WHERE waba_status = 'active'"),
    totalLeads: one('SELECT COUNT(*) FROM leads'),
    totalContacts: one('SELECT COUNT(*) FROM contacts'),
    // A conversation is "active" when the lead exchanged at least one message in the last 24h.
    activeConversations: one(
      "SELECT COUNT(DISTINCT lead_id) FROM messages WHERE created_at >= datetime('now', '-1 day')",
    ),
  }
}

// Paginated, searchable agent listing for the admin site.
// search matches name/email/phone (substring); status filters on waba_status.
export function listAgentsAdmin({ search = '', status = '', page = 1, pageSize = 20 } = {}) {
  const where = []
  const params = {}
  if (search) {
    where.push('(a.name LIKE @q OR a.email LIKE @q OR a.phone LIKE @q OR a.wa_phone_number LIKE @q)')
    params.q = `%${search}%`
  }
  if (status) {
    where.push("COALESCE(a.waba_status, 'none') = @status")
    params.status = status
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM agents a ${whereSql}`).get(params).n
  const size = Math.min(Math.max(1, Number(pageSize) || 20), 100)
  const p = Math.max(1, Number(page) || 1)
  const agents = db
    .prepare(
      `SELECT a.id, a.name, a.phone, a.email, a.wa_phone_number, a.wa_phone_number_id,
              a.waba_status, a.waba_registered_at, a.meta_waba_id, a.is_admin, a.created_at,
              (SELECT MAX(created_at) FROM activity WHERE agent_id = a.id) AS last_active,
              (SELECT COUNT(*) FROM leads l WHERE l.agent_id = a.id) AS lead_count
       FROM agents a ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: size, offset: (p - 1) * size })
  return { agents, total, page: p, pageSize: size, totalPages: Math.max(1, Math.ceil(total / size)) }
}

// Full agent profile for the admin detail view: counts + recent activity.
export function getAgentDetail(id) {
  const agent = getAgent(id)
  if (!agent) return null
  const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0]
  return {
    ...agent,
    lead_count: one('SELECT COUNT(*) FROM leads WHERE agent_id = ?', id),
    contact_count: one('SELECT COUNT(*) FROM contacts WHERE agent_id = ?', id),
    message_count: one(
      'SELECT COUNT(*) FROM messages WHERE lead_id IN (SELECT id FROM leads WHERE agent_id = ?)',
      id,
    ),
    last_active: one('SELECT MAX(created_at) FROM activity WHERE agent_id = ?', id),
    recent_activity: db
      .prepare('SELECT * FROM activity WHERE agent_id = ? ORDER BY id DESC LIMIT 15')
      .all(id),
  }
}

// Admin edit of an agent's profile. Only provided fields are changed.
export function updateAgentProfile(agentId, { name, email, phone, is_admin } = {}) {
  const agent = getAgent(agentId)
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
    updates.push('name = ?')
    params.push(n)
  }
  if (email !== undefined) {
    const e = String(email || '').trim().toLowerCase() || null
    if (e && !/^\S+@\S+\.\S+$/.test(e)) throw new Error('Enter a valid email address')
    if (e) {
      const clash = db.prepare('SELECT id FROM agents WHERE email = ? AND id != ?').get(e, agentId)
      if (clash) {
        const err = new Error('Another agent already uses this email')
        err.code = 'EMAIL_TAKEN'
        throw err
      }
    }
    updates.push('email = ?')
    params.push(e)
  }
  if (phone !== undefined) {
    const pn = normalizePhone(phone)
    if (pn.replace(/\D/g, '').length < 10) throw new Error('Enter a valid phone number')
    const clash = db.prepare('SELECT id FROM agents WHERE phone = ? AND id != ?').get(pn, agentId)
    if (clash) {
      const err = new Error('Another agent already uses this phone number')
      err.code = 'PHONE_TAKEN'
      throw err
    }
    updates.push('phone = ?')
    params.push(pn)
  }
  if (is_admin !== undefined) {
    updates.push('is_admin = ?')
    params.push(is_admin ? 1 : 0)
  }
  if (!updates.length) return agent
  params.push(agentId)
  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return getAgent(agentId)
}

// Make an agent an admin (or revoke).
export function setAdmin(agentId, isAdmin) {
  db.prepare('UPDATE agents SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, agentId)
  return getAgent(agentId)
}

export function stats(agentId) {
  const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0]
  // Messages are scoped to the agent's leads.
  const myMessages = 'lead_id IN (SELECT id FROM leads WHERE agent_id = @a)'
  const total = one('SELECT COUNT(*) FROM leads WHERE agent_id = @a', { a: agentId })
  const newToday = one(
    "SELECT COUNT(*) FROM leads WHERE agent_id = @a AND created_at >= datetime('now', 'start of day')",
    { a: agentId },
  )
  const hotNow = one("SELECT COUNT(*) FROM leads WHERE agent_id = @a AND temp = 'Hot'", { a: agentId })
  const active24h = one(
    `SELECT COUNT(DISTINCT lead_id) FROM messages WHERE ${myMessages} AND created_at >= datetime('now', '-1 day')`,
    { a: agentId },
  )
  const pipelineL =
    one(
      "SELECT COALESCE(SUM((budget_min_l + budget_max_l) / 2.0), 0) FROM leads WHERE agent_id = @a AND temp != 'Cold' AND budget_max_l IS NOT NULL",
      { a: agentId },
    ) || 0
  const avgFirstResponseS = one('SELECT AVG(first_response_s) FROM leads WHERE agent_id = @a', {
    a: agentId,
  })
  const qualified = one(
    'SELECT COUNT(*) FROM leads WHERE agent_id = @a AND locality IS NOT NULL AND timeline IS NOT NULL AND config IS NOT NULL AND budget_max_l IS NOT NULL',
    { a: agentId },
  )
  const afterHours = one(
    `SELECT COUNT(*) FROM leads
     WHERE agent_id = @a AND (CAST(strftime('%H', created_at, 'localtime') AS INTEGER) >= 21
        OR CAST(strftime('%H', created_at, 'localtime') AS INTEGER) < 9)`,
    { a: agentId },
  )
  const sources = db
    .prepare(
      'SELECT source AS name, COUNT(*) AS count FROM leads WHERE agent_id = @a GROUP BY source ORDER BY count DESC',
    )
    .all({ a: agentId })
  const daily = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS day, AVG(first_response_s) AS avg_s, COUNT(*) AS leads
       FROM leads WHERE agent_id = @a AND created_at >= datetime('now', '-7 days')
       GROUP BY day ORDER BY day`,
    )
    .all({ a: agentId })
  const msgsToday = one(
    `SELECT COUNT(*) FROM messages WHERE ${myMessages} AND created_at >= datetime('now', 'start of day')`,
    { a: agentId },
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

export default db
