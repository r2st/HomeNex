import { Router } from 'express'
import {
  getAgent,
  adminStats,
  listAgentsAdmin,
  getAgentDetail,
  updateAgentProfile,
  updateWabaStatus,
  ensureAdminExists,
} from './db.js'

// Express 4 doesn't forward rejected-promise errors from async handlers; wrap them.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

const router = Router()

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

// GET /api/admin/agents?search=&status=&page=&pageSize= — paginated agent list.
router.get('/agents', ah(async (req, res) => {
  res.json(
    await listAgentsAdmin({
      search: String(req.query.search || '').trim(),
      status: String(req.query.status || '').trim(),
      page: req.query.page,
      pageSize: req.query.pageSize,
    }),
  )
}))

// GET /api/admin/agents/:id — full agent detail.
router.get('/agents/:id', ah(async (req, res) => {
  const agent = await getAgentDetail(Number(req.params.id))
  if (!agent) return res.status(404).json({ error: 'Agent not found' })
  res.json(agent)
}))

// PUT /api/admin/agents/:id — edit profile (name, email, phone, is_admin).
router.put('/agents/:id', ah(async (req, res) => {
  const { name, email, phone, is_admin } = req.body ?? {}
  try {
    res.json(await updateAgentProfile(Number(req.params.id), { name, email, phone, is_admin }))
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    const status = err.code === 'EMAIL_TAKEN' || err.code === 'PHONE_TAKEN' ? 409 : 400
    res.status(status).json({ error: err.message })
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
