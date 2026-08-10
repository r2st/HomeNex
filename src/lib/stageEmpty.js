// Helpful empty-state text for a kanban column, keyed by stage name. Replaces the
// bare "empty" placeholder. Pure — no React — so it can be unit-tested.

export function stageEmptyText(stageName) {
  const name = String(stageName || '').trim()
  const key = name.toLowerCase()
  if (key === 'new') return 'New leads from WhatsApp will appear here'
  if (key === 'lost') return 'Leads you mark as lost show up here'
  if (key === 'closed' || key === 'registered/closed' || key === 'won')
    return 'Closed deals will appear here'
  // Trimmed, so a whitespace-only column name reads as a sentence rather than
  // trailing off ("...as they reach    ").
  return `Drag leads here as they reach ${name || 'this stage'}`
}

// A small icon to pair with the empty text, again keyed by stage.
export function stageEmptyIcon(stageName) {
  const key = String(stageName || '').trim().toLowerCase()
  if (key === 'new') return '💬'
  if (key === 'lost') return '🚫'
  if (key === 'closed' || key === 'registered/closed' || key === 'won') return '🎉'
  return '↴'
}
