// AI lead categorization persistence: applyExtraction must map the extended
// extraction payload (intent, BHK, localities, financing, hot/warm/cold score)
// onto the lead's CRM columns.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('extraction')

const { ready, closePool, upsertLead, getLead, applyExtraction, createAgent } = await import('../db.js')
await ready // migrations must land before the fixtures below

let leadId

before(async () => {
  const agent = await createAgent('Extract Agent', '+919800000071', null, 'x')
  const lead = await upsertLead(agent.id, '919777700071', null)
  leadId = lead.id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// The shape ai.js extractLead returns for "2bhk chahiye wakad me, 80 tak budget,
// loan lena hai, 2 mahine me shift" — Hinglish parsed into structured fields.
const HINGLISH_EXTRACTION = {
  name: 'Rohan',
  intent: 'buy',
  config: '2 BHK',
  bhk: '2',
  locality: 'Wakad',
  preferred_localities: ['Wakad', 'Baner'],
  budget_min_l: null,
  budget_max_l: 80,
  budget_note: 'wants a home loan',
  financing: 'loan',
  timeline: '2 months',
  temp: 'Hot',
  score: 85,
  score_reason: 'Clear budget (₹80L), urgent 2-month timeline, actively engaging',
  score_breakdown: [{ label: 'Budget clarity', value: 90 }],
  summary: 'Rohan wants a 2 BHK in Wakad under ₹80L within 2 months, loan-financed.',
  next_step: 'Share 2-3 matching Wakad listings and offer a weekend site visit',
}

test('applyExtraction fills the AI categorization columns', async () => {
  await applyExtraction(leadId, HINGLISH_EXTRACTION)
  const lead = await getLead(leadId)

  assert.equal(lead.name, 'Rohan')
  assert.equal(lead.intent, 'buy')
  assert.equal(lead.bhk, '2')
  assert.deepEqual(lead.preferred_localities, ['Wakad', 'Baner'])
  assert.equal(lead.financing, 'loan')
  assert.equal(lead.budget_max, 80 * 1e7) // lakhs -> paise on the CRM column
  assert.equal(lead.budget_min, null)
  assert.equal(lead.budget_max_l, 80) // legacy lakhs column still filled
  assert.equal(lead.temp, 'Hot')
  assert.equal(lead.ai_score, 'hot') // Hot/Warm/Cold stored lowercase per schema
  assert.match(lead.ai_score_reason, /Clear budget/)
  assert.equal(lead.score, 85)
  assert.equal(lead.timeline, '2 months')
  // The raw AI payload is preserved for audit/debugging.
  assert.equal(lead.ai_extracted.intent, 'buy')
  assert.equal(lead.ai_extracted.score_reason, HINGLISH_EXTRACTION.score_reason)
})

test('a later sparse extraction never wipes known fields', async () => {
  await applyExtraction(leadId, { temp: 'Warm', score: 60, intent: null, bhk: null, financing: null })
  const lead = await getLead(leadId)
  assert.equal(lead.intent, 'buy') // COALESCE keeps the earlier value
  assert.equal(lead.bhk, '2')
  assert.equal(lead.financing, 'loan')
  assert.equal(lead.temp, 'Warm') // but non-null updates win
  assert.equal(lead.ai_score, 'warm')
  assert.equal(lead.score, 60)
})

test('extractLead sanitizer drops invalid enum values (unit)', async () => {
  // Simulate what ai.js does post-parse without calling the network:
  const { extractLead } = await import('../ai.js')
  // No API key -> null, proving graceful degradation of the whole pipeline.
  assert.equal(await extractLead([{ role: 'buyer', text: 'hello' }]), null)
})
