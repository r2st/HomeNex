// Decide which Home (dashboard) sections to render, so the same lead isn't shown
// three or four times. The "Your day" worklist is the single source of "what to do
// next" — it already rolls up unanswered replies, today's follow-ups and overdue
// follow-ups. When it has items it becomes the hero list and those three duplicate
// sections are hidden. When it's empty (or still loading) we fall back to showing the
// individual lists so the agent is never left with a blank screen.
//
// Site visits, hot leads and live activity are NOT duplicates of the worklist (they
// answer a different question — "what's on today" / "who's warmest" / "what just
// happened") so they always show when they have content. Pure — no React.

export function homeSections({
  worklistCount = 0,
  unansweredCount = 0,
  followupsTodayCount = 0,
  overdueCount = 0,
  siteVisitsCount = 0,
  hotLeadsCount = 0,
  activityCount = 0,
} = {}) {
  const hasWorklist = worklistCount > 0

  return {
    // The worklist is the hero whenever it has anything.
    worklist: hasWorklist,
    // These three are folded into the worklist; only shown as a fallback when the
    // worklist is empty, so a brand-new/quiet day still surfaces pending items.
    unanswered: !hasWorklist && unansweredCount > 0,
    followupsToday: !hasWorklist && followupsTodayCount > 0,
    overdue: !hasWorklist && overdueCount > 0,
    // Always-independent sections.
    siteVisits: siteVisitsCount > 0,
    hotLeads: hotLeadsCount > 0,
    activity: activityCount > 0,
  }
}
