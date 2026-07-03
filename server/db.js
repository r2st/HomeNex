import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(path.join(__dirname, process.env.DB_FILE || 'homenex.db'))
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id TEXT UNIQUE NOT NULL,
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
  updated_at TEXT DEFAULT (datetime('now'))
);

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
  lead_id INTEGER,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
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

export function upsertLead(waId, name) {
  db.prepare(
    `INSERT INTO leads (wa_id, name, phone) VALUES (?, ?, ?)
     ON CONFLICT(wa_id) DO UPDATE SET
       name = COALESCE(excluded.name, leads.name),
       updated_at = datetime('now')`,
  ).run(waId, name || null, waId)
  return db.prepare('SELECT * FROM leads WHERE wa_id = ?').get(waId)
}

export function getLead(id) {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id)
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

export function logActivity(leadId, kind, text) {
  db.prepare('INSERT INTO activity (lead_id, kind, text) VALUES (?, ?, ?)').run(
    leadId,
    kind,
    text,
  )
}

export function listLeads() {
  return db
    .prepare(
      `SELECT l.*,
         (SELECT text FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_msg,
         (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_role,
         (SELECT created_at FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM leads l
       ORDER BY l.updated_at DESC`,
    )
    .all()
}

export function listActivity(limit = 30) {
  return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit)
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
export function computeMatches() {
  const leads = db
    .prepare("SELECT * FROM leads WHERE locality IS NOT NULL AND temp != 'Cold'")
    .all()
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

export function stats() {
  const one = (sql, ...args) => Object.values(db.prepare(sql).get(...args))[0]
  const total = one('SELECT COUNT(*) FROM leads')
  const newToday = one(
    "SELECT COUNT(*) FROM leads WHERE created_at >= datetime('now', 'start of day')",
  )
  const hotNow = one("SELECT COUNT(*) FROM leads WHERE temp = 'Hot'")
  const active24h = one(
    "SELECT COUNT(DISTINCT lead_id) FROM messages WHERE created_at >= datetime('now', '-1 day')",
  )
  const pipelineL =
    one(
      "SELECT COALESCE(SUM((budget_min_l + budget_max_l) / 2.0), 0) FROM leads WHERE temp != 'Cold' AND budget_max_l IS NOT NULL",
    ) || 0
  const avgFirstResponseS = one('SELECT AVG(first_response_s) FROM leads')
  const qualified = one(
    'SELECT COUNT(*) FROM leads WHERE locality IS NOT NULL AND timeline IS NOT NULL AND config IS NOT NULL AND budget_max_l IS NOT NULL',
  )
  const afterHours = one(
    `SELECT COUNT(*) FROM leads
     WHERE CAST(strftime('%H', created_at, 'localtime') AS INTEGER) >= 21
        OR CAST(strftime('%H', created_at, 'localtime') AS INTEGER) < 9`,
  )
  const sources = db
    .prepare('SELECT source AS name, COUNT(*) AS count FROM leads GROUP BY source ORDER BY count DESC')
    .all()
  const daily = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS day, AVG(first_response_s) AS avg_s, COUNT(*) AS leads
       FROM leads WHERE created_at >= datetime('now', '-7 days')
       GROUP BY day ORDER BY day`,
    )
    .all()
  const msgsToday = one(
    "SELECT COUNT(*) FROM messages WHERE created_at >= datetime('now', 'start of day')",
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
