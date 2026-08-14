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
  AWAITING_REPLY,
  LAST_CONTACT_AT,
  query,
  getMeta,
  setMeta,
  recomputeAgentScores,
  createNotification,
  createFollowup,
  addMessage,
  getMessages,
  logActivity,
} from './db.js'
import { sendText, whatsappConfigured } from './whatsapp.js'
import { reminderT1Text, reminderT2Text } from './siteVisit.js'
import { detectConversationLanguage } from './language.js'

const today = (now) => new Date(now).toISOString().slice(0, 10)

// A brand-new lead is "unreplied" if no agent/AI message has ever gone out and the
// buyer has been waiting longer than this. Kept short — the first reply is what wins
// a WhatsApp lead. See §4.6 "No-response nudge".
const NO_RESPONSE_NUDGE_MINUTES = 30

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

  // The same "waiting on a reply" question the dashboard and the worklist ask, asked
  // the same way — off the lead row, not by reading the last message's role back out
  // of `messages` once per hot lead.
  const waiting = await query(
    `SELECT l.id, l.name, l.wa_id, l.effective_score
     FROM leads l
     WHERE l.agent_id = $1 AND l.closed_at IS NULL AND l.effective_temp = 'Hot'
       AND ${AWAITING_REPLY}`,
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
    // Same fortnight-of-silence rule as the worklist's stale card, off the same two
    // columns, so the card an agent sees and the follow-up this job files can never
    // disagree about which leads have gone quiet.
    `SELECT l.id, l.name, l.wa_id FROM leads l
     WHERE l.agent_id = $1 AND l.closed_at IS NULL
       AND COALESCE(l.stage, 'New') NOT IN ('Registered/Closed','Closed','Lost')
       AND (${LAST_CONTACT_AT} IS NULL OR ${LAST_CONTACT_AT} < now() - interval '14 days')
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

// No-response nudge: a brand-new lead whose only messages are from the buyer and
// who has now waited past the threshold with no agent/AI reply. Notifies once per
// waiting spell (keyed to the last-inbound hour, so a fresh message re-nudges).
export async function noResponseNudgeForAgent(agentId, now = Date.now()) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.wa_id, l.last_inbound_at
     FROM leads l
     WHERE l.agent_id = $1 AND l.closed_at IS NULL AND l.last_inbound_at IS NOT NULL
       AND l.last_inbound_at <= now() - ($2 || ' minutes')::interval
       -- "No agent/AI message has ever gone out" is exactly a NULL last_outbound_at.
       AND l.last_outbound_at IS NULL`,
    [agentId, String(NO_RESPONSE_NUDGE_MINUTES)],
  )
  let n = 0
  for (const l of rows) {
    const windowHour = Math.floor(new Date(l.last_inbound_at).getTime() / 3600_000)
    const created = await createNotification(agentId, {
      type: 'no_response_nudge',
      title: `🆕 Unanswered lead: ${l.name || l.wa_id}`,
      body: `A new buyer has waited ${NO_RESPONSE_NUDGE_MINUTES}+ min with no reply. First response wins the deal.`,
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `noresp:${l.id}:${windowHour}`,
    })
    if (created) n++
  }
  return n
}

// Deliver one automated site-visit WhatsApp message: send it, mirror it into the
// lead's transcript, log the activity. `send` is injectable for tests.
async function deliverVisitMessage(agent, visit, text, send) {
  const waId = await send(visit.lead_wa_id, text, agent.wa_phone_number_id)
  await addMessage(visit.lead_id, 'agent', text, waId)
  await logActivity(agent.id, visit.lead_id, 'agent', `Auto site-visit reminder sent to ${visit.lead_name || visit.lead_wa_id}`)
  return waId
}

// Automated WhatsApp confirmations before a visit: a T-1-day heads-up and a
// T-2-hour reminder that carries the location pin. Each fires at most once (guarded
// by the reminder_t*_sent_at columns). `send` defaults to the real WhatsApp sender;
// when WhatsApp isn't configured the job is a no-op so dev/test runs stay quiet.
export async function siteVisitWaRemindersForAgent(agentId, now = Date.now(), send = sendText) {
  if (send === sendText && !whatsappConfigured()) return 0
  const agent = (
    await query('SELECT id, wa_phone_number_id, timezone FROM agents WHERE id = $1', [agentId])
  ).rows[0]
  if (!agent) return 0
  const { rows } = await query(
    `SELECT v.*, l.name AS lead_name, l.wa_id AS lead_wa_id,
            p.title AS property_title, p.locality AS property_locality, p.city AS property_city
     FROM site_visits v
     JOIN leads l ON l.id = v.lead_id
     LEFT JOIN properties p ON p.id = v.property_id
     WHERE v.agent_id = $1 AND v.status IN ('scheduled','confirmed')
       AND v.scheduled_at > to_timestamp($2 / 1000.0)
       AND v.scheduled_at <= to_timestamp($2 / 1000.0) + interval '26 hours'`,
    [agentId, now],
  )
  const opts = { timezone: agent.timezone || 'Asia/Kolkata' }
  let n = 0
  for (const v of rows) {
    const hoursUntil = (new Date(v.scheduled_at).getTime() - now) / 3600_000
    let column = null
    // Inside the final ~2h, only the T-2h reminder (with the pin) is relevant — a
    // same-day booking must never fall through to a "your visit is tomorrow" note.
    if (hoursUntil <= 2.5) {
      if (!v.reminder_t2_sent_at) column = 'reminder_t2_sent_at'
    } else if (hoursUntil <= 25 && !v.reminder_t1_sent_at) {
      column = 'reminder_t1_sent_at'
    }
    if (!column) continue
    try {
      // Mirror the buyer's own language/register (see language.js) — a reminder
      // landing in English mid-Hindi/Hinglish thread reads as a canned bot message.
      const lang = detectConversationLanguage(await getMessages(v.lead_id))
      const text = column === 'reminder_t2_sent_at' ? reminderT2Text(v, { ...opts, lang }) : reminderT1Text(v, { ...opts, lang })
      await deliverVisitMessage(agent, v, text, send)
      await query(`UPDATE site_visits SET ${column} = now() WHERE id = $1`, [v.id])
      n++
    } catch (err) {
      console.error(`site-visit reminder failed for visit ${v.id}:`, err.message)
    }
  }
  return n
}

// Flip unpaid commissions past their payout date to overdue, and notify once.
//
// Both money-owed statuses are swept, not just 'expected'. An invoiced commission is
// the one most worth chasing — the agent has already billed the builder and the money
// still hasn't landed — but it used to age silently: the sweep only ever looked at
// 'expected', so raising an invoice took the commission *out* of the only job that
// could flag it. builderReceivables already counts 'invoiced' as outstanding and ages
// it into the 90+ bucket, so the ledger was showing a debt the notifications never
// mentioned. 'received' and 'overdue' are left alone: one is paid, the other is
// already flagged.
export async function commissionOverdueSweepForAgent(agentId) {
  // The pre-image is captured in `due` because UPDATE ... RETURNING yields the new row,
  // and the message depends on the status being replaced ("raise the invoice" vs "chase
  // the payment"). `swept` is joined back in so a row another sweep took concurrently
  // is not announced twice.
  //
  // The lead is joined in rather than fetched per row: commissions.lead_id is a NOT NULL
  // foreign key, so every swept row has exactly one lead and the join never drops any.
  const { rows } = await query(
    `WITH due AS (
       SELECT id, lead_id, status AS prior_status
       FROM commissions
       WHERE agent_id = $1 AND status IN ('expected', 'invoiced')
         AND expected_payout_date IS NOT NULL AND expected_payout_date < now()::date
     ),
     swept AS (
       UPDATE commissions c SET status = 'overdue', updated_at = now()
       FROM due WHERE c.id = due.id
       RETURNING c.id
     )
     SELECT due.id, due.prior_status, leads.name, leads.wa_id, inv.invoice_number
     FROM due
     JOIN swept ON swept.id = due.id
     JOIN leads ON leads.id = due.lead_id
     LEFT JOIN LATERAL (
       SELECT invoice_number FROM commission_invoices ci
       WHERE ci.commission_id = due.id AND ci.agent_id = $1 AND ci.status <> 'cancelled'
       ORDER BY ci.issued_at DESC, ci.id DESC LIMIT 1
     ) inv ON true`,
    [agentId],
  )
  let n = 0
  for (const c of rows) {
    // leads.name is nullable, so fall back to the wa_id, which is NOT NULL.
    const who = c.name || c.wa_id
    // An invoice that was raised and then cancelled leaves the commission 'invoiced'
    // with nothing to quote, so the number is only named when there is one.
    const body =
      c.prior_status === 'invoiced'
        ? c.invoice_number
          ? `Invoice ${c.invoice_number} for ${who} is past its payout date. Chase the payment.`
          : `Brokerage for ${who} is invoiced and past its payout date. Chase the payment.`
        : `Brokerage for ${who} is past its payout date. Chase it.`
    const created = await createNotification(agentId, {
      type: 'commission_overdue',
      title: `💰 Commission overdue`,
      body,
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
  { name: 'no_response', everyMin: 10, fn: noResponseNudgeForAgent },
  { name: 'stale_followups', everyMin: 240, fn: generateStaleFollowupsForAgent },
  { name: 'site_visits', everyMin: 360, fn: siteVisitRemindersForAgent },
  { name: 'site_visit_wa', everyMin: 30, fn: siteVisitWaRemindersForAgent },
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
