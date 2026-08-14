import { Router } from 'express'
import { boundedText, TEXT } from './middleware.js'
import {
  getAgent,
  adminStats,
  listAgentsAdmin,
  getAgentDetail,
  updateAgentProfile,
  updateWabaStatus,
  ensureAdminExists,
  setAgentAdmin,
  setAgentActive,
  listAllAuditLogs,
  logAudit,
} from './db.js'
import { issueToken } from './auth.js'
import {
  onboardingQueue,
  setAgentKyc,
  setAgentReraVerified,
  wabaHealthBoard,
  pendingReviewTemplates,
  reviewTemplate,
  listPlans,
  createPlan,
  updatePlan,
  setSubscription,
  billingOverview,
  generateInvoice,
  getInvoice,
  setInvoiceStatus,
  listTickets,
  getTicket,
  addTicketMessage,
  updateTicket,
  platformAnalytics,
} from './adminPortal.js'

// Express 4 doesn't forward rejected-promise errors from async handlers; wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

const router = Router()

// Guard failures are the admin's fault (409 Conflict), not a malformed request.
const TEAM_ERROR_STATUS = {
  NOT_FOUND: 404,
  SELF_DEMOTE: 409,
  SELF_DEACTIVATE: 409,
  LAST_ADMIN: 409,
  AGENT_INACTIVE: 409,
}

// requireAdmin: every route below needs a logged-in admin. ensureAdminExists()
// auto-promotes the first agent if no admins exist yet, so a fresh install always
// has a way into the admin site; req.agent is re-read because that promotion may
// have just happened.
router.use(ah(async (req, res, next) => {
  await ensureAdminExists()
  const fresh = req.agent && (await getAgent(req.agent.id))
  if (!fresh || fresh.is_admin !== 1) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  req.agent = fresh
  next()
}))

// GET /api/admin/dashboard — platform-wide stats.
router.get('/dashboard', ah(async (_req, res) => res.json(await adminStats())))

// GET /api/admin/agents?search=&status=&active=&page=&pageSize= — paginated agent list.
router.get('/agents', ah(async (req, res) => {
  res.json(
    await listAgentsAdmin({
      search: String(req.query.search || '').trim(),
      status: String(req.query.status || '').trim(),
      active: String(req.query.active ?? '').trim(),
      page: req.query.page,
      pageSize: req.query.pageSize,
    }),
  )
}))

// GET /api/admin/audit-logs?limit= — platform-wide audit trail.
router.get('/audit-logs', ah(async (req, res) => res.json(await listAllAuditLogs(req.query.limit))))

// GET /api/admin/agents/:id — full agent detail.
router.get('/agents/:id', ah(async (req, res) => {
  const agent = await getAgentDetail(Number(req.params.id))
  if (!agent) return res.status(404).json({ error: 'Agent not found' })
  res.json(agent)
}))

// PUT /api/admin/agents/:id — edit profile (name, email, phone, is_admin).
// An is_admin change goes through setAgentAdmin() so this route can't be used to
// bypass the self-demote / last-admin guards enforced on /agents/:id/admin.
router.put('/agents/:id', boundedText({ name: TEXT.LINE, email: TEXT.LINE, phone: TEXT.LINE }), ah(async (req, res) => {
  const { name, email, phone, is_admin } = req.body ?? {}
  const id = Number(req.params.id)
  try {
    if (is_admin !== undefined) await setAgentAdmin(req.agent.id, id, Boolean(is_admin))
    res.json(await updateAgentProfile(id, { name, email, phone }))
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    const status = TEAM_ERROR_STATUS[err.code] ?? (err.code === 'EMAIL_TAKEN' || err.code === 'PHONE_TAKEN' ? 409 : 400)
    res.status(status).json({ error: err.message })
  }
}))

// PUT /api/admin/agents/:id/admin — grant or revoke admin access.
router.put('/agents/:id/admin', ah(async (req, res) => {
  const { is_admin } = req.body ?? {}
  if (typeof is_admin !== 'boolean') return res.status(400).json({ error: 'is_admin must be true or false' })
  try {
    const agent = await setAgentAdmin(req.agent.id, Number(req.params.id), is_admin)
    await logAudit(req.agent.id, 'agent', agent.id, is_admin ? 'admin_granted' : 'admin_revoked', {
      target: agent.name,
    })
    res.json(agent)
  } catch (err) {
    res.status(TEAM_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// PUT /api/admin/agents/:id/active — suspend or restore an agent's access.
router.put('/agents/:id/active', ah(async (req, res) => {
  const { is_active } = req.body ?? {}
  if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false' })
  try {
    const agent = await setAgentActive(req.agent.id, Number(req.params.id), is_active)
    await logAudit(req.agent.id, 'agent', agent.id, is_active ? 'agent_reactivated' : 'agent_deactivated', {
      target: agent.name,
    })
    res.json(agent)
  } catch (err) {
    res.status(TEAM_ERROR_STATUS[err.code] ?? 400).json({ error: err.message })
  }
}))

// PUT /api/admin/agents/:id/waba — update WABA registration config/status.
router.put('/agents/:id/waba', boundedText({
  status: TEXT.LINE, meta_waba_id: TEXT.LINE, wa_phone_number_id: TEXT.LINE, wa_phone_number: TEXT.LINE,
}), ah(async (req, res) => {
  const { status, meta_waba_id, wa_phone_number_id, wa_phone_number } = req.body ?? {}
  if (!status) return res.status(400).json({ error: 'status is required' })
  if (!(await getAgent(Number(req.params.id)))) return res.status(404).json({ error: 'Agent not found' })
  try {
    const updated = await updateWabaStatus(Number(req.params.id), {
      status,
      metaWabaId: meta_waba_id,
      waPhoneNumberId: wa_phone_number_id,
      waPhoneNumber: wa_phone_number,
    })
    res.json(updated)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// A coded error from the portal layer → HTTP status.
const portalErr = (res, err) => {
  const status = err.code === 'NOT_FOUND' ? 404 : 400
  res.status(status).json({ error: err.message, code: err.code })
}

// ===========================================================================
// §7.1 Onboarding, KYC/RERA verification, WABA health, impersonation
// ===========================================================================

router.get('/onboarding', ah(async (_req, res) => res.json(await onboardingQueue())))

router.put('/agents/:id/kyc', boundedText({ status: TEXT.LINE, note: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const result = await setAgentKyc(req.agent.id, Number(req.params.id), {
      status: req.body?.status,
      note: req.body?.note,
    })
    await logAudit(req.agent.id, 'agent', Number(req.params.id), 'kyc_reviewed', { status: result.kyc_status })
    res.json(result)
  } catch (err) {
    portalErr(res, err)
  }
}))

router.put('/agents/:id/rera-verify', ah(async (req, res) => {
  try {
    const result = await setAgentReraVerified(Number(req.params.id), Boolean(req.body?.verified))
    await logAudit(req.agent.id, 'agent', Number(req.params.id), 'rera_verified', { verified: result.rera_verified })
    res.json(result)
  } catch (err) {
    portalErr(res, err)
  }
}))

router.get('/waba-health', ah(async (_req, res) => res.json(await wabaHealthBoard())))

// Impersonation: mint a normal agent session for the target, audited. Staff use
// this to reproduce an agent's view; the token is an ordinary login token.
router.post('/agents/:id/impersonate', ah(async (req, res) => {
  const target = await getAgent(Number(req.params.id))
  if (!target) return res.status(404).json({ error: 'Agent not found' })
  if (target.is_active !== 1) return res.status(409).json({ error: 'Cannot impersonate a deactivated agent' })
  await logAudit(req.agent.id, 'agent', target.id, 'impersonation_started', { target: target.name })
  res.json({ token: await issueToken(target.id, target.token_version), agent: target })
}))

// ===========================================================================
// §7.2 Template approval workflow
// ===========================================================================

router.get('/templates/pending', ah(async (_req, res) => res.json(await pendingReviewTemplates())))

router.put('/templates/:id/review', boundedText({ action: TEXT.LINE, note: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const tpl = await reviewTemplate(req.agent.id, Number(req.params.id), {
      action: req.body?.action,
      note: req.body?.note,
    })
    await logAudit(req.agent.id, 'template', tpl.id, `template_${tpl.review_status}`, { name: tpl.name })
    res.json(tpl)
  } catch (err) {
    portalErr(res, err)
  }
}))

// ===========================================================================
// §7.3 Billing & usage
// ===========================================================================

router.get('/plans', ah(async (_req, res) => res.json(await listPlans())))

router.post('/plans', ah(async (req, res) => {
  try {
    res.json(await createPlan(req.body ?? {}))
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A plan with that code exists' })
    portalErr(res, err)
  }
}))

router.put('/plans/:id', ah(async (req, res) => res.json(await updatePlan(Number(req.params.id), req.body ?? {}))))

router.get('/agents/:id/billing', ah(async (req, res) => {
  if (!(await getAgent(Number(req.params.id)))) return res.status(404).json({ error: 'Agent not found' })
  res.json(await billingOverview(Number(req.params.id)))
}))

router.put('/agents/:id/subscription', ah(async (req, res) => {
  try {
    const sub = await setSubscription(Number(req.params.id), Number(req.body?.plan_id), req.body?.status || 'active')
    await logAudit(req.agent.id, 'agent', Number(req.params.id), 'subscription_set', { plan_id: sub.plan_id })
    res.json(sub)
  } catch (err) {
    portalErr(res, err)
  }
}))

router.post('/agents/:id/invoices', boundedText({ note: TEXT.PROSE }), ah(async (req, res) => {
  if (!(await getAgent(Number(req.params.id)))) return res.status(404).json({ error: 'Agent not found' })
  try {
    const invoice = await generateInvoice(Number(req.params.id), {
      periodStart: req.body?.period_start,
      periodEnd: req.body?.period_end,
      note: req.body?.note,
    })
    await logAudit(req.agent.id, 'invoice', invoice.id, 'invoice_generated', { number: invoice.number })
    res.json(invoice)
  } catch (err) {
    portalErr(res, err)
  }
}))

router.get('/invoices/:id', ah(async (req, res) => {
  const invoice = await getInvoice(Number(req.params.id))
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
  res.json(invoice)
}))

router.put('/invoices/:id/status', boundedText({ status: TEXT.LINE }), ah(async (req, res) => {
  try {
    const invoice = await setInvoiceStatus(Number(req.params.id), req.body?.status)
    await logAudit(req.agent.id, 'invoice', invoice.id, 'invoice_status', { status: invoice.status })
    res.json(invoice)
  } catch (err) {
    portalErr(res, err)
  }
}))

// ===========================================================================
// §7.4 Support tickets
// ===========================================================================

router.get('/tickets', ah(async (req, res) =>
  res.json(await listTickets({ status: String(req.query.status || '').trim() })),
))

router.get('/tickets/:id', ah(async (req, res) => {
  const ticket = await getTicket(Number(req.params.id))
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' })
  res.json(ticket)
}))

router.post('/tickets/:id/reply', boundedText({ body: TEXT.PROSE }), ah(async (req, res) => {
  try {
    const msg = await addTicketMessage(Number(req.params.id), {
      authorAgentId: req.agent.id,
      isStaff: true,
      body: req.body?.body,
    })
    res.json(msg)
  } catch (err) {
    portalErr(res, err)
  }
}))

router.put('/tickets/:id', ah(async (req, res) => {
  try {
    const ticket = await updateTicket(Number(req.params.id), {
      status: req.body?.status,
      priority: req.body?.priority,
      assigned_to: req.body?.assigned_to,
    })
    res.json(ticket)
  } catch (err) {
    portalErr(res, err)
  }
}))

// ===========================================================================
// §7.5 Platform analytics
// ===========================================================================

router.get('/analytics', ah(async (_req, res) => res.json(await platformAnalytics())))

export default router
