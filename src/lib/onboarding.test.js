import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onboardingSteps, shouldShowOnboarding, ONBOARDING_DISMISS_KEY } from './onboarding.js'

test('onboardingSteps reflects done flags from setup state', () => {
  const steps = onboardingSteps({ hasWhatsApp: true, propertyCount: 0 })
  assert.equal(steps.length, 2)
  assert.equal(steps[0].id, 'whatsapp')
  assert.equal(steps[0].done, true)
  assert.equal(steps[1].id, 'properties')
  assert.equal(steps[1].done, false)
})

test('onboardingSteps treats missing input as not done', () => {
  const steps = onboardingSteps()
  assert.deepEqual(steps.map((s) => s.done), [false, false])
})

test('shouldShowOnboarding: shown while a step is pending', () => {
  assert.equal(shouldShowOnboarding({ hasWhatsApp: false, propertyCount: 0, leadCount: 0 }), true)
  assert.equal(shouldShowOnboarding({ hasWhatsApp: true, propertyCount: 0, leadCount: 0 }), true)
})

test('shouldShowOnboarding: hidden when both steps done', () => {
  assert.equal(shouldShowOnboarding({ hasWhatsApp: true, propertyCount: 3, leadCount: 0 }), false)
})

test('shouldShowOnboarding: auto-hidden once real leads exist', () => {
  assert.equal(shouldShowOnboarding({ hasWhatsApp: false, propertyCount: 0, leadCount: 5 }), false)
})

test('shouldShowOnboarding: hidden when dismissed', () => {
  assert.equal(shouldShowOnboarding({ hasWhatsApp: false, propertyCount: 0, leadCount: 0, dismissed: true }), false)
})

test('dismiss key is stable', () => {
  assert.equal(ONBOARDING_DISMISS_KEY, 'homenex_onboarding_dismissed')
})
