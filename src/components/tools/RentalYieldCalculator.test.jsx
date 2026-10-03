import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../../test/render.jsx'
import { installBrowser } from '../../test/browserEnv.js'
import RentalYieldCalculator, { calcYield } from './RentalYieldCalculator.jsx'

test('calcYield — 50L property, 20K rent, 30K expenses', () => {
  const { grossYield, netYield, annualIncome } = calcYield(5000000, 20000, 30000)
  assert.equal(annualIncome, 240000)
  assert.ok(Math.abs(grossYield - 4.8) < 0.01)
  assert.ok(Math.abs(netYield - 4.2) < 0.01)
})

test('calcYield — zero property value returns zeros', () => {
  const r = calcYield(0, 20000, 30000)
  assert.equal(r.grossYield, 0)
  assert.equal(r.netYield, 0)
})

test('calcYield — zero rent returns zeros', () => {
  const r = calcYield(5000000, 0, 30000)
  assert.equal(r.grossYield, 0)
})

test('calcYield — no expenses makes gross equal net', () => {
  const { grossYield, netYield } = calcYield(5000000, 20000, 0)
  assert.ok(Math.abs(grossYield - netYield) < 0.001)
})

test('RentalYieldCalculator renders heading and results', async (t) => {
  installBrowser()
  const ui = await render(<RentalYieldCalculator />)
  assert.ok(ui.text().includes('Rental Yield Calculator'))
  assert.ok(ui.text().includes('Gross Yield'))
  assert.ok(ui.text().includes('Net Yield'))
})
