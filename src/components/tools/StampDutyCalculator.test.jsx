import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../../test/render.jsx'
import { installBrowser } from '../../test/browserEnv.js'
import StampDutyCalculator, { calcStampDuty, STAMP_DUTY_RATES } from './StampDutyCalculator.jsx'

test('calcStampDuty — Maharashtra 50L property', () => {
  const { stampDuty, registration, total } = calcStampDuty(5000000, 'Maharashtra')
  assert.equal(stampDuty, 250000)
  assert.equal(registration, 50000)
  assert.equal(total, 300000)
})

test('calcStampDuty — Kerala has highest combined rates', () => {
  const { total } = calcStampDuty(5000000, 'Kerala')
  assert.equal(total, 500000)
})

test('calcStampDuty — unknown state returns zeros', () => {
  const r = calcStampDuty(5000000, 'Narnia')
  assert.equal(r.total, 0)
})

test('calcStampDuty — zero value returns zeros', () => {
  const r = calcStampDuty(0, 'Maharashtra')
  assert.equal(r.total, 0)
})

test('STAMP_DUTY_RATES covers 15 states', () => {
  assert.equal(Object.keys(STAMP_DUTY_RATES).length, 15)
})

test('StampDutyCalculator renders heading and results', async (t) => {
  installBrowser()
  const ui = await render(<StampDutyCalculator />)
  assert.ok(ui.text().includes('Stamp Duty Calculator'))
  assert.ok(ui.text().includes('Total Charges'))
})
