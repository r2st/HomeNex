// Tests for agents managing their client list by texting the shared WhatsApp number.
// Run with: npm test  (from server/)  — needs a local PostgreSQL (docker compose up -d).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

// Isolate a throwaway database and keep AI/WhatsApp inert before importing anything.
process.env.NODE_ENV = 'test'
delete process.env.OPENROUTER_API_KEY
delete process.env.WHATSAPP_ACCESS_TOKEN
const dbName = await createTestDb('agentcmd')

const { closePool, createAgent, listContacts, getContactByPhone } = await import('../db.js')
const { hashPassword } = await import('../auth.js')
const { parseAgentCommand, runAgentCommand, extractPhoneFromText } =
  await import('../agentCommands.js')
const { ready } = await import('../db.js')

let agentA
let agentB

before(async () => {
  await ready
  agentA = await createAgent('Agent A', '+919811000000', null, hashPassword('secret123'))
  agentB = await createAgent('Agent B', '+919822000000', null, hashPassword('secret123'))
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

const textMsg = (from, body) => ({ from, type: 'text', text: { body } })

test('extractPhoneFromText handles bare, +prefixed, and embedded numbers', () => {
  assert.equal(extractPhoneFromText('9876543210'), '9876543210')
  assert.equal(extractPhoneFromText('+919876543210'), '+919876543210')
  assert.equal(extractPhoneFromText('add 9876543210 please'), '9876543210')
  assert.equal(extractPhoneFromText('98765-43210'), '9876543210')
  assert.equal(extractPhoneFromText('list'), null)
  assert.equal(extractPhoneFromText('12345'), null, 'too short is not a phone')
})

test('parseAgentCommand classifies list / add / help', () => {
  assert.deepEqual(parseAgentCommand(textMsg('91', 'list')).kind, 'list')
  assert.deepEqual(parseAgentCommand(textMsg('91', 'My Clients')).kind, 'list')
  assert.equal(parseAgentCommand(textMsg('91', 'add 9876543210')).kind, 'add')
  assert.equal(parseAgentCommand(textMsg('91', 'hello there')).kind, 'help')
})

test('parseAgentCommand extracts a phone from a forwarded contact card', () => {
  const msg = {
    from: '919811000000',
    type: 'contacts',
    contacts: [{ name: { formatted_name: 'Ravi Kumar' }, phones: [{ phone: '+91 98765 43210' }] }],
  }
  const cmd = parseAgentCommand(msg)
  assert.equal(cmd.kind, 'add')
  assert.equal(cmd.name, 'Ravi Kumar')
  assert.equal(cmd.phone, '+91 98765 43210')
})

test('adding a client replies with confirmation and stores the contact', async () => {
  const reply = await runAgentCommand(agentA, textMsg('919811000000', '9876543210'))
  assert.equal(reply, 'Added +919876543210 to your client list')
  assert.ok((await listContacts(agentA.id)).some((c) => c.phone === '+919876543210'))
  // No name supplied over WhatsApp → name defaults to the number itself.
  assert.equal((await getContactByPhone('+919876543210')).name, '+919876543210')
})

test('adding a number already in your own list is reported, not duplicated', async () => {
  const reply = await runAgentCommand(agentA, textMsg('919811000000', '+919876543210'))
  assert.equal(reply, 'Already in your client list')
  assert.equal((await listContacts(agentA.id)).filter((c) => c.phone === '+919876543210').length, 1)
})

test("adding another agent's client is rejected", async () => {
  const reply = await runAgentCommand(agentB, textMsg('919822000000', '9876543210'))
  assert.equal(reply, 'This number is already registered by another agent')
  assert.ok(!(await listContacts(agentB.id)).some((c) => c.phone === '+919876543210'))
})

test('list command returns the agent\'s current clients', async () => {
  await runAgentCommand(agentB, textMsg('919822000000', '9800000001'))
  const reply = await runAgentCommand(agentB, textMsg('919822000000', 'list'))
  assert.match(reply, /Your clients \(1\)/)
  assert.match(reply, /\+919800000001/)
})

test('list command with no clients gives a friendly prompt', async () => {
  const fresh = await createAgent('Agent C', '+919833000000', null, hashPassword('secret123'))
  const reply = await runAgentCommand(fresh, textMsg('919833000000', 'my clients'))
  assert.match(reply, /no clients yet/)
})

test('an unrecognised message returns help text', async () => {
  const reply = await runAgentCommand(agentA, textMsg('919811000000', 'what can you do?'))
  assert.equal(reply, "Send a phone number to add a client, or 'list' to see your clients")
})

test('a forwarded contact card adds the customer', async () => {
  const msg = {
    from: '919811000000',
    type: 'contacts',
    contacts: [{ name: { formatted_name: 'Meera Nair' }, phones: [{ phone: '9700000042' }] }],
  }
  const reply = await runAgentCommand(agentA, msg)
  assert.equal(reply, 'Added +919700000042 to your client list')
  assert.equal((await getContactByPhone('+919700000042')).name, 'Meera Nair')
})
