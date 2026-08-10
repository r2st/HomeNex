// Unit tests for siteVisit.js — pure formatters, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapsLink, bookingConfirmationText, reminderT1Text, reminderT2Text } from '../siteVisit.js'

const visit = {
  lead_name: 'Ravi Kumar',
  lead_wa_id: '919888800001',
  scheduled_at: '2026-08-15T10:00:00Z',
  property_title: 'Kolte Patil 24K',
  property_locality: 'Hinjewadi',
  property_city: 'Pune',
  pickup_required: true,
  pickup_location: 'Wakad',
}

test('mapsLink builds a Google Maps search URL, or null with nothing to place', () => {
  assert.equal(mapsLink('Baner', 'Pune'), 'https://maps.google.com/?q=Baner%2C%20Pune')
  assert.equal(mapsLink(null, null), null)
})

test('defaults to English when no lang is given (unchanged existing behavior)', () => {
  const text = bookingConfirmationText(visit, { timezone: 'Asia/Kolkata' })
  assert.match(text, /Your site visit is confirmed/)
  assert.match(text, /Hi Ravi!/)
  assert.match(text, /Pickup arranged from Wakad/)
})

test('an unrecognized/garbage lang value falls back to English rather than throwing', () => {
  const text = reminderT1Text(visit, { lang: 'klingon' })
  assert.match(text, /tomorrow/i)
})

test('accepts a detectConversationLanguage()-shaped object directly', () => {
  const text = bookingConfirmationText(visit, { lang: { language: 'hinglish', confidence: 0.8 } })
  assert.match(text, /confirm ho gayi hai/)
})

test('bookingConfirmationText: Hinglish and Hindi variants carry the same facts, different words', () => {
  const hinglish = bookingConfirmationText(visit, { lang: 'hinglish' })
  assert.match(hinglish, /Ravi/)
  assert.match(hinglish, /confirm ho gayi hai/)
  assert.match(hinglish, /Hinjewadi/) // property line is factual, not translated
  assert.match(hinglish, /Wakad se/)

  const hindi = bookingConfirmationText(visit, { lang: 'hindi' })
  assert.match(hindi, /नमस्ते Ravi/)
  assert.match(hindi, /कन्फर्म हो गई है/)
  assert.match(hindi, /Hinjewadi/)
})

test('reminderT1Text: no location pin in any language (too early for it)', () => {
  for (const lang of ['english', 'hinglish', 'hindi']) {
    const text = reminderT1Text(visit, { lang })
    assert.ok(!text.includes('maps.google.com'), `${lang}: T-1 must not carry a pin yet`)
  }
})

test('reminderT2Text: carries the location pin in every language', () => {
  for (const lang of ['english', 'hinglish', 'hindi']) {
    const text = reminderT2Text(visit, { lang })
    assert.match(text, /maps\.google\.com/, `${lang}: T-2 must carry the pin`)
  }
})

test('a visit with no pickup omits the pickup line in every language', () => {
  const noPickup = { ...visit, pickup_required: false }
  for (const lang of ['english', 'hinglish', 'hindi']) {
    assert.ok(!bookingConfirmationText(noPickup, { lang }).toLowerCase().includes('pickup'))
  }
})

// --- Partial / missing data branches -----------------------------------------
//
// Real visits are booked with far less than the fixture above: no property, no
// pickup, an unnamed lead. None of those may produce a broken line or a stray icon.

test('an unnamed lead (name defaults to the wa_id) gets no greeting name', () => {
  const anon = { ...visit, lead_name: '919888800001' }
  const text = bookingConfirmationText(anon)
  assert.ok(text.startsWith('Your site visit is confirmed'), text)
  assert.ok(!text.includes('Hi 919888800001'))
  // Hindi and Hinglish take the same no-name branch.
  assert.ok(bookingConfirmationText(anon, { lang: 'hindi' }).startsWith('आपकी'))
  assert.ok(bookingConfirmationText(anon, { lang: 'hinglish' }).startsWith('Aapki'))
})

test('a null lead_name is handled like an unnamed lead', () => {
  const text = bookingConfirmationText({ ...visit, lead_name: null })
  assert.ok(!/^Hi /.test(text))
})

test('only the first name is greeted', () => {
  assert.match(bookingConfirmationText(visit), /^Hi Ravi! /)
})

test('a visit with no property at all omits the property line', () => {
  const bare = { scheduled_at: visit.scheduled_at, pickup_required: false }
  for (const [lang, fn] of [['english', bookingConfirmationText], ['hindi', reminderT1Text], ['hinglish', reminderT2Text]]) {
    const text = fn(bare, { lang })
    assert.ok(!text.includes('🏠'), `${lang} leaked a property line`)
  }
})

test('a property with a title but no locality still renders a property line', () => {
  const titleOnly = { ...visit, property_locality: null, property_city: null }
  const text = bookingConfirmationText(titleOnly)
  assert.match(text, /🏠 Kolte Patil 24K/)
  assert.ok(!text.includes('—'), 'no dangling separator when there is no locality')
})

test('a property with a locality but no title renders just the place', () => {
  const localityOnly = { ...visit, property_title: null }
  assert.match(bookingConfirmationText(localityOnly), /🏠 Hinjewadi, Pune/)
})

test('pickup with no stated pickup point still announces the pickup', () => {
  const noPoint = { ...visit, pickup_location: null }
  assert.match(bookingConfirmationText(noPoint), /🚗 Pickup arranged$/m)
  assert.match(reminderT1Text(noPoint), /🚗 Pickup — please be ready\./)
  assert.match(reminderT2Text(noPoint), /🚗 Pickup is on the way\./)
  assert.match(bookingConfirmationText(noPoint, { lang: 'hinglish' }), /🚗 Pickup arranged hai$/m)
  assert.match(reminderT2Text(noPoint, { lang: 'hindi' }), /🚗 पिकअप रवाना हो चुका है।/)
})

test('reminderT2Text omits the pin when the property has no place at all', () => {
  const placeless = { ...visit, property_locality: null, property_city: null }
  assert.ok(!reminderT2Text(placeless).includes('📍 Location:'))
  assert.ok(!reminderT2Text(placeless, { lang: 'hindi' }).includes('📍 Location:'))
})

test('mapsLink works from either half of the place on its own', () => {
  assert.equal(mapsLink('Baner', null), 'https://maps.google.com/?q=Baner')
  assert.equal(mapsLink(null, 'Pune'), 'https://maps.google.com/?q=Pune')
  assert.equal(mapsLink('', ''), null)
})

test('scheduled_at is accepted as a Date as well as an ISO string', () => {
  const asDate = { ...visit, scheduled_at: new Date(visit.scheduled_at) }
  assert.equal(bookingConfirmationText(asDate), bookingConfirmationText(visit))
})

test('an explicit timezone changes the rendered local time', () => {
  const ist = bookingConfirmationText(visit)
  const utc = bookingConfirmationText(visit, { timezone: 'UTC' })
  assert.notEqual(ist, utc)
  assert.match(ist, /3:30 pm/i) // 10:00 UTC = 15:30 IST
  assert.match(utc, /10:00 am/i)
})
