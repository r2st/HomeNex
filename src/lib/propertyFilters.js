// Property filter helpers for the collapsed Filters sheet. The search box (`q`)
// is not counted as a "filter" — it stays inline and visible. Pure — no React —
// so it can be unit-tested.

export const FILTER_KEYS = ['type', 'band', 'bhk', 'status']

export function activeFilterCount(filters = {}) {
  return FILTER_KEYS.reduce((n, k) => n + (filters[k] ? 1 : 0), 0)
}

export function clearedFilters(filters = {}) {
  return { ...filters, type: '', band: '', bhk: '', status: '' }
}
