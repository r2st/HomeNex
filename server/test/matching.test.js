// Unit tests for matching.js — pure, no DB. See server/matching.js for the rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetFits, localityMatches, scorePropertyMatch, rankPropertyMatches } from '../matching.js'

test('budgetFits: passes when either side has no price data', () => {
  assert.equal(budgetFits({}, {}), true)
  assert.equal(budgetFits({ budget_max: 9_000_000 }, {}), true)
  assert.equal(budgetFits({}, { price_paise: 9_000_000 }), true)
})

test('budgetFits: allows a 10% stretch over budget_max, rejects beyond it', () => {
  const lead = { budget_max: 10_000_000 }
  assert.equal(budgetFits(lead, { price_paise: 11_000_000 }), true) // exactly +10%
  assert.equal(budgetFits(lead, { price_paise: 11_000_001 }), false)
})

test('budgetFits: allows a 10% slack under budget_min, rejects below it', () => {
  const lead = { budget_min: 10_000_000 }
  assert.equal(budgetFits(lead, { price_paise: 9_000_000 }), true) // exactly -10%
  assert.equal(budgetFits(lead, { price_paise: 8_999_999 }), false)
})

test('localityMatches: matches a preferred locality case/whitespace-insensitively', () => {
  const lead = { preferred_localities: ['Baner', '  Wakad '] }
  assert.equal(localityMatches(lead, { locality: 'baner' }), true)
  assert.equal(localityMatches(lead, { locality: 'WAKAD' }), true)
  assert.equal(localityMatches(lead, { locality: 'Kharadi' }), false)
})

test('localityMatches: a locality containing SQL-wildcard-like characters does not broaden the match', () => {
  // Historically this went through an ILIKE '%...%' built from the raw string —
  // a locality literally containing "%" would silently match everything. Plain
  // JS substring comparison has no such wildcard semantics.
  const lead = { preferred_localities: ['Baner % Extension'] }
  assert.equal(localityMatches(lead, { locality: 'Kharadi' }), false)
  assert.equal(localityMatches(lead, { locality: 'Baner % Extension' }), true)
})

test('localityMatches: false with no preferred locality or no property locality', () => {
  assert.equal(localityMatches({}, { locality: 'Baner' }), false)
  assert.equal(localityMatches({ preferred_localities: ['Baner'] }, {}), false)
})

test('scorePropertyMatch: a stated BHK conflict excludes the property entirely', () => {
  const m = scorePropertyMatch({ bhk: '3' }, { bhk: '1' })
  assert.equal(m.fits, false)
  assert.equal(m.score, 0)
})

test('scorePropertyMatch: an unset property BHK never excludes (absence != conflict)', () => {
  const m = scorePropertyMatch({ bhk: '3' }, { bhk: null })
  assert.equal(m.fits, true)
})

test('scorePropertyMatch: a stated property_type conflict excludes the property', () => {
  const m = scorePropertyMatch({ property_type: 'villa' }, { property_type: 'apartment' })
  assert.equal(m.fits, false)
})

test('scorePropertyMatch: an over-budget property is excluded outright, not just ranked low', () => {
  const m = scorePropertyMatch({ budget_max: 5_000_000 }, { price_paise: 50_000_000 })
  assert.equal(m.fits, false)
  assert.deepEqual(m.reasons, [])
})

test('scorePropertyMatch: stacks reasons for locality + BHK + priced listing', () => {
  const lead = { bhk: '2', preferred_localities: ['Baner'] }
  const property = { bhk: '2', locality: 'Baner', price_paise: 8_000_000 }
  const m = scorePropertyMatch(lead, property)
  assert.equal(m.fits, true)
  assert.equal(m.score, 4) // 2 (locality) + 1 (bhk) + 1 (priced)
  assert.equal(m.reasons.length, 3)
})

test('rankPropertyMatches: excludes non-fits, sorts highest score first, tiebreaks on freshest', () => {
  const lead = { bhk: '2', preferred_localities: ['Baner'] }
  const properties = [
    { id: 1, bhk: '2', locality: 'Kharadi', updated_at: '2024-01-01' }, // bhk matches, locality doesn't
    { id: 2, bhk: '2', locality: 'Baner', updated_at: '2024-01-01' },
    { id: 3, bhk: '1', locality: 'Baner', updated_at: '2024-06-01' }, // excluded: bhk conflict
    { id: 4, bhk: '2', locality: 'Baner', updated_at: '2024-06-01' },
  ]
  const ranked = rankPropertyMatches(lead, properties)
  const ids = ranked.map((p) => p.id)
  assert.ok(!ids.includes(3), 'BHK conflict must be excluded, not just ranked low')
  // #4 and #2 both score locality(2)+bhk(1)=3, #4 is fresher so comes first; #1 scores bhk(1)=1 only.
  assert.deepEqual(ids, [4, 2, 1])
  assert.equal(ranked[0].match_score, 3)
  assert.ok(ranked[0].match_reasons.length > 0)
})

test('rankPropertyMatches: a listing with no updated_at ranks as the oldest, not as invalid', () => {
  // Inventory imported in bulk often arrives with updated_at never set. The tiebreak
  // falls back to 0 (the epoch) on each side, so such a listing sorts last among
  // equals — but it must still come back. Two of them, so one comparison exercises
  // the fallback on both sides of the subtraction at once.
  const properties = [{ id: 1 }, { id: 2, updated_at: '2024-06-01' }, { id: 3 }]

  const ids = rankPropertyMatches({}, properties).map((p) => p.id)

  assert.equal(ids[0], 2, 'a dated listing outranks one whose date was never filled in')
  assert.deepEqual([...ids].sort(), [1, 2, 3], 'the undated ones are ranked, not dropped')
})

test('rankPropertyMatches: respects the limit', () => {
  const lead = {}
  const properties = Array.from({ length: 30 }, (_, i) => ({ id: i, updated_at: '2024-01-01' }))
  assert.equal(rankPropertyMatches(lead, properties, { limit: 5 }).length, 5)
  assert.equal(rankPropertyMatches(lead, properties).length, 20) // default limit
})
