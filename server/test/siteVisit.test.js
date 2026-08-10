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
