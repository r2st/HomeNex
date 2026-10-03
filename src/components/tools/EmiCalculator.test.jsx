import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../../test/render.jsx'
import { installBrowser } from '../../test/browserEnv.js'
import EmiCalculator, { calcEmi } from './EmiCalculator.jsx'

test('calcEmi — standard 50L loan at 8.5% for 20 years', () => {
  const { emi, totalPayment, totalInterest } = calcEmi(5000000, 8.5, 20)
  assert.ok(Math.abs(emi - 43391) <= 1)
  assert.equal(totalInterest, totalPayment - 5000000)
})

test('calcEmi — zero principal returns zeros', () => {
  const r = calcEmi(0, 8.5, 20)
  assert.equal(r.emi, 0)
  assert.equal(r.totalPayment, 0)
  assert.equal(r.totalInterest, 0)
})

test('calcEmi — negative rate returns zeros', () => {
  const r = calcEmi(5000000, -1, 20)
  assert.equal(r.emi, 0)
})

test('calcEmi — zero tenure returns zeros', () => {
  const r = calcEmi(5000000, 8.5, 0)
  assert.equal(r.emi, 0)
})

test('calcEmi — small loan 1L at 10% for 1 year', () => {
  const { emi, totalPayment } = calcEmi(100000, 10, 1)
  assert.ok(emi > 0)
  assert.ok(totalPayment > 100000)
})

test('EmiCalculator renders heading and results', async (t) => {
  installBrowser()
  const ui = await render(<EmiCalculator />)
  assert.ok(ui.text().includes('EMI Calculator'))
  assert.ok(ui.text().includes('Monthly EMI'))
})
