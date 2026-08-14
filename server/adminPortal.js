// Admin Portal storage (§7): onboarding/KYC, template review, billing & GST
// invoices, support tickets, and platform analytics. Uses the shared pg pool
// exported by db.js. Money is paise everywhere; GST math lives in money.js.
import { query, pool } from './db.js'
import { gstBreakdown, GST_RATE } from './money.js'

const fail = (message, code = 'INVALID') => {
  const err = new Error(message)
  err.code = code
  throw err
}

// Indian WhatsApp conversation pricing by category, in paise per conversation.
// Approximate list rates used to estimate Meta cost against a tenant's plan.
const META_RATE_PAISE = { marketing: 78, utility: 11, authentication: 11, service: 0 }
// A tenant is billed this per conversation once they exceed their plan quota.
const OVERAGE_RATE_PAISE = 100

// ===========================================================================
// §7.1 Onboarding queue + KYC/RERA verification + WABA health
// ===========================================================================

// The onboarding checklist for one agent, derived from their profile/WABA/KYC.
function onboardingSteps(a) {
  return {
    profile: Boolean(a.business_name && a.city),
    rera: Boolean(a.rera_id) && a.rera_verified === true,
    waba: a.waba_status === 'active',
    kyc: a.kyc_status === 'verified',
  }
}

// Agents still working through onboarding: anyone not fully verified + live.
// Ordered oldest-signup first so the queue is a genuine backlog.
export async function onboardingQueue() {
  const { rows } = await query(
    `SELECT id, name, phone, email, business_name, city, rera_id, rera_state, rera_verified,
            kyc_status, kyc_note, waba_status, is_active, created_at
     FROM agents
     WHERE is_active = 1
       AND (kyc_status <> 'verified' OR waba_status <> 'active' OR rera_verified = false)
     ORDER BY created_at ASC`,
  )
  return rows.map((a) => ({ ...a, steps: onboardingSteps(a) }))
}

export async function setAgentKyc(actorId, agentId, { status, note } = {}) {
  if (!['unverified', 'pending', 'verified', 'rejected'].includes(status)) fail('Invalid KYC status')
  const { rows } = await query(
    `UPDATE agents SET kyc_status = $1, kyc_note = $2, kyc_reviewed_by = $3, kyc_reviewed_at = now()
     WHERE id = $4 RETURNING id, name, kyc_status, kyc_note, kyc_reviewed_at`,
    [status, note ?? null, actorId, agentId],
  )
  if (!rows[0]) fail('Agent not found', 'NOT_FOUND')
  return rows[0]
}

export async function setAgentReraVerified(agentId, verified) {
  const { rows } = await query(
    `UPDATE agents SET rera_verified = $1, rera_verified_at = CASE WHEN $1 THEN now() ELSE NULL END
     WHERE id = $2 RETURNING id, name, rera_id, rera_verified, rera_verified_at`,
    [Boolean(verified), agentId],
  )
  if (!rows[0]) fail('Agent not found', 'NOT_FOUND')
  return rows[0]
}

// WABA health board: every agent's line status plus recent send volume and the
// last time they were active, so staff can spot silent or stuck numbers.
export async function wabaHealthBoard() {
  const { rows } = await query(
    `SELECT a.id, a.name, a.wa_phone_number, a.wa_phone_number_id, a.waba_status,
            a.waba_registered_at, a.meta_waba_id, a.is_active,
            (SELECT COUNT(*) FROM message_sends s WHERE s.agent_id = a.id
               AND s.sent_at >= now() - interval '7 days')::int AS sends_7d,
            (SELECT MAX(created_at) FROM activity WHERE agent_id = a.id) AS last_active
     FROM agents a
     ORDER BY CASE a.waba_status WHEN 'active' THEN 0 WHEN 'registered' THEN 1
                                 WHEN 'pending' THEN 2 ELSE 3 END, a.name`,
  )
  return rows
}

// ===========================================================================
// §7.2 Template approval workflow
// ===========================================================================

export async function pendingReviewTemplates() {
  return (
    await query(
      `SELECT t.*, a.name AS agent_name, a.phone AS agent_phone
       FROM message_templates t JOIN agents a ON a.id = t.agent_id
       WHERE t.review_status = 'pending_review'
       ORDER BY t.updated_at ASC`,
    )
  ).rows
}

// Staff decision on a template. approve/reject stamp the reviewer; submit marks it
// sent to Meta (meta_status stays 'pending' until Meta's webhook flips it).
export async function reviewTemplate(actorId, templateId, { action, note } = {}) {
  const map = { approve: 'approved', reject: 'rejected', submit: 'submitted' }
  const next = map[action]
  if (!next) fail('action must be approve, reject or submit')
  const extra =
    next === 'submitted' ? ", submitted_at = now(), meta_status = 'pending'" : ''
  const { rows } = await query(
    `UPDATE message_templates
       SET review_status = $1, review_note = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()${extra}
     WHERE id = $4 RETURNING *`,
    [next, note ?? null, actorId, templateId],
  )
  if (!rows[0]) fail('Template not found', 'NOT_FOUND')
  return rows[0]
}

// Agent-facing: submit a draft template for staff review.
export async function requestTemplateReview(agentId, templateId) {
  const { rows } = await query(
    `UPDATE message_templates SET review_status = 'pending_review', review_note = NULL, updated_at = now()
     WHERE id = $1 AND agent_id = $2 AND review_status IN ('draft','rejected') RETURNING *`,
    [templateId, agentId],
  )
  if (!rows[0]) fail('Template not found or not in a requestable state', 'NOT_FOUND')
  return rows[0]
}

// ===========================================================================
// §7.3 Billing & usage: plans, subscriptions, GST invoices
// ===========================================================================

export async function listPlans({ activeOnly = false } = {}) {
  return (
    await query(`SELECT * FROM plans ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY price_paise`)
  ).rows
}

export async function createPlan(p) {
  if (!p.code || !p.name) fail('code and name are required')
  const { rows } = await query(
    `INSERT INTO plans (code, name, price_paise, conversation_quota, features, is_active)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, true)) RETURNING *`,
    [p.code, p.name, p.price_paise ?? 0, p.conversation_quota ?? null, JSON.stringify(p.features ?? []), p.is_active],
  )
  return rows[0]
}

export async function updatePlan(id, p) {
  const sets = []
  const params = []
  const set = (col, val) => (params.push(val), sets.push(`${col} = $${params.length}`))
  if (p.name !== undefined) set('name', p.name)
  if (p.price_paise !== undefined) set('price_paise', p.price_paise)
  if (p.conversation_quota !== undefined) set('conversation_quota', p.conversation_quota)
  if (p.features !== undefined) set('features', JSON.stringify(p.features))
  if (p.is_active !== undefined) set('is_active', Boolean(p.is_active))
  if (!sets.length) return (await query('SELECT * FROM plans WHERE id = $1', [id])).rows[0]
  params.push(id)
  const { rows } = await query(`UPDATE plans SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params)
  return rows[0]
}

export async function getSubscription(agentId) {
  return (
    await query(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_paise, p.conversation_quota, p.features
       FROM agent_subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.agent_id = $1`,
      [agentId],
    )
  ).rows[0] || null
}

// Assign or move an agent onto a plan (one subscription per agent).
export async function setSubscription(agentId, planId, status = 'active') {
  const plan = (await query('SELECT id FROM plans WHERE id = $1', [planId])).rows[0]
  if (!plan) fail('Plan not found', 'NOT_FOUND')
  await query(
    `INSERT INTO agent_subscriptions (agent_id, plan_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, updated_at = now()`,
    [agentId, planId, status],
  )
  return getSubscription(agentId)
}

// Per-tenant metering for a period: WhatsApp conversations by category (from the
// outbound send log, plus inbound service conversations) and the estimated Meta
// cost, compared against the plan quota.
export async function agentUsage(agentId, { start, end } = {}) {
  const from = start || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const to = end || new Date().toISOString().slice(0, 10)
  const sends = (
    await query(
      `SELECT kind, COUNT(*)::int AS n FROM message_sends
       WHERE agent_id = $1 AND sent_at >= $2::date AND sent_at < ($3::date + 1) GROUP BY kind`,
      [agentId, from, to],
    )
  ).rows
  // festive greetings bill as marketing.
  const counts = { marketing: 0, utility: 0, authentication: 0, service: 0 }
  for (const r of sends) {
    const cat = r.kind === 'festive' ? 'marketing' : r.kind
    counts[cat] = (counts[cat] || 0) + r.n
  }
  // Service conversations: distinct leads that sent an inbound message in-period.
  const service = (
    await query(
      `SELECT COUNT(DISTINCT m.lead_id)::int AS n FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE l.agent_id = $1 AND m.role = 'buyer' AND m.created_at >= $2::date AND m.created_at < ($3::date + 1)`,
      [agentId, from, to],
    )
  ).rows[0].n
  counts.service += service

  const byCategory = Object.entries(counts).map(([category, count]) => ({
    category,
    count,
    // `counts` starts as the four billable categories and only ever gains a key from
    // message_sends.kind, which the schema constrains to marketing/utility/service/
    // festive (and festive is folded into marketing above) — so every category here
    // has a rate and the `?? 0` never fires. It guards a new kind being added to the
    // CHECK without a rate being added here, which would otherwise be NaN money.
    /* node:coverage ignore next 2 */
    rate_paise: META_RATE_PAISE[category] ?? 0,
    cost_paise: count * (META_RATE_PAISE[category] ?? 0),
  }))
  const totalConversations = byCategory.reduce((s, c) => s + c.count, 0)
  const metaCost = byCategory.reduce((s, c) => s + c.cost_paise, 0)
  const sub = await getSubscription(agentId)
  const quota = sub?.conversation_quota ?? null
  return {
    period_start: from,
    period_end: to,
    by_category: byCategory,
    total_conversations: totalConversations,
    meta_cost_paise: metaCost,
    quota,
    over_quota: quota == null ? 0 : Math.max(0, totalConversations - quota),
  }
}

// Generate a GST invoice for a period: plan subscription fee + any conversation
// overage. Amounts are paise; GST (default 18%) is split out explicitly.
export async function generateInvoice(agentId, { periodStart, periodEnd, note } = {}) {
  const sub = await getSubscription(agentId)
  const usage = await agentUsage(agentId, { start: periodStart, end: periodEnd })
  const lineItems = []
  if (sub) {
    lineItems.push({
      description: `${sub.plan_name} plan — ${usage.period_start} to ${usage.period_end}`,
      qty: 1,
      unit_paise: Number(sub.price_paise),
      amount_paise: Number(sub.price_paise),
    })
  }
  if (usage.over_quota > 0) {
    lineItems.push({
      description: `Conversation overage (${usage.over_quota} over ${usage.quota})`,
      qty: usage.over_quota,
      unit_paise: OVERAGE_RATE_PAISE,
      amount_paise: usage.over_quota * OVERAGE_RATE_PAISE,
    })
  }
  const subtotal = lineItems.reduce((s, li) => s + li.amount_paise, 0)
  const gst = gstBreakdown(subtotal, GST_RATE)

  const yyyymm = (usage.period_end || '').replace(/-/g, '').slice(0, 6)
  const seq =
    (await query('SELECT COUNT(*)::int AS n FROM invoices WHERE agent_id = $1', [agentId])).rows[0].n + 1
  const number = `HNX-${yyyymm}-${String(agentId).padStart(3, '0')}-${String(seq).padStart(3, '0')}`

  const { rows } = await query(
    `INSERT INTO invoices (agent_id, number, period_start, period_end, subtotal_paise, gst_rate, gst_paise, total_paise, line_items, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      agentId,
      number,
      usage.period_start,
      usage.period_end,
      gst.subtotal_paise,
      gst.gst_rate,
      gst.gst_paise,
      gst.total_paise,
      JSON.stringify(lineItems),
      note ?? null,
    ],
  )
  return rows[0]
}

async function listInvoices(agentId) {
  return (await query('SELECT * FROM invoices WHERE agent_id = $1 ORDER BY issued_at DESC', [agentId])).rows
}

export async function getInvoice(id, { agentId = null } = {}) {
  const where = agentId ? 'id = $1 AND agent_id = $2' : 'id = $1'
  const params = agentId ? [id, agentId] : [id]
  return (await query(`SELECT * FROM invoices WHERE ${where}`, params)).rows[0] || null
}

export async function setInvoiceStatus(id, status) {
  if (!['draft', 'issued', 'paid', 'void'].includes(status)) fail('Invalid invoice status')
  const paid = status === 'paid' ? ', paid_at = now()' : status === 'issued' || status === 'draft' ? ', paid_at = NULL' : ''
  const { rows } = await query(`UPDATE invoices SET status = $1${paid} WHERE id = $2 RETURNING *`, [status, id])
  if (!rows[0]) fail('Invoice not found', 'NOT_FOUND')
  return rows[0]
}

// Everything the billing screen needs for one agent: plan, live usage, invoices.
export async function billingOverview(agentId) {
  return {
    subscription: await getSubscription(agentId),
    usage: await agentUsage(agentId, {}),
    invoices: await listInvoices(agentId),
  }
}

// ===========================================================================
// §7.4 Support tickets
// ===========================================================================

export async function createTicket(agentId, { subject, body, category = 'general', priority = 'normal' } = {}) {
  if (!subject || !String(subject).trim()) fail('A subject is required')
  if (!body || !String(body).trim()) fail('A message is required')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO support_tickets (agent_id, subject, category, priority)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [agentId, String(subject).trim(), category, priority],
    )
    await client.query(
      'INSERT INTO support_ticket_messages (ticket_id, author_agent_id, is_staff, body) VALUES ($1, $2, false, $3)',
      [rows[0].id, agentId, String(body).trim()],
    )
    await client.query('COMMIT')
    return rows[0]
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// List tickets. Pass agentId to scope to one tenant (the agent's own view);
// omit it for the staff queue across all tenants.
export async function listTickets({ status = '', agentId = null } = {}) {
  const where = []
  const params = []
  if (agentId) {
    params.push(agentId)
    where.push(`t.agent_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    where.push(`t.status = $${params.length}`)
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''
  return (
    await query(
      `SELECT t.*, a.name AS agent_name, a.phone AS agent_phone, a.business_name,
              (SELECT COUNT(*) FROM support_ticket_messages m WHERE m.ticket_id = t.id)::int AS message_count
       FROM support_tickets t JOIN agents a ON a.id = t.agent_id
       ${whereSql}
       ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'pending' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
                t.updated_at DESC`,
      params,
    )
  ).rows
}

export async function getTicket(id, { agentId = null } = {}) {
  const where = agentId ? 't.id = $1 AND t.agent_id = $2' : 't.id = $1'
  const params = agentId ? [id, agentId] : [id]
  const ticket = (
    await query(
      `SELECT t.*, a.name AS agent_name, a.phone AS agent_phone, a.email AS agent_email,
              a.business_name, a.city, a.waba_status
       FROM support_tickets t JOIN agents a ON a.id = t.agent_id WHERE ${where}`,
      params,
    )
  ).rows[0]
  if (!ticket) return null
  ticket.messages = (
    await query(
      `SELECT m.*, a.name AS author_name FROM support_ticket_messages m
       LEFT JOIN agents a ON a.id = m.author_agent_id WHERE m.ticket_id = $1 ORDER BY m.id`,
      [id],
    )
  ).rows
  return ticket
}

export async function addTicketMessage(ticketId, { authorAgentId, isStaff, body }, { agentId = null } = {}) {
  if (!body || !String(body).trim()) fail('A message is required')
  // When an agent replies to their own ticket, scope the existence check to them.
  const exists = (
    await query(
      agentId ? 'SELECT 1 FROM support_tickets WHERE id = $1 AND agent_id = $2' : 'SELECT 1 FROM support_tickets WHERE id = $1',
      agentId ? [ticketId, agentId] : [ticketId],
    )
  ).rows[0]
  if (!exists) fail('Ticket not found', 'NOT_FOUND')
  const { rows } = await query(
    'INSERT INTO support_ticket_messages (ticket_id, author_agent_id, is_staff, body) VALUES ($1, $2, $3, $4) RETURNING *',
    [ticketId, authorAgentId ?? null, Boolean(isStaff), String(body).trim()],
  )
  // A staff reply moves an open ticket to pending (awaiting the agent); an agent
  // reply re-opens it. updated_at bumps either way so the queue re-sorts.
  await query(
    `UPDATE support_tickets SET status = CASE
        WHEN $2 AND status = 'open' THEN 'pending'
        WHEN NOT $2 AND status IN ('pending','resolved') THEN 'open'
        ELSE status END,
      updated_at = now() WHERE id = $1`,
    [ticketId, Boolean(isStaff)],
  )
  return rows[0]
}

export async function updateTicket(id, { status, priority, assigned_to } = {}) {
  const sets = []
  const params = []
  const set = (col, val) => (params.push(val), sets.push(`${col} = $${params.length}`))
  if (status !== undefined) {
    if (!['open', 'pending', 'resolved', 'closed'].includes(status)) fail('Invalid ticket status')
    set('status', status)
    sets.push(`resolved_at = ${status === 'resolved' || status === 'closed' ? 'now()' : 'NULL'}`)
  }
  if (priority !== undefined) set('priority', priority)
  if (assigned_to !== undefined) set('assigned_to', assigned_to || null)
  if (!sets.length) return (await query('SELECT * FROM support_tickets WHERE id = $1', [id])).rows[0]
  params.push(id)
  const { rows } = await query(
    `UPDATE support_tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
    params,
  )
  if (!rows[0]) fail('Ticket not found', 'NOT_FOUND')
  return rows[0]
}

// ===========================================================================
// §7.5 Platform analytics: cohorts, retention, feature usage, per-city
// ===========================================================================

export async function platformAnalytics() {
  // Signup cohorts by ISO week, with the share that activated (captured a lead).
  const cohorts = (
    await query(
      `SELECT to_char(date_trunc('week', a.created_at), 'YYYY-MM-DD') AS week,
              COUNT(*)::int AS signups,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM leads l WHERE l.agent_id = a.id))::int AS activated
       FROM agents a
       WHERE a.created_at >= now() - interval '12 weeks'
       GROUP BY 1 ORDER BY 1`,
    )
  ).rows

  // Retention: agents with any activity in the last 1/7/30 days.
  const retention = (
    await query(
      `SELECT
         COUNT(DISTINCT agent_id) FILTER (WHERE created_at >= now() - interval '1 day')::int AS active_1d,
         COUNT(DISTINCT agent_id) FILTER (WHERE created_at >= now() - interval '7 days')::int AS active_7d,
         COUNT(DISTINCT agent_id) FILTER (WHERE created_at >= now() - interval '30 days')::int AS active_30d
       FROM activity`,
    )
  ).rows[0]

  // Feature usage: how many agents actually use each surface.
  const usage = (
    await query(
      `SELECT
         (SELECT COUNT(*) FROM teams)::int AS teams,
         (SELECT COUNT(DISTINCT agent_id) FROM properties)::int AS agents_with_properties,
         (SELECT COUNT(DISTINCT agent_id) FROM site_visits)::int AS agents_with_site_visits,
         (SELECT COUNT(DISTINCT agent_id) FROM message_templates)::int AS agents_with_templates,
         (SELECT COUNT(DISTINCT agent_id) FROM commissions)::int AS agents_with_commissions,
         (SELECT COUNT(DISTINCT agent_id) FROM contact_groups)::int AS agents_with_groups`,
    )
  ).rows[0]

  // Per-city distribution of agents (top 12 cities).
  const cities = (
    await query(
      `SELECT COALESCE(NULLIF(TRIM(city), ''), 'Unknown') AS city, COUNT(*)::int AS agents
       FROM agents GROUP BY 1 ORDER BY agents DESC LIMIT 12`,
    )
  ).rows

  return { cohorts, retention, feature_usage: usage, cities }
}
