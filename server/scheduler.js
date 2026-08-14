// scheduler.js — autonomous background jobs.
//
// Ported in spirit from Landline's tasks/celery_app.py. HomeNex previously had
// exactly one background loop (festive greeting delivery); everything else was
// request-driven, so nothing happened while the agent was away — and agents are
// away, they're at site visits. This is the stage where HomeNex stops being a
// passive record and starts being an assistant that reaches out.
//
// Following Landline's testable convention, every job is a plain async function
// returning a count. runDueJobs() is the thin orchestrator that fires each job on its
// own cadence (tracked in the meta table) across every active agent. Jobs are
// idempotent: notifications dedupe, follow-ups don't nag twice.
//
// Each job comes in two shapes. The batched one takes a LIST of agent ids and does the
// whole tick's work for every agent in a fixed number of statements; the `...ForAgent`
// export is the single-tenant wrapper, which is what the API layer and the tests use.
// The batched shape is the one runDueJobs calls: a job that reads and writes per agent
// costs round trips proportional to the customer base, on a cadence as tight as ten
// minutes, against the same pool serving requests — so eight jobs across a hundred
// agents was hundreds of queries a tick to produce, most ticks, nothing at all.

import {
  AWAITING_REPLY,
  LAST_CONTACT_AT,
  query,
  getMeta,
  setMeta,
  recomputeScoresForAgents,
  createNotificationsFor,
  createFollowupsFor,
  addMessage,
  getMessagesForLeads,
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

// --- Individual jobs (each tenant-scoped, returns how many it acted on) ---

// Scoring materialises every live lead in Node to score it, so the agent list is walked
// in slices rather than in one statement: the round trips drop by this factor while the
// working set stays bounded by a slice, not by the whole customer base.
const SCORE_CHUNK = 25

const chunk = (xs, size) =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, i * size + size))

// Recompute engagement/effective scores with decay for every live lead these agents own.
export async function recomputeScores(agentIds, now = Date.now()) {
  let n = 0
  for (const slice of chunk(agentIds, SCORE_CHUNK)) n += await recomputeScoresForAgents(slice, now)
  return n
}

export const recomputeScoresForAgent = (agentId, now = Date.now()) => recomputeScores([agentId], now)

// The highest-value job: warn when a lead's 24h free-reply window is about to close.
export async function serviceWindowWatch(agentIds) {
  if (!agentIds.length) return 0
  const { rows } = await query(
    `SELECT agent_id, id, name, wa_id, last_inbound_at FROM leads
     WHERE agent_id = ANY($1::int[]) AND closed_at IS NULL AND last_inbound_at IS NOT NULL
       AND last_inbound_at <= now() - interval '20 hours'
       AND last_inbound_at > now() - interval '24 hours'`,
    [agentIds],
  )
  return createNotificationsFor(
    rows.map((l) => ({
      agent_id: l.agent_id,
      type: 'service_window_closing',
      title: `⏰ Window closing: ${l.name || l.wa_id}`,
      body: 'The 24h free-reply window closes soon. Reply now or you’re locked into a template.',
      entity_type: 'lead',
      entity_id: l.id,
      // One notification per window occurrence (keyed to the inbound hour).
      dedupe_key: `sw:${l.id}:${Math.floor(new Date(l.last_inbound_at).getTime() / 3600_000)}`,
    })),
  )
}

export const serviceWindowWatchForAgent = (agentId) => serviceWindowWatch([agentId])

// Alert on strong engagement: a lead re-opening a property page repeatedly, or a
// hot lead sitting unanswered. So the signal can't be lost while the agent is away.
export async function detectHotLeads(agentIds, now = Date.now()) {
  if (!agentIds.length) return 0
  const day = today(now)

  const repeat = await query(
    `SELECT l.agent_id, l.id, l.name, l.wa_id, COUNT(*)::int AS views
     FROM property_page_views v JOIN leads l ON l.id = v.lead_id
     WHERE l.agent_id = ANY($1::int[]) AND l.closed_at IS NULL AND v.viewed_at >= now() - interval '24 hours'
     GROUP BY l.agent_id, l.id, l.name, l.wa_id HAVING COUNT(*) >= 3`,
    [agentIds],
  )

  // The same "waiting on a reply" question the dashboard and the worklist ask, asked
  // the same way — off the lead row, not by reading the last message's role back out
  // of `messages` once per hot lead.
  const waiting = await query(
    `SELECT l.agent_id, l.id, l.name, l.wa_id, l.effective_score
     FROM leads l
     WHERE l.agent_id = ANY($1::int[]) AND l.closed_at IS NULL AND l.effective_temp = 'Hot'
       AND ${AWAITING_REPLY}`,
    [agentIds],
  )
  // Both halves of this job go in one statement — a lead can qualify on views AND on
  // waiting, and they carry different dedupe keys, so neither shadows the other.
  return createNotificationsFor([
    ...repeat.rows.map((l) => ({
      agent_id: l.agent_id,
      type: 'hot_lead_waiting',
      title: `🔥 ${l.name || l.wa_id} is looking hard`,
      body: `Re-opened a property page ${l.views}× today. Call while it’s fresh.`,
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `hotview:${l.id}:${day}`,
    })),
    ...waiting.rows.map((l) => ({
      agent_id: l.agent_id,
      type: 'hot_lead_waiting',
      title: `🔥 Hot lead waiting: ${l.name || l.wa_id}`,
      body: `Score ${l.effective_score} and waiting on your reply.`,
      entity_type: 'lead',
      entity_id: l.id,
      dedupe_key: `hotwait:${l.id}:${day}`,
    })),
  ])
}

export const detectHotLeadsForAgent = (agentId, now = Date.now()) => detectHotLeads([agentId], now)

// Resurface quiet leads: for every active-pipeline lead with no message in 14 days
// and NO already-open follow-up ("don't nag twice"), create an AI-suggested one.
export async function generateStaleFollowups(agentIds, { limit = 20 } = {}) {
  if (!agentIds.length) return 0
  const { rows } = await query(
    // Same fortnight-of-silence rule as the worklist's stale card, off the same two
    // columns, so the card an agent sees and the follow-up this job files can never
    // disagree about which leads have gone quiet.
    //
    // The LATERAL is what keeps `limit` meaning "per agent" once the whole customer
    // base is read in one statement: a single ORDER BY ... LIMIT over the union would
    // hand the whole allowance to whichever agent's leads sorted first.
    `SELECT x.* FROM unnest($1::int[]) AS a(agent_id)
     JOIN LATERAL (
       SELECT l.agent_id, l.id, l.name, l.wa_id, ${LAST_CONTACT_AT} AS last_msg_at FROM leads l
       WHERE l.agent_id = a.agent_id AND l.closed_at IS NULL
         AND COALESCE(l.stage, 'New') NOT IN ('Registered/Closed','Closed','Lost')
         AND (${LAST_CONTACT_AT} IS NULL OR ${LAST_CONTACT_AT} < now() - interval '14 days')
         AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.lead_id = l.id AND f.completed_at IS NULL)
       ORDER BY l.updated_at LIMIT $2
     ) x ON true`,
    [agentIds, limit],
  )
  const now = new Date().toISOString()
  return createFollowupsFor(
    rows.map((l) => ({
      agent_id: l.agent_id,
      lead_id: l.id,
      due_at: now,
      type: 'ai_suggested',
      // Split for the same reason the worklist card is (see buildWorklist): a NULL
      // last contact is a lead that was typed in and never messaged, and "check in"
      // is not the move — there is no conversation to check back into. The two
      // sentences stay in step with the card's, so the follow-up an agent opens says
      // the same thing the card that sent them there did.
      note: l.last_msg_at
        ? 'No contact in 2+ weeks — check in or share a fresh option.'
        : 'Added by hand and never messaged — send a first hello to start the conversation.',
    })),
  )
}

export const generateStaleFollowupsForAgent = (agentId, opts = {}) => generateStaleFollowups([agentId], opts)

// Remind the agent the evening before a scheduled site visit.
export async function siteVisitReminders(agentIds) {
  if (!agentIds.length) return 0
  const { rows } = await query(
    `SELECT v.agent_id, v.id, v.scheduled_at, l.id AS lead_id, l.name, l.wa_id, p.title
     FROM site_visits v JOIN leads l ON l.id = v.lead_id
     LEFT JOIN properties p ON p.id = v.property_id
     WHERE v.agent_id = ANY($1::int[]) AND v.status IN ('scheduled','confirmed')
       AND v.scheduled_at BETWEEN now() AND now() + interval '24 hours'`,
    [agentIds],
  )
  return createNotificationsFor(
    rows.map((v) => ({
      agent_id: v.agent_id,
      type: 'site_visit_tomorrow',
      title: `📍 Visit tomorrow: ${v.name || v.wa_id}`,
      body: `Site visit ${v.title ? `for ${v.title} ` : ''}is coming up. Confirm pickup and attendance.`,
      entity_type: 'site_visit',
      entity_id: v.id,
      dedupe_key: `visit:${v.id}`,
    })),
  )
}

export const siteVisitRemindersForAgent = (agentId) => siteVisitReminders([agentId])

// No-response nudge: a brand-new lead whose only messages are from the buyer and
// who has now waited past the threshold with no agent/AI reply. Notifies once per
// waiting spell (keyed to the last-inbound hour, so a fresh message re-nudges).
export async function noResponseNudge(agentIds) {
  if (!agentIds.length) return 0
  const { rows } = await query(
    `SELECT l.agent_id, l.id, l.name, l.wa_id, l.last_inbound_at
     FROM leads l
     WHERE l.agent_id = ANY($1::int[]) AND l.closed_at IS NULL AND l.last_inbound_at IS NOT NULL
       AND l.last_inbound_at <= now() - ($2 || ' minutes')::interval
       -- "No agent/AI message has ever gone out" is exactly a NULL last_outbound_at.
       AND l.last_outbound_at IS NULL`,
    [agentIds, String(NO_RESPONSE_NUDGE_MINUTES)],
  )
  return createNotificationsFor(
    rows.map((l) => ({
      agent_id: l.agent_id,
      type: 'no_response_nudge',
      title: `🆕 Unanswered lead: ${l.name || l.wa_id}`,
      body: `A new buyer has waited ${NO_RESPONSE_NUDGE_MINUTES}+ min with no reply. First response wins the deal.`,
      entity_type: 'lead',
      entity_id: l.id,
      // Once per waiting spell, keyed to the last-inbound hour so a fresh message re-nudges.
      dedupe_key: `noresp:${l.id}:${Math.floor(new Date(l.last_inbound_at).getTime() / 3600_000)}`,
    })),
  )
}

export const noResponseNudgeForAgent = (agentId) => noResponseNudge([agentId])

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
// Which reminder, if any, this visit is due for right now. Returns the guard column to
// stamp, or null when the visit has already had the only reminder that still applies.
function dueReminderColumn(visit, now) {
  const hoursUntil = (new Date(visit.scheduled_at).getTime() - now) / 3600_000
  // Inside the final ~2h, only the T-2h reminder (with the pin) is relevant — a
  // same-day booking must never fall through to a "your visit is tomorrow" note.
  if (hoursUntil <= 2.5) return visit.reminder_t2_sent_at ? null : 'reminder_t2_sent_at'
  if (hoursUntil <= 25 && !visit.reminder_t1_sent_at) return 'reminder_t1_sent_at'
  return null
}

export async function siteVisitWaReminders(agentIds, now = Date.now(), send = sendText) {
  if (!agentIds.length) return 0
  if (send === sendText && !whatsappConfigured()) return 0
  // One read for every agent in the tick. The agent row is needed for the sending
  // number and the timezone the reminder is written in, and it was fetched one agent at
  // a time right after activeAgentIds() had already listed them.
  const agents = new Map(
    (
      await query('SELECT id, wa_phone_number_id, timezone FROM agents WHERE id = ANY($1::int[])', [
        agentIds,
      ])
    ).rows.map((a) => [a.id, a]),
  )
  if (!agents.size) return 0
  const { rows } = await query(
    `SELECT v.*, l.name AS lead_name, l.wa_id AS lead_wa_id,
            p.title AS property_title, p.locality AS property_locality, p.city AS property_city
     FROM site_visits v
     JOIN leads l ON l.id = v.lead_id
     LEFT JOIN properties p ON p.id = v.property_id
     WHERE v.agent_id = ANY($1::int[]) AND v.status IN ('scheduled','confirmed')
       AND v.scheduled_at > to_timestamp($2 / 1000.0)
       AND v.scheduled_at <= to_timestamp($2 / 1000.0) + interval '26 hours'`,
    [agentIds, now],
  )
  const due = rows
    .map((v) => ({ v, column: dueReminderColumn(v, now) }))
    .filter((d) => d.column && agents.has(d.v.agent_id))
  if (!due.length) return 0
  // The transcripts of every lead being reminded, in one statement rather than one per
  // reminder. Only the leads that are actually due are read: the query above returns
  // every upcoming visit, most of which have already been reminded.
  const transcripts = await getMessagesForLeads(due.map((d) => d.v.lead_id))
  let n = 0
  for (const { v, column } of due) {
    const agent = agents.get(v.agent_id)
    try {
      // Mirror the buyer's own language/register (see language.js) — a reminder
      // landing in English mid-Hindi/Hinglish thread reads as a canned bot message.
      const opts = { timezone: agent.timezone || 'Asia/Kolkata', lang: detectConversationLanguage(transcripts.get(v.lead_id) || []) }
      const text = column === 'reminder_t2_sent_at' ? reminderT2Text(v, opts) : reminderT1Text(v, opts)
      await deliverVisitMessage(agent, v, text, send)
      // Stamped one visit at a time, on purpose: the send is an external call that can
      // fail per visit, and the guard column is what stops a buyer being messaged twice.
      // Deferring these to one batched UPDATE would widen the window in which a crash
      // re-sends every reminder in the tick.
      await query(`UPDATE site_visits SET ${column} = now() WHERE id = $1`, [v.id])
      n++
    } catch (err) {
      console.error(`site-visit reminder failed for visit ${v.id}:`, err.message)
    }
  }
  return n
}

export const siteVisitWaRemindersForAgent = (agentId, now = Date.now(), send = sendText) =>
  siteVisitWaReminders([agentId], now, send)

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
export async function commissionOverdueSweep(agentIds) {
  if (!agentIds.length) return 0
  // The pre-image is captured in `due` because UPDATE ... RETURNING yields the new row,
  // and the message depends on the status being replaced ("raise the invoice" vs "chase
  // the payment"). `swept` is joined back in so a row another sweep took concurrently
  // is not announced twice.
  //
  // The lead is joined in rather than fetched per row: commissions.lead_id is a NOT NULL
  // foreign key, so every swept row has exactly one lead and the join never drops any.
  //
  // The invoice lookup stays scoped to the commission's OWN agent, not to the tick's
  // whole agent list: the sweep now runs for every agent at once, and `ci.agent_id =
  // ANY($1)` would let one workspace's invoice number be quoted in another's notification.
  const { rows } = await query(
    `WITH due AS (
       SELECT id, agent_id, lead_id, status AS prior_status
       FROM commissions
       WHERE agent_id = ANY($1::int[]) AND status IN ('expected', 'invoiced')
         AND expected_payout_date IS NOT NULL AND expected_payout_date < now()::date
     ),
     swept AS (
       UPDATE commissions c SET status = 'overdue', updated_at = now()
       FROM due WHERE c.id = due.id
       RETURNING c.id
     )
     SELECT due.id, due.agent_id, due.prior_status, leads.name, leads.wa_id, inv.invoice_number
     FROM due
     JOIN swept ON swept.id = due.id
     JOIN leads ON leads.id = due.lead_id
     LEFT JOIN LATERAL (
       SELECT invoice_number FROM commission_invoices ci
       WHERE ci.commission_id = due.id AND ci.agent_id = due.agent_id AND ci.status <> 'cancelled'
       ORDER BY ci.issued_at DESC, ci.id DESC LIMIT 1
     ) inv ON true`,
    [agentIds],
  )
  return createNotificationsFor(
    rows.map((c) => {
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
      return {
        agent_id: c.agent_id,
        type: 'commission_overdue',
        title: `💰 Commission overdue`,
        body,
        entity_type: 'commission',
        entity_id: c.id,
        dedupe_key: `commov:${c.id}`,
      }
    }),
  )
}

export const commissionOverdueSweepForAgent = (agentId) => commissionOverdueSweep([agentId])

// --- Orchestration ---

// Job cadences in minutes. Service-window watch is the tightest because its miss is
// the most expensive (a free conversation becomes a paid template request).
export const JOBS = [
  { name: 'scores', everyMin: 720, fn: recomputeScores },
  { name: 'service_window', everyMin: 15, fn: serviceWindowWatch },
  { name: 'hot_leads', everyMin: 30, fn: detectHotLeads },
  { name: 'no_response', everyMin: 10, fn: noResponseNudge },
  // Wrapped, not passed bare: its second argument is the per-agent cap, not `now`.
  { name: 'stale_followups', everyMin: 240, fn: (agentIds) => generateStaleFollowups(agentIds) },
  { name: 'site_visits', everyMin: 360, fn: siteVisitReminders },
  { name: 'site_visit_wa', everyMin: 30, fn: siteVisitWaReminders },
  { name: 'commissions', everyMin: 1440, fn: commissionOverdueSweep },
]

export async function activeAgentIds() {
  return (await query('SELECT id FROM agents WHERE is_active = 1 ORDER BY id')).rows.map((r) => r.id)
}

// Run one job for every active agent. The agent list is read once per tick and handed
// to each job, rather than re-read per job, and each job does its own work for the whole
// list in a fixed number of statements.
//
// The try/catch is per JOB, not per agent, because there is no longer a per-agent step
// to isolate: every job is SQL over the whole list, which either runs or doesn't. The
// one place a single tenant's work can fail on its own — an outbound WhatsApp send in
// siteVisitWaReminders — keeps its own per-visit catch, so one unreachable number still
// doesn't cost the other reminders in the tick.
export async function runJobForAllAgents(fn, agentIds = null, now = Date.now()) {
  const ids = agentIds || (await activeAgentIds())
  if (!ids.length) return 0
  try {
    return (await fn(ids, now)) || 0
  } catch (err) {
    console.error(`scheduler job failed:`, err.message)
    return 0
  }
}

// The production tick: run each job whose cadence has elapsed since its last run
// (tracked in meta). Safe to call every minute. Returns per-job action counts.
export async function runDueJobs(now = Date.now()) {
  const results = {}
  // Read once for the whole tick, and only if something is actually due — most ticks
  // nothing is, and the list was being re-read once per job that ran.
  let agentIds = null
  for (const job of JOBS) {
    const key = `job:${job.name}:last_run`
    const last = Number(await getMeta(key)) || 0
    if (now - last < job.everyMin * 60_000) continue
    if (agentIds === null) agentIds = await activeAgentIds()
    results[job.name] = await runJobForAllAgents(job.fn, agentIds, now)
    await setMeta(key, String(now))
  }
  return results
}
