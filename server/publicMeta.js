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
    title: 'EMI Calculator for Home Loans (INR) — DoAide Realty',
    description:
      'Free home loan EMI calculator for the Indian market. Monthly instalment, total interest and amortisation in INR.',
  },
  'stamp-duty-calculator': {
    title: 'Stamp Duty & Registration Calculator by State — DoAide Realty',
    description:
      'Estimate stamp duty and registration charges for property purchases across Indian states, free and login-free.',
  },
  'rental-yield-calculator': {
    title: 'Rental Yield Calculator — DoAide Realty',
    description:
      'Calculate gross and net rental yield for Indian properties. Compare returns before you buy or let.',
  },
  'property-comparison': {
    title: 'Property Comparison Tool — DoAide Realty',
    description:
      'Compare up to four Indian properties side by side on price per sq ft and gross rental yield, free and login-free.',
  },
  'area-converter': {
    title: 'Area Converter (sq ft, sq m, gaj, acre) — DoAide Realty',
    description:
      'Convert between square feet, square metres, gaj, acres, gunthas and other Indian land units instantly.',
  },
}

const BLOG = {
  'best-crm-for-real-estate-agents-india': {
    title: 'Best CRM for Real Estate Agents in India: 2026 Buyer’s Guide — DoAide Realty',
    description:
      'What Indian property agents should look for in a CRM — WhatsApp-first workflows, portal lead capture, follow-up automation — and how the options compare.',
  },
  'whatsapp-crm-transforming-indian-real-estate': {
    title: 'How WhatsApp CRM is Transforming Indian Real Estate — DoAide Realty',
    description:
      "How WhatsApp-first CRM helps property agents close deals faster in India's competitive market.",
  },
  '5-lead-management-strategies-property-agents': {
    title: '5 Lead Management Strategies for Property Agents — DoAide Realty',
    description:
      'From instant response to smart follow-ups, five strategies that separate top-performing agents from the rest.',
  },
  'complete-guide-real-estate-follow-up-automation': {
    title: 'The Complete Guide to Real Estate Follow-up Automation — DoAide Realty',
    description:
      'Build a follow-up system that converts leads on autopilot without losing the personal touch.',
  },
}

const STATIC_PAGES = {
  '/tools': {
    title: 'Free Real Estate Calculators — DoAide Realty',
    description:
      'Free, login-free tools for Indian real estate: EMI, stamp duty and rental yield calculators.',
  },
  '/blog': {
    title: 'Real Estate Growth Blog — DoAide Realty',
    description:
      'Guides on WhatsApp CRM, lead management and follow-up automation for Indian property agents.',
  },
  '/embed': {
    title: 'Embeddable Property Widgets — DoAide Realty',
    description:
      'Embed DoAide Realty calculators and lead-capture widgets on your own property website.',
  },
}

/** Meta for a public path, or null when the path has no bespoke head. */
export function publicPageMeta(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/'
  if (STATIC_PAGES[clean]) return { ...STATIC_PAGES[clean], canonical: ORIGIN + clean }
  if (clean.startsWith('/tools/')) {
    const tool = TOOLS[clean.slice('/tools/'.length)]
    return tool ? { ...tool, canonical: ORIGIN + clean } : null
  }
  if (clean.startsWith('/blog/')) {
    const post = BLOG[clean.slice('/blog/'.length)]
    return post ? { ...post, canonical: ORIGIN + clean } : null
  }
  return null
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
    .replace(/<\/head>/, `  <link rel="canonical" href="${canonical}" />\n  </head>`)
}
