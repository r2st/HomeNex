import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(path.join(__dirname, process.env.DB_FILE || 'homenex.db'))
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
  wa_phone_number_id TEXT,           -- Meta phone_number_id, learned from the first inbound webhook
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

export function createAgent(name, phone, email, passwordHash) {
  const info = db
    .prepare('INSERT INTO agents (name, phone, email, password_hash) VALUES (?, ?, ?, ?)')
    .run(name, normalizePhone(phone), email ? email.toLowerCase() : null, passwordHash)
  return getAgent(info.lastInsertRowid)
}

export function getAgent(id) {
  return db
    .prepare('SELECT id, name, phone, email, wa_phone_number_id, created_at FROM agents WHERE id = ?')
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
