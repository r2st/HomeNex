import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(path.join(__dirname, process.env.DB_FILE || 'homenex.db'))
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
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

// Route an inbound webhook to the right agent by the business number that received it.
// Matches on full digits, then on a 10-digit suffix as a fallback. If there is exactly
// one registered agent, fall back to them (single-number demo convenience).
export function matchAgentByBusinessNumber(displayPhoneNumber) {
  const digits = phoneDigits(displayPhoneNumber)
  if (digits) {
    const agents = db.prepare('SELECT * FROM agents').all()
    const exact = agents.find((a) => phoneDigits(a.phone) === digits)
    if (exact) return exact
    const suffix = digits.slice(-10)
    const bySuffix = agents.find((a) => phoneDigits(a.phone).slice(-10) === suffix)
    if (bySuffix) return bySuffix
  }
  const all = db.prepare('SELECT * FROM agents').all()
  return all.length === 1 ? all[0] : null
}

export function setAgentPhoneNumberId(agentId, phoneNumberId) {
  if (!phoneNumberId) return
  db.prepare(
    'UPDATE agents SET wa_phone_number_id = ? WHERE id = ? AND (wa_phone_number_id IS NULL OR wa_phone_number_id != ?)',
  ).run(String(phoneNumberId), agentId, String(phoneNumberId))
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

export function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
}

// Ownership-checked lookup for dashboard routes: only returns the lead if it belongs to the agent.
export function getLeadForAgent(id, agentId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND agent_id = ?').get(id, agentId)
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

export function listLeads(agentId) {
  return db
    .prepare(
      `SELECT l.*,
         (SELECT text FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
         (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_role,
         (SELECT created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM leads l
       WHERE l.agent_id = ?
       ORDER BY l.updated_at DESC`,
    )
    .all(agentId)
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
