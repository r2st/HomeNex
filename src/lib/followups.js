// Count the follow-ups an agent should act on now (overdue or due today) so the
// More nav icon can carry a badge. Pure — no React — so it can be unit-tested.

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function actionableFollowupCount(followups = [], now = new Date()) {
  return followups.filter((f) => {
    if (!f || f.completed_at) return false
    if (f.overdue) return true
    if (!f.due_at) return false
    const due = new Date(f.due_at)
    if (Number.isNaN(due.getTime())) return false
    return due <= now || isSameLocalDay(due, now)
  }).length
}

// Cap the number shown in a small badge (e.g. "9+").
export function badgeText(count, max = 9) {
  const n = Number(count) || 0
  if (n <= 0) return null
  return n > max ? `${max}+` : String(n)
}
