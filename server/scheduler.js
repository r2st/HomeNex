// scheduler.js — autonomous background jobs.
//
// Ported in spirit from Landline's tasks/celery_app.py. HomeNex previously had
// exactly one background loop (festive greeting delivery); everything else was
// request-driven, so nothing happened while the agent was away — and agents are
// away, they're at site visits. This is the stage where HomeNex stops being a
// passive record and starts being an assistant that reaches out.
//
// Following Landline's testable convention, every job is a plain async function
// taking (agentId) and returning a count. runDueJobs() is the thin orchestrator
// that fires each job on its own cadence (tracked in the meta table) across every
// active agent. Jobs are idempotent: notifications dedupe, follow-ups don't nag twice.

import {
  query,
  getMeta,
  setMeta,
  recomputeAgentScores,
  createNotification,
  createFollowup,
} from './db.js'

const today = (now) => new Date(now).toISOString().slice(0, 10)

// --- Individual jobs (each per-agent, tenant-scoped, returns how many it acted on) ---

// Recompute engagement/effective scores with decay for all of an agent's live leads.
export async function recomputeScoresForAgent(agentId, now = Date.now()) {
  return recomputeAgentScores(agentId, now)
}

// The highest-value job: warn when a lead's 24h free-reply window is about to close.
export async function serviceWindowWatchForAgent(agentId) {
  const { rows } = await query(
    `SELECT id, name, wa_id, last_inbound_at FROM leads
     WHERE agent_id = $1 AND closed_at IS NULL AND last_inbound_at IS NOT NULL
       AND last_inbound_at <= now() - interval '20 hours'
       AND last_inbound_at > now() - interval '24 hours'`,
    [agentId],
  )
  let n = 0
  for (const l of rows) {
    // One notification per window occurrence (keyed to the inbound hour).
    const windowHour = Math.floor(new Date(l.last_inbound_at).getTime() / 3600_000)
    const created = await createNotification(agentId, {
      type: 'service_window_closing',
      title: `⏰ Window closing: ${l.name || l.wa_id}`,
      body: 'The 24h free-reply window closes soon. Reply now or you’re locked into a template.',
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `sw:${l.id}:${windowHour}`,
    })
    if (created) n++
  }
  return n
}

// Alert on strong engagement: a lead re-opening a property page repeatedly, or a
// hot lead sitting unanswered. So the signal can't be lost while the agent is away.
export async function detectHotLeadsForAgent(agentId, now = Date.now()) {
  let n = 0
  const day = today(now)

  const repeat = await query(
    `SELECT l.id, l.name, l.wa_id, COUNT(*)::int AS views
     FROM property_page_views v JOIN leads l ON l.id = v.lead_id
     WHERE l.agent_id = $1 AND l.closed_at IS NULL AND v.viewed_at >= now() - interval '24 hours'
     GROUP BY l.id, l.name, l.wa_id HAVING COUNT(*) >= 3`,
    [agentId],
  )
  for (const l of repeat.rows) {
    const created = await createNotification(agentId, {
      type: 'hot_lead_waiting',
      title: `🔥 ${l.name || l.wa_id} is looking hard`,
      body: `Re-opened a property page ${l.views}× today. Call while it’s fresh.`,
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `hotview:${l.id}:${day}`,
    })
    if (created) n++
  }

  const waiting = await query(
    `SELECT l.id, l.name, l.wa_id, l.effective_score
     FROM leads l
     JOIN LATERAL (SELECT role FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) lm ON lm.role = 'buyer'
     WHERE l.agent_id = $1 AND l.closed_at IS NULL AND l.effective_temp = 'Hot'`,
    [agentId],
  )
  for (const l of waiting.rows) {
    const created = await createNotification(agentId, {
      type: 'hot_lead_waiting',
      title: `🔥 Hot lead waiting: ${l.name || l.wa_id}`,
      body: `Score ${l.effective_score} and waiting on your reply.`,
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `hotwait:${l.id}:${day}`,
    })
    if (created) n++
  }
  return n
}

// Resurface quiet leads: for every active-pipeline lead with no message in 14 days
// and NO already-open follow-up ("don't nag twice"), create an AI-suggested one.
export async function generateStaleFollowupsForAgent(agentId, { limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.wa_id FROM leads l
     WHERE l.agent_id = $1 AND l.closed_at IS NULL
       AND COALESCE(l.stage, 'New') NOT IN ('Registered/Closed','Closed','Lost')
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.created_at >= now() - interval '14 days')
       AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.lead_id = l.id AND f.completed_at IS NULL)
     ORDER BY l.updated_at LIMIT $2`,
    [agentId, limit],
  )
  let n = 0
  for (const l of rows) {
    await createFollowup(agentId, {
      lead_id: l.id,
      due_at: new Date().toISOString(),
      type: 'ai_suggested',
      note: 'No contact in 2+ weeks — check in or share a fresh option.',
    })
    n++
  }
  return n
}

// Remind the agent the evening before a scheduled site visit.
export async function siteVisitRemindersForAgent(agentId) {
  const { rows } = await query(
    `SELECT v.id, v.scheduled_at, l.id AS lead_id, l.name, l.wa_id, p.title
     FROM site_visits v JOIN leads l ON l.id = v.lead_id
     LEFT JOIN properties p ON p.id = v.property_id
     WHERE v.agent_id = $1 AND v.status IN ('scheduled','confirmed')
       AND v.scheduled_at BETWEEN now() AND now() + interval '24 hours'`,
    [agentId],
  )
  let n = 0
  for (const v of rows) {
    const created = await createNotification(agentId, {
      type: 'site_visit_tomorrow',
      title: `📍 Visit tomorrow: ${v.name || v.wa_id}`,
      body: `Site visit ${v.title ? `for ${v.title} ` : ''}is coming up. Confirm pickup and attendance.`,
      entity_type: 'site_visit',
      entity_id: v.id,
      dedupe_key: `visit:${v.id}`,
    })
    if (created) n++
  }
  return n
}

// Flip expected commissions past their payout date to overdue, and notify once.
export async function commissionOverdueSweepForAgent(agentId) {
  const { rows } = await query(
    `UPDATE commissions SET status = 'overdue', updated_at = now()
     WHERE agent_id = $1 AND status = 'expected'
       AND expected_payout_date IS NOT NULL AND expected_payout_date < now()::date
     RETURNING id, lead_id`,
    [agentId],
  )
  let n = 0
  for (const c of rows) {
    const lead = (await query('SELECT name, wa_id FROM leads WHERE id = $1', [c.lead_id])).rows[0] || {}
    const created = await createNotification(agentId, {
      type: 'commission_overdue',
      title: `💰 Commission overdue`,
      body: `Brokerage for ${lead.name || lead.wa_id || 'a deal'} is past its payout date. Chase it.`,
      entity_type: 'commission',
      entity_id: c.id,
      dedupe_key: `commov:${c.id}`,
    })
    if (created) n++
  }
  return n
}

// --- Orchestration ---

// Job cadences in minutes. Service-window watch is the tightest because its miss is
// the most expensive (a free conversation becomes a paid template request).
export const JOBS = [
  { name: 'scores', everyMin: 720, fn: recomputeScoresForAgent },
  { name: 'service_window', everyMin: 15, fn: serviceWindowWatchForAgent },
  { name: 'hot_leads', everyMin: 30, fn: detectHotLeadsForAgent },
  { name: 'stale_followups', everyMin: 240, fn: generateStaleFollowupsForAgent },
  { name: 'site_visits', everyMin: 360, fn: siteVisitRemindersForAgent },
  { name: 'commissions', everyMin: 1440, fn: commissionOverdueSweepForAgent },
]

async function activeAgentIds() {
  return (await query('SELECT id FROM agents WHERE is_active = 1 ORDER BY id')).rows.map((r) => r.id)
}

// Run one job across every active agent. Scores must run before the notification
// jobs that read effective_temp, so runDueJobs orders JOBS with scores first.
export async function runJobForAllAgents(fn) {
  let total = 0
  for (const agentId of await activeAgentIds()) {
    try {
      total += (await fn(agentId)) || 0
    } catch (err) {
      console.error(`scheduler job failed for agent ${agentId}:`, err.message)
    }
  }
  return total
}

// The production tick: run each job whose cadence has elapsed since its last run
// (tracked in meta). Safe to call every minute. Returns per-job action counts.
export async function runDueJobs(now = Date.now()) {
  const results = {}
  for (const job of JOBS) {
    const key = `job:${job.name}:last_run`
    const last = Number(await getMeta(key)) || 0
    if (now - last < job.everyMin * 60_000) continue
    results[job.name] = await runJobForAllAgents((agentId) => job.fn(agentId, now))
    await setMeta(key, String(now))
  }
  return results
}
