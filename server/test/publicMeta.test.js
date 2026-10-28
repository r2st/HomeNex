// Pure-function tests for the per-route public <head>: which paths get bespoke
// meta, and that injection rewrites every duplicated field (title, description,
// their OG/Twitter mirrors, og:url, canonical, JSON-LD) and adds a crawler h1.
// No DB needed.
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
    <link rel="canonical" href="https://realty.doaide.com" />
    <script type="application/ld+json">
    { "@context": "https://schema.org", "@type": "SoftwareApplication", "name": "DoAide Realty" }
    </script>
  </head>
  <body><div id="root"></div></body>
</html>`

test('every sitemap public page resolves to bespoke meta', () => {
  for (const p of [
    '/tools',
    '/tools/emi-calculator',
    '/tools/stamp-duty-calculator',
    '/tools/rental-yield-calculator',
    '/tools/property-comparison',
    '/tools/area-converter',
    '/blog',
    '/blog/best-crm-for-real-estate-agents-india',
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

test('injectMeta leaves exactly one canonical, for the page itself', () => {
  const meta = publicPageMeta('/tools/area-converter')
  const html = injectMeta(SHELL, meta)
  const canonicals = html.match(/<link rel="canonical"[^>]*>/g) || []
  assert.equal(canonicals.length, 1)
  assert.ok(canonicals[0].includes('https://realty.doaide.com/tools/area-converter'))
})

test('injectMeta puts the page h1 in #root and page-specific JSON-LD in the head', () => {
  const tool = injectMeta(SHELL, publicPageMeta('/tools/emi-calculator'))
  assert.ok(tool.includes('<div id="root"><h1>Home Loan EMI Calculator</h1></div>'))
  assert.ok(!tool.includes('SoftwareApplication'), 'the CRM schema is replaced')
  assert.match(tool, /"@type":"WebApplication"/)

  const post = injectMeta(SHELL, publicPageMeta('/blog/whatsapp-crm-transforming-indian-real-estate'))
  const ld = JSON.parse(post.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])
  assert.equal(ld['@type'], 'BlogPosting')
  assert.equal(ld.headline, 'How WhatsApp CRM is Transforming Indian Real Estate')
})

test('every public page title is unique', () => {
  const paths = ['/tools', '/blog', '/embed', '/tools/emi-calculator', '/tools/stamp-duty-calculator', '/tools/rental-yield-calculator', '/tools/property-comparison', '/tools/area-converter', '/blog/best-crm-for-real-estate-agents-india', '/blog/whatsapp-crm-transforming-indian-real-estate', '/blog/5-lead-management-strategies-property-agents', '/blog/complete-guide-real-estate-follow-up-automation']
  const titles = paths.map((p) => publicPageMeta(p).title)
  assert.equal(new Set(titles).size, titles.length)
})

