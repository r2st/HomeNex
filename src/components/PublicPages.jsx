import { useState } from 'react'
import { PublicNav, PublicFooter } from './PublicLayout.jsx'
import EmiCalculator from './tools/EmiCalculator.jsx'
import StampDutyCalculator from './tools/StampDutyCalculator.jsx'
import RentalYieldCalculator from './tools/RentalYieldCalculator.jsx'
import ShareButtons from './ShareButtons.jsx'

const TOOLS = [
  { slug: 'emi-calculator', title: 'EMI Calculator', description: 'Home loan EMI calculator for Indian market (INR).', icon: '🏠' },
  { slug: 'stamp-duty-calculator', title: 'Stamp Duty Calculator', description: 'Estimate stamp duty and registration charges by Indian state.', icon: '📋' },
  { slug: 'rental-yield-calculator', title: 'Rental Yield Calculator', description: 'Calculate gross and net rental yield for properties.', icon: '💰' },
]

const BLOG_POSTS = [
  {
    slug: 'whatsapp-crm-transforming-indian-real-estate',
    title: 'How WhatsApp CRM is Transforming Indian Real Estate',
    date: '2026-09-15',
    readTime: '6 min read',
    excerpt: 'Discover how WhatsApp-first CRM is helping property agents close deals faster in India\'s competitive market.',
    content: `In India, WhatsApp is the default communication channel — over 500 million users rely on it daily. For real estate agents, this means one thing: your leads are already on WhatsApp. The question is whether you are meeting them there.

Traditional CRMs force agents into a workflow that doesn't match how Indian real estate works. Leads come in via WhatsApp, but agents have to manually log them into a separate system. Follow-ups happen on WhatsApp, but the CRM doesn't know about them. The result: leads fall through the cracks, follow-ups get missed, and deals die.

WhatsApp CRM changes this equation. Instead of forcing agents to switch between apps, it meets them where they already work. Every WhatsApp conversation is automatically logged, every lead is captured, and follow-ups are automated.

The impact is dramatic. Agents using WhatsApp CRM report 3x faster response times, which matters because real estate leads go cold within hours, not days. 40% more leads converted because automated follow-ups ensure no lead is forgotten. 2 hours saved per day by eliminating manual data entry and lead logging. 60% reduction in missed follow-ups through automated reminders.

The key insight is that Indian real estate is a relationship business built on trust and responsiveness. WhatsApp CRM doesn't replace the personal touch — it amplifies it by ensuring agents never miss a moment to connect.

DoAide Realty is built specifically for this workflow. It captures WhatsApp leads automatically, matches properties based on buyer requirements, and automates follow-ups — all without leaving WhatsApp. Try our free tools to see how technology can transform your real estate business.`,
  },
  {
    slug: '5-lead-management-strategies-property-agents',
    title: '5 Lead Management Strategies for Property Agents',
    date: '2026-09-22',
    readTime: '5 min read',
    excerpt: 'From instant response to smart follow-ups, these five strategies separate top-performing agents from the rest.',
    content: `In Indian real estate, the agent who responds first usually wins the deal. Here are five strategies that top-performing property agents use to manage their pipeline.

First, respond within 5 minutes. Research shows that leads contacted within 5 minutes are 21 times more likely to convert. In a market where buyers message multiple agents simultaneously, the first to respond wins. Set up auto-replies for after-hours inquiries to acknowledge leads instantly. Use our EMI Calculator as a value-add in your first response — it shows buyers what they can afford.

Second, segment your leads by intent. Not all leads are equal. A buyer who's visited three properties and asked about loan pre-approval is hotter than someone who just browsed a listing. Create clear pipeline stages: New, Interested, Site Visit Scheduled, Negotiating, and Closed. Focus your energy on the warmest leads. Use our Stamp Duty Calculator to help serious buyers understand total acquisition cost.

Third, automate your follow-up cadence. The average real estate deal in India takes 6-8 weeks from first contact to closing. That's a long time to maintain engagement manually. Set up automated follow-ups at Day 1, Day 3, Day 7, and then weekly. Each touchpoint should add value — share new listings that match their requirements, market updates, or useful tools like our Rental Yield Calculator.

Fourth, track your conversion metrics. What gets measured gets improved. Track lead source performance — which portals, which ads, which referral partners bring the best leads? Track response time, follow-up completion rate, and conversion rate at each pipeline stage. These metrics tell you where to invest your marketing budget and where your process needs improvement.

Fifth, leverage property matching. When a buyer tells you their budget, preferred locations, and property type, don't just search manually. Use a system that automatically matches new listings to existing buyer requirements and notifies both the agent and the buyer. This creates a virtuous cycle: buyers stay engaged because they're getting relevant options, and agents close deals faster because the matching is done for them.

DoAide Realty automates all five of these strategies — from instant WhatsApp response to AI-powered property matching.`,
  },
  {
    slug: 'complete-guide-real-estate-follow-up-automation',
    title: 'The Complete Guide to Real Estate Follow-up Automation',
    date: '2026-09-29',
    readTime: '7 min read',
    excerpt: 'Learn how to build a follow-up system that converts leads on autopilot without losing the personal touch.',
    content: `Follow-up is where deals are won or lost in real estate. Studies show that 80% of sales require at least five follow-ups, yet 44% of agents give up after just one. Automation bridges this gap.

The follow-up problem in Indian real estate is acute. Agents juggle dozens of active leads across multiple projects. Without a system, follow-ups depend on memory and sticky notes. The result: hot leads go cold because nobody called back.

Effective follow-up automation starts with timing. The first touchpoint should happen within minutes of initial contact — an acknowledgment that the inquiry was received and will be addressed. The second touchpoint comes within 24 hours — a personalized response with relevant property options. Then space follow-ups at 3 days, 7 days, 14 days, and monthly thereafter.

Content matters as much as timing. Each follow-up should add value, not just say "are you still interested?" Share new listings matching their criteria. Send market insights — price trends in their preferred area. Offer useful tools — EMI calculations based on their budget, stamp duty estimates for their target state. This positions you as a knowledgeable advisor, not just another salesperson.

Channel selection is critical in India. WhatsApp has 95%+ open rates compared to 20% for email and 15% for SMS. For high-value communications, WhatsApp is the clear winner. Reserve phone calls for warm leads who've shown strong intent — scheduled site visits or price negotiations.

Personalization at scale requires segmentation. Group leads by budget range, preferred location, property type (apartment vs villa vs plot), and timeline (immediate vs 3-6 months vs 1+ year). Each segment gets different follow-up content and frequency. A lead looking to buy immediately needs daily updates; someone planning for next year needs monthly market insights.

Automation doesn't mean robotic. The best systems let agents set the strategy while executing the details automatically. The agent decides which properties to recommend and what message to send; the system ensures it goes out on time and tracks the response. If a lead opens the message and checks a property link, the agent gets notified so they can jump in personally.

Measuring follow-up effectiveness requires tracking three metrics. Response rate tells you if your messages are relevant. Engagement rate (link clicks, property views) tells you if the content adds value. Conversion rate at each stage tells you where leads stall and where to improve.

DoAide Realty handles the complete follow-up lifecycle — from instant auto-response to scheduled touchpoints to engagement tracking — so agents can focus on building relationships rather than managing reminders.`,
  },
]

export function ToolsIndex() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-5xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Free Real Estate Tools</h1>
        <p className="text-[var(--doaide-text-secondary)] mb-10 max-w-2xl">Practical calculators for property agents and buyers in India — no sign-up required.</p>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((tool) => (
            <a key={tool.slug} href={`/tools/${tool.slug}`} className="block p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] hover:border-[var(--doaide-gold)] hover:shadow-[0_0_20px_rgba(240,180,41,0.15)] transition-all no-underline group">
              <div className="text-3xl mb-3">{tool.icon}</div>
              <h2 className="text-lg font-semibold text-[var(--doaide-text)] group-hover:text-[var(--doaide-gold)] transition-colors mb-2">{tool.title}</h2>
              <p className="text-sm text-[var(--doaide-text-secondary)]">{tool.description}</p>
            </a>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}

export function ToolPage({ slug }) {
  const Component = { 'emi-calculator': EmiCalculator, 'stamp-duty-calculator': StampDutyCalculator, 'rental-yield-calculator': RentalYieldCalculator }[slug]
  if (!Component) return <NotFound />
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16"><Component /></main>
      <PublicFooter />
    </div>
  )
}

export function BlogIndex() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Blog</h1>
        <p className="text-[var(--doaide-text-secondary)] mb-10">Insights on WhatsApp CRM, lead management, and real estate technology.</p>
        <div className="space-y-8">
          {BLOG_POSTS.map((post) => (
            <a key={post.slug} href={`/blog/${post.slug}`} className="block p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] hover:border-[var(--doaide-gold)] transition-colors no-underline group">
              <div className="flex items-center gap-3 mb-2 text-xs text-[var(--doaide-text-muted)]">
                <time>{post.date}</time><span>·</span><span>{post.readTime}</span>
              </div>
              <h2 className="text-lg font-semibold text-[var(--doaide-text)] group-hover:text-[var(--doaide-gold)] transition-colors mb-2">{post.title}</h2>
              <p className="text-sm text-[var(--doaide-text-secondary)]">{post.excerpt}</p>
            </a>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}

export function BlogPost({ slug }) {
  const post = BLOG_POSTS.find((p) => p.slug === slug)
  if (!post) return <NotFound />
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <a href="/blog" className="text-sm text-[var(--doaide-text-muted)] hover:text-[var(--doaide-gold)] no-underline mb-6 inline-block">← Back to Blog</a>
        <article>
          <div className="flex items-center gap-3 mb-3 text-xs text-[var(--doaide-text-muted)]">
            <time>{post.date}</time><span>·</span><span>{post.readTime}</span>
          </div>
          <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-8" style={{ fontFamily: 'var(--doaide-font-display)' }}>{post.title}</h1>
          <div className="space-y-4 text-[var(--doaide-text-secondary)] leading-relaxed">
            {post.content.split('\n\n').map((block, i) => <p key={i}>{block}</p>)}
          </div>
          <hr className="my-8 border-[var(--doaide-border)]" />
          <ShareButtons url={`https://realty.doaide.com/blog/${slug}`} title={`${post.title} — DoAide Realty`} />
        </article>
      </main>
      <PublicFooter />
    </div>
  )
}

export function EmbedPage() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16"><EmbedGeneratorWidget /></main>
      <PublicFooter />
    </div>
  )
}

function EmbedGeneratorWidget() {
  const [position, setPosition] = useState('bottom-right')
  const [theme, setTheme] = useState('dark')
  const [brandColor, setBrandColor] = useState('#F0B429')
  const [copied, setCopied] = useState(false)

  const snippet = `<script\n  src="https://realty.doaide.com/widget.js"\n  data-position="${position}"\n  data-theme="${theme}"\n  data-color="${brandColor}"\n  async\n><\/script>`

  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Embed Widget Generator</h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">Add DoAide Realty lead capture to your property website.</p>
      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Position</label>
            <div className="flex gap-2">
              {['bottom-right', 'bottom-left'].map((p) => (
                <button key={p} onClick={() => setPosition(p)} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${position === p ? 'bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)]' : 'bg-[var(--doaide-bg)] text-[var(--doaide-text-secondary)] border border-[var(--doaide-border)]'}`}>{p.replace('-', ' ')}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Theme</label>
            <div className="flex gap-2">
              {['dark', 'light', 'auto'].map((t) => (
                <button key={t} onClick={() => setTheme(t)} className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${theme === t ? 'bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)]' : 'bg-[var(--doaide-bg)] text-[var(--doaide-text-secondary)] border border-[var(--doaide-border)]'}`}>{t}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)]">Embed Code</h2>
            <button onClick={copy} className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)]">{copied ? 'Copied!' : 'Copy Code'}</button>
          </div>
          <pre className="p-4 rounded-lg bg-[var(--doaide-bg)] text-sm text-[var(--doaide-text-secondary)] overflow-x-auto font-mono whitespace-pre-wrap">{snippet}</pre>
        </div>
        <ShareButtons url="https://realty.doaide.com/embed" title="DoAide Realty Embed Widget Generator" />
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-4">Page Not Found</h1>
        <p className="text-[var(--doaide-text-secondary)] mb-8">The page you're looking for doesn't exist.</p>
        <a href="/" className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] no-underline">Go Home</a>
      </main>
      <PublicFooter />
    </div>
  )
}

export function resolvePublicRoute(pathname) {
  if (pathname === '/tools') return 'tools-index'
  if (pathname.startsWith('/tools/')) return 'tool-page'
  if (pathname === '/blog') return 'blog-index'
  if (pathname.startsWith('/blog/')) return 'blog-post'
  if (pathname === '/embed') return 'embed'
  return null
}

export { TOOLS, BLOG_POSTS }
