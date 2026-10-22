// Pure-function tests for the per-route public <head>: which paths get bespoke
// meta, and that injection rewrites every duplicated field (title, description,
// their OG/Twitter mirrors, og:url) and adds a canonical. No DB needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicPageMeta, injectMeta } from '../publicMeta.js'

const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <title>DoAide Realty — WhatsApp CRM</title>
    <meta name="description" content="DoAide Realty — leads answered in seconds." />
    <meta property="og:title" content="DoAide Realty — WhatsApp CRM for Real Estate" />
    <meta property="og:description" content="AI-powered WhatsApp CRM." />
    <meta property="og:url" content="https://realty.doaide.com" />
    <meta name="twitter:title" content="DoAide Realty — WhatsApp CRM" />
    <meta name="twitter:description" content="AI-powered WhatsApp CRM for real estate agents." />
  </head>
  <body><div id="root"></div></body>
</html>`

test('every sitemap public page resolves to bespoke meta', () => {
  for (const p of [
    '/tools',
    '/tools/emi-calculator',
    '/tools/stamp-duty-calculator',
    '/tools/rental-yield-calculator',
    '/blog',
    '/blog/whatsapp-crm-transforming-indian-real-estate',
    '/blog/5-lead-management-strategies-property-agents',
    '/blog/complete-guide-real-estate-follow-up-automation',
    '/embed',
  ]) {
    const meta = publicPageMeta(p)
    assert.ok(meta, `${p} should have meta`)
    assert.ok(meta.title.length > 10, `${p} title`)
    assert.ok(meta.description.length > 40, `${p} description`)
    assert.equal(meta.canonical, `https://realty.doaide.com${p}`)
  }
})

test('a trailing slash resolves like the clean path', () => {
  assert.equal(
    publicPageMeta('/tools/emi-calculator/').canonical,
    'https://realty.doaide.com/tools/emi-calculator',
  )
})

test('app, admin, API and unknown public paths keep the generic shell', () => {
  for (const p of ['/', '/dashboard', '/tools/unknown-tool', '/blog/nope', '/admin', '/api/leads']) {
    assert.equal(publicPageMeta(p), null, p)
  }
})

test('injectMeta rewrites the title, both descriptions, OG/Twitter mirrors and og:url', () => {
  const meta = publicPageMeta('/tools/emi-calculator')
  const html = injectMeta(SHELL, meta)
  assert.ok(html.includes(`<title>${meta.title.replace(/&/g, '&amp;')}</title>`))
  assert.equal((html.match(/EMI Calculator for Home Loans/g) || []).length, 3, 'title + og + twitter')
  assert.ok(html.includes(`og:url" content="${meta.canonical}"`))
  assert.ok(html.includes(`<link rel="canonical" href="${meta.canonical}" />`))
  assert.ok(!html.includes('leads answered in seconds.'), 'old description gone')
})

test('injectMeta escapes HTML-significant characters in the copy', () => {
  const html = injectMeta(SHELL, {
    title: 'A <b>"bold"</b> & risky title',
    description: 'desc',
    canonical: 'https://realty.doaide.com/tools',
  })
  assert.ok(html.includes('A &lt;b&gt;&quot;bold&quot;&lt;/b&gt; &amp; risky title'))
  assert.ok(!html.includes('<b>"bold"</b>'))
})
