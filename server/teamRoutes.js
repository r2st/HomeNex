// Team Management API (§5.3). Mounted at /api/team, below requireAuth, so every
// handler has req.agent. The privacy wall lives here: manager/owner-only views are
// gated by requireRole(); a plain agent can only ever reach their own leads through
// the existing /api/leads routes.
import { Router } from 'express'
import {
  getAgentTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  listTeamMembers,
  inviteToTeam,
  listTeamInvites,
  listIncomingInvites,
  respondToInvite,
  revokeInvite,
  setMemberRole,
  updateMember,
  removeMember,
  teamLeads,
  teamPipeline,
  teamLeaderboard,
  teamStaleLeads,
  assignTeamLead,
  autoAssignTeamLead,
  distributeTeamPool,
  claimTeamLead,
  getLead,
  logAudit,
} from './db.js'
import { boundedText, TEXT } from './middleware.js'

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// fail()-code → HTTP status. Everything else is a 400 bad request.
const STATUS = {
  ALREADY_IN_TEAM: 409,
  ALREADY_MEMBER: 409,
  IN_OTHER_TEAM: 409,
  DUP_INVITE: 409,
  OWNER_ROLE: 409,
  OWNER_REMOVE: 409,
  NOT_FOUND: 404,
  NOT_MEMBER: 404,
  WRONG_INVITEE: 403,
  INVALID_PHONE: 400,
}
const sendErr = (res, err) => res.status(STATUS[err.code] ?? 400).json({ error: err.message, code: err.code })

const router = Router()

// Attach the caller's team (if any) to req.team for the handlers below.
router.use(ah(async (req, _res, next) => {
  req.team = await getAgentTeam(req.agent.id)
  next()
}))

// Gate a route to members holding one of the given roles. 403 for solo agents or
// members whose role is below the bar — this is the privacy wall.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.team) return res.status(404).json({ error: 'You are not in a team', code: 'NO_TEAM' })
  if (!roles.includes(req.team.role)) {
    return res.status(403).json({ error: 'This needs a manager or owner', code: 'FORBIDDEN' })
  }
  next()
}
const requireManager = requireRole('owner', 'manager')
const requireOwner = requireRole('owner')
const requireMember = requireRole('owner', 'manager', 'agent')

// --- Team context ---

// GET /api/team — the caller's full team context, or, for a solo agent, any
// pending invitations addressed to them so they can join.
router.get('/', ah(async (req, res) => {
  if (!req.team) {
    return res.json({ team: null, role: null, incoming_invites: await listIncomingInvites(req.agent.phone) })
  }
  const isManager = req.team.role === 'owner' || req.team.role === 'manager'
  res.json({
    team: {
      id: req.team.id,
      name: req.team.name,
      owner_agent_id: req.team.owner_agent_id,
      assignment_strategy: req.team.assignment_strategy,
      shared_wa_phone_number_id: req.team.shared_wa_phone_number_id,
    },
    role: req.team.role,
    localities: req.team.localities,
    accepts_leads: req.team.accepts_leads,
    members: await listTeamMembers(req.team.id),
    invites: isManager ? await listTeamInvites(req.team.id) : [],
  })
}))

// POST /api/team — create a team; the caller becomes owner.
router.post('/', ah(async (req, res) => {
  try {
    const team = await createTeam(req.agent.id, req.body?.name)
    await logAudit(req.agent.id, 'team', team.id, 'team_created', { name: team.name })
    res.json(team)
  } catch (err) {
    sendErr(res, err)
  }
}))

// PUT /api/team — owner edits name / assignment strategy / shared line.
router.put('/', requireOwner, boundedText({ assignment_strategy: TEXT.LINE, shared_wa_phone_number_id: TEXT.LINE }), ah(async (req, res) => {
  const { name, assignment_strategy, shared_wa_phone_number_id } = req.body ?? {}
  const fields = {}
  if (name !== undefined) fields.name = name
  if (assignment_strategy !== undefined) {
    if (!['round_robin', 'locality', 'manual', 'pool'].includes(assignment_strategy)) {
      return res.status(400).json({ error: 'Unknown assignment strategy' })
    }
    fields.assignment_strategy = assignment_strategy
  }
  if (shared_wa_phone_number_id !== undefined) fields.shared_wa_phone_number_id = shared_wa_phone_number_id || null
  try {
    const team = await updateTeam(req.team.id, fields)
    await logAudit(req.agent.id, 'team', team.id, 'team_updated', fields)
    res.json(team)
  } catch (err) {
    sendErr(res, err)
  }
}))

// DELETE /api/team — owner disbands the team.
router.delete('/', requireOwner, ah(async (req, res) => {
  await deleteTeam(req.team.id)
  await logAudit(req.agent.id, 'team', req.team.id, 'team_deleted', { name: req.team.name })
  res.json({ ok: true })
}))

// --- Members ---

router.get('/members', requireMember, ah(async (req, res) => res.json(await listTeamMembers(req.team.id))))

// PUT /api/team/members/:agentId/role — owner changes a member's role.
router.put('/members/:agentId/role', requireOwner, boundedText({ role: TEXT.LINE }), ah(async (req, res) => {
  try {
    const member = await setMemberRole(req.team.id, Number(req.params.agentId), req.body?.role)
    await logAudit(req.agent.id, 'team', req.team.id, 'member_role_changed', {
      agent_id: Number(req.params.agentId),
      role: member.role,
    })
    res.json(member)
  } catch (err) {
    sendErr(res, err)
  }
}))

// PUT /api/team/members/:agentId — owner/manager sets a member's localities /
// whether they receive auto-assigned leads.
router.put('/members/:agentId', requireManager, ah(async (req, res) => {
  const fields = {}
  if (req.body?.localities !== undefined) fields.localities = req.body.localities
  if (req.body?.accepts_leads !== undefined) fields.accepts_leads = req.body.accepts_leads
  try {
    res.json(await updateMember(req.team.id, Number(req.params.agentId), fields))
  } catch (err) {
    sendErr(res, err)
  }
}))

// DELETE /api/team/members/:agentId — remove a member (owner/manager), or leave
// the team yourself. The owner can't be removed; disband the team instead.
router.delete('/members/:agentId', requireMember, ah(async (req, res) => {
  const targetId = Number(req.params.agentId)
  const isSelf = targetId === req.agent.id
  if (!isSelf && req.team.role === 'agent') {
    return res.status(403).json({ error: 'This needs a manager or owner', code: 'FORBIDDEN' })
  }
  try {
    await removeMember(req.team.id, targetId)
    await logAudit(req.agent.id, 'team', req.team.id, isSelf ? 'member_left' : 'member_removed', { agent_id: targetId })
    res.json({ ok: true })
  } catch (err) {
    sendErr(res, err)
  }
}))

// --- Invitations ---

router.post('/invites', requireManager, boundedText({ phone: TEXT.LINE, role: TEXT.LINE }), ah(async (req, res) => {
  try {
    const invite = await inviteToTeam(req.team.id, req.agent.id, {
      phone: req.body?.phone,
      role: req.body?.role || 'agent',
    })
    await logAudit(req.agent.id, 'team', req.team.id, 'member_invited', { phone: invite.phone, role: invite.role })
    res.json(invite)
  } catch (err) {
    sendErr(res, err)
  }
}))

router.get('/invites', requireManager, ah(async (req, res) => res.json(await listTeamInvites(req.team.id))))

router.get('/invites/incoming', ah(async (req, res) => res.json(await listIncomingInvites(req.agent.phone))))

router.delete('/invites/:id', requireManager, ah(async (req, res) => {
  const ok = await revokeInvite(Number(req.params.id), req.team.id)
  if (!ok) return res.status(404).json({ error: 'Invite not found or already handled' })
  res.json({ ok: true })
}))

// Invitee responds. No team role needed — the acceptor is (by definition) not yet
// on the team; respondToInvite checks the invite is addressed to their number.
router.post('/invites/:id/accept', ah(async (req, res) => {
  try {
    res.json(await respondToInvite(Number(req.params.id), req.agent, true))
  } catch (err) {
    sendErr(res, err)
  }
}))

router.post('/invites/:id/decline', ah(async (req, res) => {
  try {
    res.json(await respondToInvite(Number(req.params.id), req.agent, false))
  } catch (err) {
    sendErr(res, err)
  }
}))

// --- Manager views: shared inbox, pipeline, leaderboard, stale leads ---

router.get('/leads', requireManager, ah(async (req, res) =>
  res.json(
    await teamLeads(req.team.id, {
      memberId: req.query.member ? Number(req.query.member) : null,
      stage: req.query.stage || '',
      pipelineType: req.query.pipeline_type || '',
      unassigned: req.query.unassigned === '1',
      limit: req.query.limit,
      offset: req.query.offset,
    }),
  ),
))

router.get('/pipeline', requireManager, ah(async (req, res) => {
  const type = req.query.type || 'buy_primary'
  if (!['buy_primary', 'buy_resale', 'rental'].includes(type)) {
    return res.status(400).json({ error: 'bad pipeline type' })
  }
  res.json(await teamPipeline(req.team.id, type))
}))

router.get('/leaderboard', requireManager, ah(async (req, res) => res.json(await teamLeaderboard(req.team.id))))

router.get('/stale', requireManager, ah(async (req, res) =>
  res.json(await teamStaleLeads(req.team.id, req.query.days ? Number(req.query.days) : 3)),
))

// --- Assignment ---

// Manual assign / reassign a team lead to a member.
router.post('/leads/:id/assign', requireManager, ah(async (req, res) => {
  const targetId = Number(req.body?.agent_id)
  if (!targetId) return res.status(400).json({ error: 'agent_id is required' })
  try {
    const lead = await assignTeamLead(req.team.id, Number(req.params.id), targetId)
    if (!lead) return res.status(404).json({ error: 'lead not found in this team' })
    await logAudit(req.agent.id, 'lead', lead.id, 'team_assign', { to: targetId })
    res.json(lead)
  } catch (err) {
    sendErr(res, err)
  }
}))

// Auto-assign one lead using the team's strategy (round-robin / locality).
router.post('/leads/:id/auto-assign', requireManager, ah(async (req, res) => {
  const lead = await getLead(Number(req.params.id))
  if (!lead || lead.team_id !== req.team.id) return res.status(404).json({ error: 'lead not found in this team' })
  const assigned = await autoAssignTeamLead(req.team.id, lead.id, { locality: lead.locality })
  if (!assigned) {
    return res.status(400).json({
      error: 'Auto-assign needs a round-robin or locality strategy — assign this lead by hand',
      code: 'NO_AUTO_STRATEGY',
    })
  }
  await logAudit(req.agent.id, 'lead', lead.id, 'team_auto_assign', { to: assigned.agent_id })
  res.json(assigned)
}))

// Distribute the whole unassigned pool by the team's strategy.
router.post('/pool/distribute', requireManager, ah(async (req, res) => {
  const result = await distributeTeamPool(req.team.id)
  await logAudit(req.agent.id, 'team', req.team.id, 'pool_distributed', result)
  res.json(result)
}))

// A member claims a lead from the shared pool (claim-from-pool mode).
router.post('/leads/:id/claim', requireMember, ah(async (req, res) => {
  try {
    const lead = await claimTeamLead(req.team.id, req.agent.id, Number(req.params.id))
    if (!lead) return res.status(409).json({ error: 'lead is not available to claim' })
    await logAudit(req.agent.id, 'lead', lead.id, 'team_claim', {})
    res.json(lead)
  } catch (err) {
    sendErr(res, err)
  }
}))

export default router
