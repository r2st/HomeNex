// worklist.js — the prioritised daily worklist / next-best-action feed.
//
// Ported from Landline's routers/suggestions.py + services/call_queue.py. Like the
// original it is deliberately DETERMINISTIC and rule-based, "so the panel is fast
// and predictable" — zero LLM cost, sub-100ms, and every card is explainable.
//
// This module holds the pure ranking + item shape. The candidate rows are gathered
// by db.js::worklist() (SQL, per-agent, tenant-scoped) and turned into items here.
//
// The two HomeNex-native signals that outrank everything have no Landline analogue:
// the 24-hour service window closing, and a site visit within 48h.

// Lower rank sorts first.
export const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

// Each worklist type, with its priority and a stable sort weight. `action` is the
// concrete thing the frontend wires a button to.
export const WORKLIST_TYPES = {
  service_window_closing: { priority: 'critical', action: 'reply_now' },
  site_visit_soon: { priority: 'high', action: 'confirm_visit' },
  hot_lead_waiting: { priority: 'high', action: 'reply_now' },
  overdue_followup: { priority: 'high', action: 'complete_followup' },
  micro_page_reopened: { priority: 'high', action: 'reach_out' },
  site_visit_no_followup: { priority: 'high', action: 'reach_out' },
  commission_overdue: { priority: 'medium', action: 'chase_commission' },
  stale_lead: { priority: 'medium', action: 'resume_outreach' },
}

// Build one worklist item. `recencyAt` is what breaks ties within a priority band
// (more recent / more overdue first). Returns null for an unknown type.
export function worklistItem(type, { lead_id = null, entity_type = 'lead', entity_id = null, title, reason, recencyAt = null, meta = {} } = {}) {
  const def = WORKLIST_TYPES[type]
  if (!def) return null
  return {
    type,
    priority: def.priority,
    action: def.action,
    lead_id,
    entity_type,
    entity_id: entity_id ?? lead_id,
    title,
    reason,
    recency_at: recencyAt ? new Date(recencyAt).toISOString() : null,
    meta,
  }
}

// Sort by priority rank, then by recency (newest/most-overdue first), and cap.
export function rankWorklist(items, { limit = 50 } = {}) {
  const clean = items.filter(Boolean)
  clean.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (pr !== 0) return pr
    const at = a.recency_at ? Date.parse(a.recency_at) : 0
    const bt = b.recency_at ? Date.parse(b.recency_at) : 0
    return bt - at
  })
  return clean.slice(0, limit)
}

// Roll up counts per type and per priority for the tab badge.
export function worklistCounts(items) {
  const byType = {}
  const byPriority = {}
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1
    byPriority[it.priority] = (byPriority[it.priority] || 0) + 1
  }
  return { total: items.length, by_type: byType, by_priority: byPriority }
}
