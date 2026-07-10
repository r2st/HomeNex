import { Router } from 'express'
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
router.put('/agents/:id', ah(async (req, res) => {
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
router.put('/agents/:id/waba', ah(async (req, res) => {
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

export default router
