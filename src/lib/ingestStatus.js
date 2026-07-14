// The lead-capture feed used to print raw pipeline states (created/merged/
// duplicate/unmatched/failed) straight from the ingest engine. Those are internal.
// This maps each to a plain sentence a broker understands, plus a tone the row can
// colour by. Pure — no React — so it's unit-tested.

const STATUS = {
  created: { label: 'New lead', tone: 'good' },
  merged: { label: 'Added to existing contact', tone: 'muted' },
  duplicate: { label: 'Already had this one', tone: 'faint' },
  unmatched: { label: "Couldn't match — check it", tone: 'warn' },
  failed: { label: "Didn't come through", tone: 'bad' },
}

export function ingestStatusLabel(status) {
  return STATUS[status]?.label || 'Captured'
}

export function ingestStatusTone(status) {
  return STATUS[status]?.tone || 'muted'
}
