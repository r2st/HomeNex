// The last unexercised arms of the pure helpers — the ones reached by absent data
// rather than by a different request.
//
// Each of these is a fallback: `String(x || '')`, `?? null`, `loc ? … : ''`. They are
// written because the author knew the value could be missing, and they are the arms a
// test suite built out of realistic fixtures never takes, because a realistic fixture
// has all its fields. What makes them worth their own file is that "missing" is not
// hypothetical for any of them: a photo array with a blank slot, a template rendered
// before its variables are filled, a WhatsApp error body in a shape Meta did not
// document, a site visit whose pickup was agreed but whose address was not.
//
// Nothing here reads or writes a row, and where a network is involved (whatsapp.js)
// global.fetch is stubbed. The throwaway database exists only because agentCommands.js
// imports db.js, which opens its pool at module load — without it the import connects
// to whatever postgres is listening on the default port.
import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createTestDb, dropTestDb } from './helpers.js'

process.env.NODE_ENV = 'test'
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token'
process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-pnid'
const dbName = await createTestDb('pureedges')

const { extractPhoneFromText, parseAgentCommand, HELP_TEXT } = await import('../agentCommands.js')
const { bookingConfirmationText, reminderT1Text } = await import('../siteVisit.js')
const { renderMicroPage } = await import('../micropage.js')
const { appendRera, renderTemplate } = await import('../inbox.js')
const { parseEmiQuery, parseAmountLakhs, emiReplyFor } = await import('../emi.js')
const { sendText } = await import('../whatsapp.js')
const { closePool } = await import('../db.js')

const realFetch = global.fetch
afterEach(() => {
  global.fetch = realFetch
})

after(async () => {
  await closePool()
  await dropTestDb(dbName)
})

// --- agentCommands ---------------------------------------------------------------

test('a number-shaped run of punctuation is not a phone number', () => {
  // The regex matches on SHAPE — a digit, nine or more digits/spaces/dashes/parens,
  // a digit — so "1 - - - - - - - 2" matches it and cleans down to "12". Without the
  // digit-count check that would be added as a client, and every message an agent
  // sends with a date range or a price band in it becomes a contact.
  for (const text of ['1 - - - - - - - 2', '(0) . . . . . . . . 1', '9 -- -- -- -- 8']) {
    assert.equal(extractPhoneFromText(text), null, `${JSON.stringify(text)} was accepted as a phone number`)
  }
  // Ten real digits, however they are spaced, still is one.
  assert.equal(extractPhoneFromText('call me on 98 76 54 32 10'), '9876543210')
  assert.equal(extractPhoneFromText('+91 (98) 765-43210'), '+919876543210')
})

test('a text message with no text at all falls back to help', () => {
  // Meta sends `type: 'text'` with the body under `text.body`. A message that is
  // typed as text with nothing there — a stripped payload, an unsupported subtype
  // Meta relabels — must not read `.toLowerCase()` off undefined.
  assert.deepEqual(parseAgentCommand({ type: 'text' }), { kind: 'help' })
  assert.deepEqual(parseAgentCommand({ type: 'text', text: {} }), { kind: 'help' })
  assert.deepEqual(parseAgentCommand({ type: 'text', text: { body: '   ' } }), { kind: 'help' })
  assert.match(HELP_TEXT, /phone number/)
})

// --- siteVisit copy --------------------------------------------------------------

test('a Hindi visit reminder mentions the pickup even when the address is not agreed yet', () => {
  // pickup_required and pickup_location are separate columns: the agent ticks
  // "pickup" when they book, and fills the address when the buyer confirms where
  // they will be. The window between those two is where this arm lives — and the
  // buyer still has to be told a pickup is coming.
  const visit = {
    lead_name: 'राहुल शर्मा',
    lead_wa_id: '919876500001',
    scheduled_at: new Date('2026-03-01T10:30:00Z'),
    pickup_required: true,
    pickup_location: null,
  }
  const lang = { language: 'hindi' }

  const booking = bookingConfirmationText(visit, { timezone: 'Asia/Kolkata', lang })
  assert.match(booking, /पिकअप की व्यवस्था है/)
  assert.ok(!booking.includes('—'), 'a missing address must not leave a dangling dash')

  const t1 = reminderT1Text(visit, { timezone: 'Asia/Kolkata', lang })
  assert.match(t1, /पिकअप — तैयार रहें।/)
  assert.ok(!/से/.test(t1.split('\n').find((l) => l.includes('पिकअप'))), 'no "from <place>" without a place')

  // And with the address, both lines name it.
  const withPlace = { ...visit, pickup_location: 'बाणेर' }
  assert.match(bookingConfirmationText(withPlace, { timezone: 'Asia/Kolkata', lang }), /पिकअप की व्यवस्था है — बाणेर से/)
  assert.match(reminderT1Text(withPlace, { timezone: 'Asia/Kolkata', lang }), /पिकअप — बाणेर से/)
})

// --- micropage -------------------------------------------------------------------

test('a blank entry in a property photo array is dropped, not rendered as an empty img', () => {
  // photos is JSONB the agent's uploader writes into. A failed upload, a cleared
  // slot, or a row migrated from an older shape all leave a null in the array, and
  // `<img src="">` re-requests the page itself in every browser — a second full
  // render of the micro-page for every blank slot.
  const html = renderMicroPage({
    id: 1,
    title: '3 BHK in Baner',
    slug: '3-bhk-in-baner-ab12',
    photos: [null, '', '  ', 'https://cdn.example.com/a.jpg', undefined, 0],
    agent_name: 'Esha',
    agent_phone: '+919876500002',
    price_paise: 9_50_00_000,
  })
  const srcs = [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(srcs, ['https://cdn.example.com/a.jpg'], 'a blank photo slot reached the page')
})

// --- inbox / RERA ----------------------------------------------------------------

test('the RERA line is appended to a body that is not there yet', () => {
  // renderTemplate fills variables first, and fillTemplate can hand back nothing at
  // all for a template whose body is empty. The RERA number is a legal requirement
  // on the message, so it has to survive that rather than be swallowed by a
  // `undefined.includes` throw or silently rendered as the string "undefined".
  const agent = { rera_id: 'A52100012345', rera_state: 'MH' }
  assert.equal(appendRera(undefined, agent), '\n\nRERA (MH): A52100012345')
  assert.equal(appendRera(null, agent), '\n\nRERA (MH): A52100012345')
  assert.equal(appendRera('', agent), '\n\nRERA (MH): A52100012345')

  // Already carrying the number: appended once, never twice.
  assert.equal(appendRera('Site visit Sunday. RERA (MH): A52100012345', agent), 'Site visit Sunday. RERA (MH): A52100012345')

  // No RERA on file — nothing to append, and the body is returned as it came, not
  // stringified. renderTemplate's `missing` list is what the caller rejects on.
  assert.equal(appendRera(undefined, { rera_id: '' }), undefined)
  const rendered = renderTemplate({ body: 'Hi {{name}}', category: 'marketing', rera_auto_append: true }, {}, agent)
  assert.deepEqual(rendered.missing, ['name'])
  assert.match(rendered.text, /RERA \(MH\): A52100012345$/)
})

// --- emi -------------------------------------------------------------------------

test('an EMI parse of nothing is null, not a crash and not a loan for ₹0', () => {
  // emiReplyFor runs on every inbound buyer message, including the ones our own
  // media handler turns into a null caption.
  for (const text of [undefined, null, '', 0, false]) {
    assert.equal(parseEmiQuery(text), null, `${JSON.stringify(text)} produced a loan`)
    assert.equal(parseAmountLakhs(text), null)
  }
  assert.equal(emiReplyFor(undefined), null)
  // And the ordinary path still works, so the guard above is a guard and not a wall.
  assert.equal(parseEmiQuery('80 lakh loan emi').principalLakhs, 80)
})

// --- whatsapp --------------------------------------------------------------------

const mockFetch = ({ ok = true, status = 200, body = {} } = {}) => {
  global.fetch = async () => ({ ok, status, json: async () => body, headers: { get: () => null } })
}

test('a Graph failure with no error object still names what came back', async () => {
  // Every WhatsApp failure the code models has `{ error: { code, message } }`. A 400
  // that does not — an edge proxy, a WAF, an HTML error page parsed to {} — used to
  // fall through to `JSON.stringify(undefined)`, i.e. the literal text "undefined",
  // which is the whole diagnostic an agent gets when their send stops working.
  mockFetch({ ok: false, status: 400, body: { message: 'Bad Request', trace_id: 'abc123' } })
  await assert.rejects(sendText('919876500003', 'hi'), (err) => {
    assert.equal(err.code, 'WA_SEND_FAILED')
    assert.match(err.message, /WhatsApp API failed \(400\)/)
    assert.match(err.message, /trace_id/, 'the body Meta actually sent must reach the log')
    return true
  })

  // The documented shape is still preferred when it is there.
  mockFetch({ ok: false, status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } })
  await assert.rejects(sendText('919876500003', 'hi'), (err) => {
    assert.match(err.message, /131047/)
    assert.ok(!/trace_id/.test(err.message))
    return true
  })
})

test('a send Meta accepts without returning a message id resolves to null, not undefined', async () => {
  // The id is stored on the message row and is what a delivery-status webhook is
  // matched against later. A 200 whose body is not the documented shape has to
  // become an explicit null so the column is NULL rather than the string
  // "undefined" — the send DID happen and must still be recorded.
  mockFetch({ ok: true, status: 200, body: {} })
  assert.equal(await sendText('919876500003', 'hi'), null)
  mockFetch({ ok: true, status: 200, body: { messages: [] } })
  assert.equal(await sendText('919876500003', 'hi'), null)
  mockFetch({ ok: true, status: 200, body: { messages: [{}] } })
  assert.equal(await sendText('919876500003', 'hi'), null)
  mockFetch({ ok: true, status: 200, body: { messages: [{ id: 'wamid.TEST' }] } })
  assert.equal(await sendText('919876500003', 'hi'), 'wamid.TEST')
})
