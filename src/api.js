import { useCallback, useEffect, useRef, useState } from 'react'
import { friendlyMessage } from './lib/friendlyError.js'

const TOKEN_KEY = 'realty-token'
const LEGACY_TOKEN_KEY = 'homenex-token'
const QUEUE_KEY = 'realty-offline-queue'
const LEGACY_QUEUE_KEY = 'homenex-offline-queue'

function migrateKeys() {
  try {
    const oldToken = localStorage.getItem(LEGACY_TOKEN_KEY)
    if (oldToken && !localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, oldToken)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
    }
    const oldQueue = localStorage.getItem(LEGACY_QUEUE_KEY)
    if (oldQueue && !localStorage.getItem(QUEUE_KEY)) {
      localStorage.setItem(QUEUE_KEY, oldQueue)
      localStorage.removeItem(LEGACY_QUEUE_KEY)
    }
  } catch { /* private mode — nothing to migrate */ }
}
migrateKeys()

export const getToken = () => localStorage.getItem(TOKEN_KEY)

// Everything the app holds on behalf of ONE session, dropped whenever the session
// changes (login, logout, or a 401 that ends it).
//
// Two stores outlive a session unless we clear them, and both are cross-agent leaks
// on a shared office desktop — the normal setup in an Indian brokerage:
//   1. The service worker caches authenticated API GETs so the CRM stays readable at
//      a site with no signal. Those entries are keyed by URL alone, with no agent in
//      the key, so the next person to log in would be served the previous agent's
//      leads and contacts straight from cache while offline.
//   2. The offline write queue holds stage moves and follow-ups that failed on a dead
//      network. Replayed under a different token they would write one agent's edits
//      into another agent's CRM.
// Best-effort by design: a private-mode localStorage throw or a browser with no Cache
// Storage must not break signing in or out.
export function clearSessionCaches() {
  try {
    globalThis.localStorage?.removeItem(QUEUE_KEY)
  } catch {
    /* storage unavailable (private mode) — nothing cached to leak either */
  }
  const store = globalThis.caches
  if (!store) return
  store
    .keys()
    .then((names) =>
      Promise.all(
        names.map((name) =>
          store.open(name).then((cache) =>
            cache.keys().then((requests) =>
              Promise.all(
                requests
                  .filter((r) => {
                    try {
                      return new URL(r.url).pathname.startsWith('/api/')
                    } catch {
                      return false
                    }
                  })
                  .map((r) => cache.delete(r)),
              ),
            ),
          ),
        ),
      ),
    )
    .catch(() => {})
}

export const setToken = (t) => {
  clearSessionCaches()
  return t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)
}

async function j(res) {
  if (res.status === 401) {
    setToken(null)
    window.dispatchEvent(new Event('realty-logout'))
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    // Throw an error whose `.message` is already agent-friendly (so any component
    // that shows err.message is safe), while keeping the raw pieces for callers that
    // want to branch on them (err.status, err.code, err.serverMessage).
    const err = new Error(friendlyMessage({ status: res.status, serverMessage: body.error }))
    err.status = res.status
    err.code = body.code
    err.serverMessage = body.error
    throw err
  }
  return res.json()
}

const authHeaders = () => {
  const t = getToken()
  return t ? { authorization: `Bearer ${t}` } : {}
}

const get = (url) => fetch(url, { headers: authHeaders() }).then(j)
const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(j)
const put = (url, body) =>
  fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }).then(j)

// --- Offline action queue: follow-up creation and stage moves survive dead spots.
// Failed-by-network writes are stored locally and replayed when connectivity returns.
const readQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
  } catch {
    return []
  }
}
const writeQueue = (queue) => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
export const offlineQueueSize = () => readQueue().length

// A fetch that throws TypeError (no response at all) means the network is down.
const isNetworkError = (err) => err instanceof TypeError

async function queueable(method, url, body) {
  try {
    return await (method === 'POST' ? post(url, body) : put(url, body))
  } catch (err) {
    if (!isNetworkError(err)) throw err
    writeQueue([...readQueue(), { method, url, body, queued_at: new Date().toISOString() }])
    window.dispatchEvent(new Event('realty-queued'))
    return { queued: true }
  }
}

// Replay queued actions in order; stop at the first network failure (still offline).
// Non-network errors (validation, 404) drop the action — it can never succeed.
export async function flushOfflineQueue() {
  let queue = readQueue()
  while (queue.length) {
    const [action, ...rest] = queue
    try {
      await (action.method === 'POST' ? post(action.url, action.body) : put(action.url, action.body))
    } catch (err) {
      if (isNetworkError(err)) break
    }
    queue = rest
    writeQueue(queue)
  }
  if (!queue.length) window.dispatchEvent(new Event('realty-queue-flushed'))
  return queue.length
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => flushOfflineQueue().catch(() => {}))
}
const del = (url) => fetch(url, { method: 'DELETE', headers: authHeaders() }).then(j)

const qs = (params) => {
  const s = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString()
  return s ? `?${s}` : ''
}

export const api = {
  signup: (body) => post('/api/auth/signup', body),
  login: (body) => post('/api/auth/login', body),
  requestReset: (body) => post('/api/auth/request-reset', body),
  resetPassword: (body) => post('/api/auth/reset-password', body),
  me: () => get('/api/auth/me'),
  health: () => get('/api/health'),
  // Paged. Pass { limit, offset, pipeline_type, stage, q }. The server defaults to the
  // first 100 and caps at 500, so a caller that wants totals must ask leadCounts()
  // rather than measuring the array it got back.
  leads: (filters) => get(`/api/leads${qs(filters)}`),
  // { total, unassigned, by_pipeline: { <type>: n }, by_stage: { <type>: { <stage>: n } } }
  leadCounts: () => get('/api/leads/count'),
  lead: (id) => get(`/api/leads/${id}`),
  updateLead: (id, body) => put(`/api/leads/${id}`, body),
  moveLeadStage: (id, stage, lost_reason) => queueable('PUT', `/api/leads/${id}/stage`, { stage, lost_reason }),
  suggestions: (id) => get(`/api/leads/${id}/suggestions`),
  autofill: (id, fresh) => get(`/api/leads/${id}/autofill${fresh ? '?fresh=1' : ''}`),
  applyAutofill: (id, accepted) => post(`/api/leads/${id}/autofill/apply`, { accepted }),
  emi: (body) => post('/api/emi', body),
  pipelineStages: (type) => get(`/api/pipeline-stages${qs({ type })}`),
  pipelineAnalytics: (type) => get(`/api/pipeline/analytics${qs({ type })}`),
  leadPropertyMatches: (id) => get(`/api/leads/${id}/property-matches`),
  stats: () => get('/api/stats'),
  activity: () => get('/api/activity'),
  dashboard: () => get('/api/dashboard'),
  network: () => get('/api/network'),
  postNetwork: (body) => post('/api/network', body),
  reply: (id, text) => post(`/api/leads/${id}/reply`, { text }),
  replyTemplate: (id, templateId, variables) => post(`/api/leads/${id}/reply`, { template_id: templateId, variables }),
  templates: () => get('/api/templates'),
  createTemplate: (body) => post('/api/templates', body),
  updateTemplate: (id, body) => put(`/api/templates/${id}`, body),
  deleteTemplate: (id) => del(`/api/templates/${id}`),
  // Unified inbox: read state, assignment, notes, labels, quick replies, media.
  markLeadRead: (id) => post(`/api/leads/${id}/read`, {}),
  assignLeadTo: (id, assigneeId) => post(`/api/leads/${id}/assign-to`, { assignee_id: assigneeId }),
  leadNotes: (id) => get(`/api/leads/${id}/notes`),
  addLeadNote: (id, body) => post(`/api/leads/${id}/notes`, { body }),
  deleteLeadNote: (id, noteId) => del(`/api/leads/${id}/notes/${noteId}`),
  setLeadLabel: (id, labelId, on) => put(`/api/leads/${id}/labels/${labelId}`, { on }),
  quickReplies: () => get('/api/quick-replies'),
  createQuickReply: (body) => post('/api/quick-replies', body),
  updateQuickReply: (id, body) => put(`/api/quick-replies/${id}`, body),
  deleteQuickReply: (id) => del(`/api/quick-replies/${id}`),
  labels: () => get('/api/labels'),
  createLabel: (body) => post('/api/labels', body),
  deleteLabel: (id) => del(`/api/labels/${id}`),
  uploadFile: (data_base64, filename, mime) => post('/api/uploads', { data_base64, filename, mime }),
  media: () => get('/api/media'),
  createMedia: (body) => post('/api/media', body),
  deleteMedia: (id) => del(`/api/media/${id}`),
  sendMedia: (mediaId, leadId, caption) => post(`/api/media/${mediaId}/send`, { lead_id: leadId, caption }),
  festive: () => get('/api/templates/festive'),
  sendFestive: (body) => post('/api/templates/festive/send', body),
  cancelFestive: (id) => del(`/api/templates/festive/${id}`),
  microPage: (propertyId) => post(`/api/properties/${propertyId}/micro-page`, {}),
  setAi: (id, enabled) => post(`/api/leads/${id}/ai`, { enabled }),
  assignLead: (id) => post(`/api/leads/${id}/assign`, {}),
  // Paged. Pass { q, source, limit, offset }. The server defaults to the first 100 and
  // caps at 500, so a caller that wants the total must ask contactCount() rather than
  // measuring the array it got back.
  contacts: (filters) => get(`/api/contacts${qs(filters)}`),
  // { total }
  contactCount: (filters) => get(`/api/contacts/count${qs(filters)}`),
  contact: (id) => get(`/api/contacts/${id}`),
  updateContact: (id, body) => put(`/api/contacts/${id}`, body),
  deleteContact: (id) => del(`/api/contacts/${id}`),
  // Paged. Pass { type, bhk, status, q, min_price, max_price, limit, offset }. The
  // server defaults to the first 100 and caps at 500, so a caller that wants the total
  // must ask propertyCount() rather than measuring the array it got back.
  properties: (filters) => get(`/api/properties${qs(filters)}`),
  // { total }
  propertyCount: (filters) => get(`/api/properties/count${qs(filters)}`),
  property: (id) => get(`/api/properties/${id}`),
  createProperty: (body) => post('/api/properties', body),
  updateProperty: (id, body) => put(`/api/properties/${id}`, body),
  deleteProperty: (id) => del(`/api/properties/${id}`),
  sendPropertyToChat: (id, leadId) => post(`/api/properties/${id}/send-to-chat`, { lead_id: leadId }),
  followups: (filters) => get(`/api/followups${qs(filters)}`),
  createFollowup: (body) => queueable('POST', '/api/followups', body),
  updateFollowup: (id, body) => put(`/api/followups/${id}`, body),
  siteVisits: (filters) => get(`/api/site-visits${qs(filters)}`),
  createSiteVisit: (body) => post('/api/site-visits', body),
  updateSiteVisit: (id, body) => put(`/api/site-visits/${id}`, body),
  // §5.4: deals, commissions, builder receivables + aging, GST invoices.
  deals: (filters) => get(`/api/deals${qs(filters)}`),
  deal: (id) => get(`/api/deals/${id}`),
  createDeal: (body) => post('/api/deals', body),
  updateDeal: (id, body) => put(`/api/deals/${id}`, body),
  commissions: (status) => get(`/api/commissions${qs({ status })}`),
  createCommission: (body) => post('/api/commissions', body),
  updateCommission: (id, body) => put(`/api/commissions/${id}`, body),
  builderReceivables: () => get('/api/commissions/receivables'),
  createCommissionInvoice: (id, body) => post(`/api/commissions/${id}/invoice`, body || {}),
  commissionInvoices: (filters) => get(`/api/commission-invoices${qs(filters)}`),
  updateCommissionInvoice: (id, body) => put(`/api/commission-invoices/${id}`, body),
  changePhone: (body) => put('/api/agent/phone', body),
  changePassword: (body) => put('/api/agent/password', body),
  updateProfile: (body) => put('/api/agent/profile', body),
  updatePreferences: (body) => put('/api/agent/preferences', body),
  phoneConfig: () => get('/api/agent/phone-config'),
  updatePhoneConfig: (body) =>
    fetch('/api/agent/phone-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(j),
  updateWaPhone: (body) =>
    fetch('/api/agent/wa-phone', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    }).then(j),
  // Admin APIs (list endpoint returns { agents, total, page, ... } — unwrap for the panel)
  adminAgents: (filters) => get(`/api/admin/agents${qs(filters)}`).then((r) => (Array.isArray(r) ? r : r.agents)),
  adminDashboard: () => get('/api/admin/dashboard'),
  adminAuditLogs: (limit) => get(`/api/admin/audit-logs${qs({ limit })}`),
  adminSetAdmin: (agentId, isAdmin) => put(`/api/admin/agents/${agentId}/admin`, { is_admin: isAdmin }),
  adminSetActive: (agentId, isActive) => put(`/api/admin/agents/${agentId}/active`, { is_active: isActive }),
  adminUpdateWaba: (agentId, body) => put(`/api/admin/agents/${agentId}/waba`, body),
  // Decision layer: worklist, briefing, notifications, analytics, groups.
  worklist: () => get('/api/worklist'),
  briefing: (leadId) => get(`/api/leads/${leadId}/briefing`),
  notifications: (unread) => get(`/api/notifications${qs({ unread: unread ? 1 : undefined })}`),
  markNotificationRead: (id) => put(`/api/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => post('/api/notifications/read-all', {}),
  propertyAnalytics: (id) => get(`/api/properties/${id}/analytics`),
  groups: () => get('/api/groups'),
  createGroup: (body) => post('/api/groups', body),
  updateGroup: (id, body) => put(`/api/groups/${id}`, body),
  deleteGroup: (id) => del(`/api/groups/${id}`),
  groupMembers: (id) => get(`/api/groups/${id}/members`),
  addGroupMembers: (id, contactIds) => post(`/api/groups/${id}/members`, { contact_ids: contactIds }),
  removeGroupMember: (id, contactId) => del(`/api/groups/${id}/members/${contactId}`),
  autoGroup: (by) => post('/api/groups/auto', { by }),
  previewSegment: (criteria) => post('/api/segments/preview', { criteria }),
  sendToGroup: (id, message) => post(`/api/groups/${id}/send`, { message }),
  // Team Management (§5.3): teams, roles, invites, assignment, manager views.
  team: () => get('/api/team'),
  createTeam: (name) => post('/api/team', { name }),
  updateTeam: (body) => put('/api/team', body),
  deleteTeam: () => del('/api/team'),
  teamMembers: () => get('/api/team/members'),
  inviteTeamMember: (phone, role) => post('/api/team/invites', { phone, role }),
  revokeTeamInvite: (id) => del(`/api/team/invites/${id}`),
  acceptTeamInvite: (id) => post(`/api/team/invites/${id}/accept`, {}),
  declineTeamInvite: (id) => post(`/api/team/invites/${id}/decline`, {}),
  setTeamMemberRole: (agentId, role) => put(`/api/team/members/${agentId}/role`, { role }),
  updateTeamMember: (agentId, body) => put(`/api/team/members/${agentId}`, body),
  removeTeamMember: (agentId) => del(`/api/team/members/${agentId}`),
  teamLeads: (filters) => get(`/api/team/leads${qs(filters)}`),
  teamPipeline: (type) => get(`/api/team/pipeline${qs({ type })}`),
  teamLeaderboard: () => get('/api/team/leaderboard'),
  teamStale: (days) => get(`/api/team/stale${qs({ days })}`),
  assignTeamLead: (id, agentId) => post(`/api/team/leads/${id}/assign`, { agent_id: agentId }),
  autoAssignTeamLead: (id) => post(`/api/team/leads/${id}/auto-assign`, {}),
  distributeTeamPool: () => post('/api/team/pool/distribute', {}),
  claimTeamLead: (id) => post(`/api/team/leads/${id}/claim`, {}),
  // Support tickets + billing (§7.3/§7.4 agent side) + template review request (§7.2)
  supportTickets: (status) => get(`/api/support/tickets${qs({ status })}`),
  supportTicket: (id) => get(`/api/support/tickets/${id}`),
  createSupportTicket: (body) => post('/api/support/tickets', body),
  replySupportTicket: (id, body) => post(`/api/support/tickets/${id}/reply`, { body }),
  billing: () => get('/api/billing'),
  requestTemplateReview: (id) => post(`/api/templates/${id}/request-review`, {}),
  // Lead Source Integrations (§1.7, §3.1, §5.2)
  quickAddLead: (body) => post('/api/leads/quick-add', body),
  leadSources: (channel) => get(`/api/lead-sources${qs({ channel })}`),
  regenerateIngest: () => post('/api/lead-sources/regenerate', {}),
  mapLeadgenForm: (formId) => post('/api/lead-sources/leadgen-form', { form_id: formId }),
  portalIntegrations: () => get('/api/portal-integrations'),
  updatePortalIntegration: (portal, body) => put(`/api/portal-integrations/${portal}`, body),
  propertySyndications: (id) => get(`/api/properties/${id}/syndications`),
  syndicate: (id, portal) => post(`/api/properties/${id}/syndicate`, { portal }),
}

// Poll an endpoint so the dashboard stays live as real messages arrive.
//
// Returns { data, error, loading, refresh }.
//
//   data     the last successful response, or null before one arrives
//   error    the last failure; cleared by the next success
//   loading  a request is in flight and there is nothing settled to show yet
//   refresh  refetch now, WITHOUT blanking what's on screen
//
// Three rules earn their keep here, all of them about what the agent sees:
//
//  1. `deps` identify the SUBJECT of the poll (which lead, which contact, which
//     filter). When they change, the held data describes the previous subject, so
//     it is dropped rather than rendered under the new heading — otherwise opening
//     lead B right after lead A shows A's messages and price under B's name until
//     the next response lands, which is worse than showing nothing.
//  2. A failure keeps the last good `data` (a blip mustn't blank a working screen)
//     but always ends `loading`. Screens branch on `!data` to show "Loading…", so
//     without this a first request that fails leaves that spinner up for ever with
//     no error and no way out.
//  3. `refresh()` is for "I just changed something, re-read it" and deliberately
//     does NOT clear data — the subject is the same, so blanking it would flash the
//     screen after every save. This is what call sites used to do by feeding a
//     refreshKey into `deps`, which rule 1 would now (correctly) treat as a new
//     subject.
export function usePoll(fn, intervalMs = 5000, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  // Held in a ref so an inline arrow (every call site passes one) doesn't restart
  // the interval on every render, while a poll still calls the CURRENT closure.
  const fnRef = useRef(fn)
  fnRef.current = fn
  // Monotonic id of the newest request. A response whose id is stale — because deps
  // changed, or refresh() overtook the interval — is discarded instead of being
  // written over newer data.
  const runRef = useRef(0)

  const load = useCallback(() => {
    const run = ++runRef.current
    return fnRef
      .current()
      .then((d) => {
        if (run === runRef.current) setState({ data: d, error: null, loading: false })
      })
      .catch((e) => {
        if (run === runRef.current) setState((s) => ({ data: s.data, error: e, loading: false }))
      })
  }, [])

  useEffect(() => {
    runRef.current++ // orphan anything still in flight for the previous subject
    // Functional form so the very first mount doesn't schedule a pointless second
    // render just to replace the pristine state with an identical object.
    setState((s) =>
      s.data === null && s.error === null && s.loading ? s : { data: null, error: null, loading: true },
    )
    load()
    const t = setInterval(load, intervalMs)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ...state, refresh: load }
}

// Timestamps arrive as ISO strings from PostgreSQL ("2026-07-09T16:15:00.000Z");
// legacy SQLite-style "YYYY-MM-DD HH:MM:SS" (UTC) is still handled for safety.
export function parseTs(ts) {
  if (!ts) return null
  if (ts instanceof Date) return ts
  const s = String(ts)
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

export function fmtTime(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function fmtAgo(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Compact waiting-time label for the unanswered queue: "12m", "3h", "2d".
export function fmtWait(ts) {
  const d = parseTs(ts)
  if (!d) return ''
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function fmtBudget(minL, maxL) {
  if (minL == null && maxL == null) return null
  const f = (l) => (l >= 100 ? `₹${(l / 100).toFixed(l % 100 === 0 ? 0 : 2)} Cr` : `₹${Math.round(l)} L`)
  if (minL != null && maxL != null && minL !== maxL) return `${f(minL)} – ${f(maxL)}`
  return f(maxL ?? minL)
}
