import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../../test/render.jsx'
import { installBrowser } from '../../test/browserEnv.js'
import PropertyComparison, { compareProperties, bestIndex } from './PropertyComparison.jsx'

test('compareProperties — computes price per sqft and gross yield', () => {
  const [m] = compareProperties([{ name: 'A', price: 7500000, area: 1200, monthlyRent: 22000 }])
  assert.equal(m.pricePerSqft, 6250)
  assert.ok(Math.abs(m.grossYield - 3.52) < 0.01)
})

test('compareProperties — missing inputs yield null metrics', () => {
  const [m] = compareProperties([{ name: 'A', price: 0, area: 1200, monthlyRent: 0 }])
  assert.equal(m.pricePerSqft, null)
  assert.equal(m.grossYield, null)
})

test('bestIndex — lowest price per sqft wins', () => {
  const metrics = compareProperties([
    { price: 7500000, area: 1200 }, // 6250/sqft
    { price: 9000000, area: 1500 }, // 6000/sqft
  ])
  assert.equal(bestIndex(metrics, 'pricePerSqft'), 1)
})

test('bestIndex — highest yield wins and nulls are skipped', () => {
  const metrics = compareProperties([
    { price: 7500000, area: 1200, monthlyRent: 0 }, // null yield
    { price: 9000000, area: 1500, monthlyRent: 26000 },
  ])
  assert.equal(bestIndex(metrics, 'grossYield'), 1)
})

test('bestIndex — all null returns -1', () => {
  const metrics = compareProperties([{ price: 0 }, { price: 0 }])
  assert.equal(bestIndex(metrics, 'grossYield'), -1)
})

test('PropertyComparison renders heading and comparison table', async () => {
  installBrowser()
  const ui = await render(<PropertyComparison />)
  assert.ok(ui.text().includes('Property Comparison Tool'))
  assert.ok(ui.text().includes('Price per sq ft'))
  assert.ok(ui.text().includes('Gross Rental Yield'))
})
