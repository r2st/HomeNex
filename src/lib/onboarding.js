// First-run onboarding logic. Pure — no React, no DOM — so it can be unit-tested.
// The banner walks a brand-new agent through the two things they must do before
// HomeNex is useful: connect a WhatsApp number and add some properties.

export const ONBOARDING_DISMISS_KEY = 'homenex_onboarding_dismissed'

// Ordered first-run steps with a done flag derived from the agent's real state.
export function onboardingSteps({ hasWhatsApp = false, propertyCount = 0 } = {}) {
  return [
    {
      id: 'whatsapp',
      label: 'Connect your WhatsApp Business number',
      hint: 'So buyers can message you and get instant AI replies.',
      cta: 'Open Settings',
      target: 'more',
      done: Boolean(hasWhatsApp),
    },
    {
      id: 'properties',
      label: 'Add your first properties',
      hint: 'HomeNex matches them to every lead automatically.',
      cta: 'Add properties',
      target: 'properties',
      done: Number(propertyCount) > 0,
    },
  ]
}

// Show the banner while setup is incomplete. Once real leads arrive the agent is
// clearly up and running, so we auto-hide even if a step is technically unticked.
export function shouldShowOnboarding({
  hasWhatsApp = false,
  propertyCount = 0,
  leadCount = 0,
  dismissed = false,
} = {}) {
  if (dismissed) return false
  if (Number(leadCount) > 0) return false
  return onboardingSteps({ hasWhatsApp, propertyCount }).some((s) => !s.done)
}
