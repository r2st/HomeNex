// DB-backed integration for the AI feature layer: the 'broker' intent lands on the
// schema (migration 007), auto-fill applies an agent-accepted subset of suggestions,
// and the rules+LLM hybrid reads real message/visit signals to reach a Hot verdict.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('aifeatures')

const {
  ready,
  closePool,
  createAgent,
  upsertLead,
  getLead,
  getLeadForAgent,
  addMessage,
  applyExtraction,
  applyAutofill,
  createSiteVisit,
  leadEngagementSignals,
  computeHybridScore,
} = await import('../db.js')
await ready

let agentId
let leadId

before(async () => {
  const agent = await createAgent('AI Feature Agent', '+919800000091', null, 'x')
  agentId = agent.id
  const lead = await upsertLead(agentId, '919777700091', 'Rohan')
  leadId = lead.id
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- migration 007: broker intent -------------------------------------------

test("applyExtraction accepts the new 'broker' intent (migration 007)", async () => {
  await applyExtraction(leadId, { intent: 'broker', temp: 'Cold', score: 20 })
  const lead = await getLead(leadId)
  assert.equal(lead.intent, 'broker')
})

// --- auto-fill apply ---------------------------------------------------------

test('applyAutofill writes only the accepted, whitelisted fields', async () => {
  const lead = await applyAutofill(leadId, agentId, {
    name: 'Rohan Sharma',
    intent: 'buy',
    bhk: '2',
    preferred_localities: ['Wakad', 'Baner'],
    budget_max: 800000000, // 80L in paise
    timeline: '2 months',
    financing: 'loan',
    // Not a whitelisted field — must be ignored, never written.
    stage: 'Registered/Closed',
  })
  assert.equal(lead.name, 'Rohan Sharma')
  assert.equal(lead.intent, 'buy')
  assert.equal(lead.bhk, '2')
  assert.deepEqual(lead.preferred_localities, ['Wakad', 'Baner'])
  assert.equal(Number(lead.budget_max), 800000000)
  assert.equal(lead.timeline, '2 months')
  assert.equal(lead.financing, 'loan')
  assert.notEqual(lead.stage, 'Registered/Closed') // the non-whitelisted field was dropped
})

test('applyAutofill returns null for another agent’s lead', async () => {
  const other = await createAgent('Other Agent', '+919800000092', null, 'x')
  assert.equal(await applyAutofill(leadId, other.id, { name: 'Hacker' }), null)
  // The real lead is untouched.
  assert.equal((await getLead(leadId)).name, 'Rohan Sharma')
})

// --- engagement signals + hybrid score --------------------------------------

test('leadEngagementSignals counts buyer replies and detects an agreed visit', async () => {
  await addMessage(leadId, 'buyer', 'hi')
  await addMessage(leadId, 'ai', 'hello, budget?')
  await addMessage(leadId, 'buyer', 'budget 80 tak, 2 mahine me chahiye')
  const before = await leadEngagementSignals(leadId)
  assert.equal(before.buyerReplies, 2)
  assert.equal(before.visitAgreed, false)

  await createSiteVisit(agentId, { lead_id: leadId, scheduled_at: new Date(Date.now() + 86400000).toISOString() })
  const after = await leadEngagementSignals(leadId)
  assert.equal(after.visitAgreed, true)
})

test('computeHybridScore reaches Hot-by-rule on a fully qualified lead', async () => {
  // The lead now has: budget (80L from applyAutofill), timeline '2 months',
  // 2 buyer replies, and an agreed site visit — all four rule conditions.
  const lead = await getLeadForAgent(leadId, agentId)
  const h = await computeHybridScore(lead)
  assert.equal(h.temperature, 'Hot')
  assert.equal(h.source, 'rule')
  assert.match(h.reason, /Hot by rule/)
})
