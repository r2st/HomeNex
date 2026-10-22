import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../../test/render.jsx'
import { installBrowser } from '../../test/browserEnv.js'
import AreaConverter, { convertArea, AREA_UNITS } from './AreaConverter.jsx'

test('convertArea — 1000 sq ft to sq m', () => {
  assert.ok(Math.abs(convertArea(1000, 'sqft', 'sqm') - 92.903) < 0.01)
})

test('convertArea — 1 acre to sq ft', () => {
  assert.equal(convertArea(1, 'acre', 'sqft'), 43560)
})

test('convertArea — sq yd (gaj) to sq ft', () => {
  assert.equal(convertArea(100, 'sqyd', 'sqft'), 900)
})

test('convertArea — round trip is identity', () => {
  const back = convertArea(convertArea(250, 'sqm', 'guntha'), 'guntha', 'sqm')
  assert.ok(Math.abs(back - 250) < 1e-9)
})

test('convertArea — invalid unit or value returns 0', () => {
  assert.equal(convertArea(100, 'nope', 'sqft'), 0)
  assert.equal(convertArea(0, 'sqft', 'sqm'), 0)
  assert.equal(convertArea(-5, 'sqft', 'sqm'), 0)
})

test('AREA_UNITS covers the common Indian units', () => {
  const keys = AREA_UNITS.map((u) => u.key)
  for (const k of ['sqft', 'sqm', 'sqyd', 'acre', 'hectare', 'guntha', 'cent']) {
    assert.ok(keys.includes(k), k)
  }
})

test('AreaConverter renders heading and converted values', async () => {
  installBrowser()
  const ui = await render(<AreaConverter />)
  assert.ok(ui.text().includes('Area Converter'))
  assert.ok(ui.text().includes('Converted Values'))
  assert.ok(ui.text().includes('Square Metres'))
})
