import { Router } from 'express'
import db, {
  getAgent,
  adminStats,
  listAgentsAdmin,
  getAgentDetail,
  updateAgentProfile,
  updateWabaStatus,
} from './db.js'

// Auto-promote the first agent to admin if no admins exist yet, so a fresh
// install always has a way into the admin site. Called lazily on every admin hit.
function ensureAdminExists() {
  const hasAdmin = db.prepare('SELECT 1 FROM agents WHERE is_admin = 1 LIMIT 1').get()
  if (!hasAdmin) {
    const first = db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get()
    if (first) {
      db.prepare('UPDATE agents SET is_admin = 1 WHERE id = ?').run(first.id)
      console.log(`Auto-promoted agent #${first.id} to admin (first agent)`)
    }
  }
}

const router = Router()

// requireAdmin: every route below needs a logged-in admin. req.agent is re-read
// from the DB because ensureAdminExists() may have just promoted this agent.
router.use((req, res, next) => {
  ensureAdminExists()
  const fresh = req.agent && getAgent(req.agent.id)
  if (!fresh || fresh.is_admin !== 1) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  req.agent = fresh
  next()
})

// GET /api/admin/dashboard — platform-wide stats.
router.get('/dashboard', (_req, res) => res.json(adminStats()))

// GET /api/admin/agents?search=&status=&page=&pageSize= — paginated agent list.
router.get('/agents', (req, res) => {
  res.json(
    listAgentsAdmin({
      search: String(req.query.search || '').trim(),
      status: String(req.query.status || '').trim(),
      page: req.query.page,
      pageSize: req.query.pageSize,
    }),
  )
})

// GET /api/admin/agents/:id — full agent detail.
router.get('/agents/:id', (req, res) => {
  const agent = getAgentDetail(Number(req.params.id))
  if (!agent) return res.status(404).json({ error: 'Agent not found' })
  res.json(agent)
})

// PUT /api/admin/agents/:id — edit profile (name, email, phone, is_admin).
router.put('/agents/:id', (req, res) => {
  const { name, email, phone, is_admin } = req.body ?? {}
  try {
    res.json(updateAgentProfile(Number(req.params.id), { name, email, phone, is_admin }))
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    const status = err.code === 'EMAIL_TAKEN' || err.code === 'PHONE_TAKEN' ? 409 : 400
    res.status(status).json({ error: err.message })
  }
})

// PUT /api/admin/agents/:id/waba — update WABA registration config/status.
router.put('/agents/:id/waba', (req, res) => {
  const { status, meta_waba_id, wa_phone_number_id, wa_phone_number } = req.body ?? {}
  if (!status) return res.status(400).json({ error: 'status is required' })
  if (!getAgent(Number(req.params.id))) return res.status(404).json({ error: 'Agent not found' })
  try {
    const updated = updateWabaStatus(Number(req.params.id), {
      status,
      metaWabaId: meta_waba_id,
      waPhoneNumberId: wa_phone_number_id,
      waPhoneNumber: wa_phone_number,
    })
    res.json(updated)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
