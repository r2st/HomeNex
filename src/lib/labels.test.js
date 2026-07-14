import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  titleCase,
  pipelineLabel,
  dealTypeLabel,
  dealStatusLabel,
  commissionStatusLabel,
  invoiceStatusLabel,
  payerLabel,
  visitStatusLabel,
  ticketCategoryLabel,
  ticketStatusLabel,
  tempBadge,
} from './labels.js'

test('titleCase turns slugs into words', () => {
  assert.equal(titleCase('buy_primary'), 'Buy Primary')
  assert.equal(titleCase('no_show'), 'No Show')
  assert.equal(titleCase(''), '')
  assert.equal(titleCase(null), '')
})

test('pipelineLabel maps known slugs and defaults', () => {
  assert.equal(pipelineLabel('buy_primary'), 'Buy (Primary)')
  assert.equal(pipelineLabel('rental'), 'Rental')
  assert.equal(pipelineLabel(null), 'Buy (Primary)')
  assert.equal(pipelineLabel(undefined), 'Buy (Primary)')
})

test('never leaks the buy_primary slug', () => {
  assert.notEqual(pipelineLabel('buy_primary'), 'buy_primary')
})

test('deal + commission + invoice statuses are friendly', () => {
  assert.equal(dealTypeLabel('resale'), 'Resale')
  assert.equal(dealTypeLabel('primary'), 'New booking')
  assert.equal(dealStatusLabel('open'), 'In progress')
  assert.equal(commissionStatusLabel('expected'), 'Expected')
  assert.equal(commissionStatusLabel('received'), 'Received')
  assert.equal(invoiceStatusLabel('issued'), 'Awaiting payment')
})

test('unknown slugs fall back to Title case, not raw', () => {
  assert.equal(commissionStatusLabel('some_new_state'), 'Some New State')
  assert.equal(dealTypeLabel('weird_type'), 'Weird Type')
})

test('payerLabel never returns the debug "payer ?" placeholder', () => {
  assert.equal(payerLabel('builder'), 'Paid by builder')
  assert.equal(payerLabel(''), 'Payer not set')
  assert.equal(payerLabel(null), 'Payer not set')
  assert.notEqual(payerLabel(null), 'payer ?')
})

test('visit + ticket labels are friendly', () => {
  assert.equal(visitStatusLabel('no_show'), 'No-show')
  assert.equal(visitStatusLabel('completed'), 'Done')
  assert.equal(ticketCategoryLabel('feature_request'), 'Idea / request')
  assert.equal(ticketCategoryLabel('technical'), "Something's not working")
  assert.equal(ticketStatusLabel('open'), 'Open')
})

test('tempBadge gives icon + word and defaults to Cold', () => {
  assert.deepEqual(tempBadge('Hot'), { icon: '🔥', word: 'Hot' })
  assert.deepEqual(tempBadge('Warm'), { icon: '☀️', word: 'Warm' })
  assert.deepEqual(tempBadge('nonsense'), { icon: '❄️', word: 'Cold' })
})
