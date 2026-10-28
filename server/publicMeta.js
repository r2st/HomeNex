// Per-route <head> for the login-free public pages. The SPA ships one
// index.html, so without this every tool and blog URL presents the same
// generic title/description to crawlers and link unfurlers. The catch-all in
// index.js runs the known public paths through injectMeta() before sending.
//
// The copy here mirrors src/components/PublicPages.jsx (tools + blog data) and
// public/sitemap.xml — a new public page needs an entry in all three.

const ORIGIN = 'https://realty.doaide.com'

const TOOLS = {
  'emi-calculator': {
    h1: 'Home Loan EMI Calculator',
    title: 'EMI Calculator for Home Loans (INR) — DoAide Realty',
    description:
      'Free home loan EMI calculator for the Indian market. Monthly instalment, total interest and amortisation in INR.',
  },
  'stamp-duty-calculator': {
    h1: 'Stamp Duty Calculator',
    title: 'Stamp Duty & Registration Calculator by State — DoAide Realty',
    description:
      'Estimate stamp duty and registration charges for property purchases across Indian states, free and login-free.',
  },
  'rental-yield-calculator': {
    h1: 'Rental Yield Calculator',
    title: 'Rental Yield Calculator — DoAide Realty',
    description:
      'Calculate gross and net rental yield for Indian properties. Compare returns before you buy or let.',
  },
  'property-comparison': {
    h1: 'Property Comparison Tool',
    title: 'Property Comparison Tool — DoAide Realty',
    description:
      'Compare up to four Indian properties side by side on price per sq ft and gross rental yield, free and login-free.',
  },
  'area-converter': {
    h1: 'Area Converter',
    title: 'Area Converter (sq ft, sq m, gaj, acre) — DoAide Realty',
    description:
      'Convert between square feet, square metres, gaj, acres, gunthas and other Indian land units instantly.',
  },
}

const BLOG = {
  'best-crm-for-real-estate-agents-india': {
    h1: 'Best CRM for Real Estate Agents in India: 2026 Buyer’s Guide',
    title: 'Best CRM for Real Estate Agents in India: 2026 Buyer’s Guide — DoAide Realty',
    description:
      'What Indian property agents should look for in a CRM — WhatsApp-first workflows, portal lead capture, follow-up automation — and how the options compare.',
  },
  'whatsapp-crm-transforming-indian-real-estate': {
    h1: 'How WhatsApp CRM is Transforming Indian Real Estate',
    title: 'How WhatsApp CRM is Transforming Indian Real Estate — DoAide Realty',
    description:
      "How WhatsApp-first CRM helps property agents close deals faster in India's competitive market.",
  },
  '5-lead-management-strategies-property-agents': {
    h1: '5 Lead Management Strategies for Property Agents',
    title: '5 Lead Management Strategies for Property Agents — DoAide Realty',
    description:
      'From instant response to smart follow-ups, five strategies that separate top-performing agents from the rest.',
  },
  'complete-guide-real-estate-follow-up-automation': {
    h1: 'The Complete Guide to Real Estate Follow-up Automation',
    title: 'The Complete Guide to Real Estate Follow-up Automation — DoAide Realty',
    description:
      'Build a follow-up system that converts leads on autopilot without losing the personal touch.',
  },
}

const STATIC_PAGES = {
  '/tools': {
    h1: 'Free Real Estate Tools',
    title: 'Free Real Estate Calculators — DoAide Realty',
    description:
      'Free, login-free tools for Indian real estate: EMI, stamp duty and rental yield calculators, property comparison and area conversion.',
  },
  '/blog': {
    h1: 'Blog',
    title: 'Real Estate Growth Blog — DoAide Realty',
    description:
      'Guides on WhatsApp CRM, lead management and follow-up automation for Indian property agents.',
  },
  '/embed': {
    h1: 'Embed Widget Generator',
    title: 'Embeddable Property Widgets — DoAide Realty',
    description:
      'Embed DoAide Realty calculators and lead-capture widgets on your own property website.',
  },
}

/** Meta for a public path, or null when the path has no bespoke head. */
export function publicPageMeta(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/'
  if (STATIC_PAGES[clean]) return withJsonLd({ ...STATIC_PAGES[clean], canonical: ORIGIN + clean }, 'WebPage')
  if (clean.startsWith('/tools/')) {
    const tool = TOOLS[clean.slice('/tools/'.length)]
    return tool ? withJsonLd({ ...tool, canonical: ORIGIN + clean }, 'WebApplication') : null
  }
  if (clean.startsWith('/blog/')) {
    const post = BLOG[clean.slice('/blog/'.length)]
    return post ? withJsonLd({ ...post, canonical: ORIGIN + clean }, 'BlogPosting') : null
  }
  return null
}

const ORG = { '@type': 'Organization', name: 'DoAide', url: 'https://doaide.com' }

// Page-level structured data, replacing the shell's SoftwareApplication (which
// describes the CRM, not a calculator or an article).
function withJsonLd(meta, type) {
  const base = { '@context': 'https://schema.org', '@type': type, url: meta.canonical, description: meta.description }
  if (type === 'BlogPosting') {
    return { ...meta, jsonLd: { ...base, headline: meta.h1, mainEntityOfPage: meta.canonical, author: ORG, publisher: ORG } }
  }
  if (type === 'WebApplication') {
    const app = { applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any', offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' } }
    return { ...meta, jsonLd: { ...base, name: meta.h1, ...app, isPartOf: { '@type': 'WebSite', name: 'DoAide Realty', url: ORIGIN } } }
  }
  return { ...meta, jsonLd: { ...base, name: meta.h1, isPartOf: { '@type': 'WebSite', name: 'DoAide Realty', url: ORIGIN } } }
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Rewrite the shared index.html head for one public page: title, description,
 * canonical, and the Open Graph / Twitter mirrors of each. Everything else in
 * the document (icons, JSON-LD, analytics, bundles) is left as built.
 */
export function injectMeta(html, meta) {
  const title = escapeHtml(meta.title)
  const description = escapeHtml(meta.description)
  const canonical = escapeHtml(meta.canonical)
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(
      /(<meta name="description" content=")[^"]*(")/,
      `$1${description}$2`,
    )
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${title}$2`)
    .replace(
      /(<meta property="og:description" content=")[^"]*(")/,
      `$1${description}$2`,
    )
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${canonical}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${title}$2`)
    .replace(
      /(<meta name="twitter:description" content=")[^"]*(")/,
      `$1${description}$2`,
    )
    .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, '')
    .replace(/<\/head>/, `  <link rel="canonical" href="${canonical}" />\n  </head>`)
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () =>
      meta.jsonLd
        ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, '\\u003c')}</script>`
        : '',
    )
    .replace('<div id="root"></div>', () => (meta.h1 ? `<div id="root"><h1>${escapeHtml(meta.h1)}</h1></div>` : '<div id="root"></div>'))
}
